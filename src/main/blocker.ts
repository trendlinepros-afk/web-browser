import { app, ipcMain, net, utilityProcess, type Session, type WebContents } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { ElectronBlocker, fromElectronDetails } from '@ghostery/adblocker-electron'
import { getDomain } from 'tldts-experimental'
import { getSettings, updateSettings } from './settings'
import { filterListUrls, RESOURCES_URL } from './filter-lists'

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000
const PRELOAD_PATH = require.resolve('@ghostery/adblocker-electron-preload')

interface CacheMeta {
  updatedAt: number
  cookieBanners: boolean
}

/**
 * Network-level ad, tracker and malware blocking plus cosmetic filtering (hiding ad slots and
 * cookie banners), using uBlock Origin / EasyList filter lists via Ghostery's engine.
 *
 * Unlike Chrome extensions under Manifest V3, this runs inside the browser itself, so it has no
 * rule-count limits and sees every request.
 */
export class AdBlocker {
  private engine: ElectronBlocker | null = null
  private meta: CacheMeta | null = null
  private refreshing: Promise<void> | null = null
  private timer: NodeJS.Timeout | null = null

  /** Called with a tab's WebContents each time a request is blocked in it. */
  onBlocked: ((wc: WebContents) => void) | null = null

  get ready(): boolean {
    return this.engine !== null
  }

  get lastUpdated(): number | null {
    return this.meta?.updatedAt ?? null
  }

  private dir(): string {
    return path.join(app.getPath('userData'), 'adblock')
  }

  /** Loads the cached engine (fast), then refreshes lists in the background when stale. */
  async start(): Promise<void> {
    this.registerCosmeticIpc()
    this.loadCached()
    const settings = getSettings().blocking
    const stale = !this.meta || Date.now() - this.meta.updatedAt > REFRESH_INTERVAL_MS
    const wrongLists = this.meta && this.meta.cookieBanners !== settings.cookieBanners
    if (stale || wrongLists) this.refresh().catch((err) => console.warn('Filter list update failed:', err))
    this.timer = setInterval(() => this.refresh().catch(() => {}), REFRESH_INTERVAL_MS)
    this.timer.unref()
  }

  private loadCached(): void {
    const candidates = [
      path.join(this.dir(), 'engine.bin'),
      // Snapshot bundled at release time so blocking works on first launch, offline included.
      path.join(__dirname, '..', 'filters', 'engine.bin'),
    ]
    for (const file of candidates) {
      try {
        const engine = ElectronBlocker.deserialize(new Uint8Array(fs.readFileSync(file)))
        const metaFile = file.replace(/engine\.bin$/, 'meta.json')
        this.meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as CacheMeta
        this.engine = engine
        return
      } catch {
        // Missing, or serialized by a different library version: try the next one.
      }
    }
  }

  /** Downloads the latest lists and rebuilds the engine off the main process. */
  refresh(): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = null
      })
    }
    return this.refreshing
  }

  private async doRefresh(): Promise<void> {
    const cookieBanners = getSettings().blocking.cookieBanners
    const urls = filterListUrls(cookieBanners)
    const download = async (url: string) => {
      const res = await net.fetch(url)
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
      return res.text()
    }
    const [lists, resources] = await Promise.all([Promise.all(urls.map(download)), download(RESOURCES_URL).catch(() => null)])
    const serialized = await buildEngine(lists, resources)

    this.engine = ElectronBlocker.deserialize(serialized)
    this.meta = { updatedAt: Date.now(), cookieBanners }
    fs.mkdirSync(this.dir(), { recursive: true })
    fs.writeFileSync(path.join(this.dir(), 'engine.bin'), serialized)
    fs.writeFileSync(path.join(this.dir(), 'meta.json'), JSON.stringify(this.meta))
  }

  // ---- Per-site control ---------------------------------------------------

  static siteOf(url: string): string | null {
    try {
      const { hostname, protocol } = new URL(url)
      if (protocol !== 'http:' && protocol !== 'https:') return null
      return getDomain(hostname) ?? hostname
    } catch {
      return null
    }
  }

  /** Whether blocking applies to pages on this top-level URL. */
  activeFor(pageUrl: string): boolean {
    const settings = getSettings().blocking
    if (!settings.enabled || !this.engine) return false
    const site = AdBlocker.siteOf(pageUrl)
    return site !== null && !settings.allowlist.includes(site)
  }

  setSiteAllowed(pageUrl: string, allowed: boolean): void {
    const site = AdBlocker.siteOf(pageUrl)
    if (!site) return
    updateSettings((s) => {
      const list = new Set(s.blocking.allowlist)
      if (allowed) list.add(site)
      else list.delete(site)
      s.blocking.allowlist = [...list].sort()
    })
  }

  // ---- Request hooks (called from network.ts) ------------------------------

  onBeforeRequest(details: Electron.OnBeforeRequestListenerDetails): Electron.CallbackResponse {
    const engine = this.engine
    const wc = details.webContents
    // Top-level navigations are never blocked, and requests made by extensions (e.g. LastPass
    // talking to its servers) or without a page (service workers) are left alone.
    if (!engine || !wc || details.resourceType === 'mainFrame') return {}
    if (details.url.startsWith('chrome-extension:') || !this.activeFor(wc.getURL())) return {}

    const request = fromElectronDetails(details)
    if (request.type === 'other') request.guessTypeOfRequest()
    const { redirect, match } = engine.match(request)
    if (!redirect && !match) return {}
    this.onBlocked?.(wc)
    return redirect ? { redirectURL: redirect.dataUrl } : { cancel: true }
  }

  /** Adds CSP directives some filters use to neutralise inline trackers. */
  onHeadersReceived(details: Electron.OnHeadersReceivedListenerDetails): Electron.HeadersReceivedResponse {
    const engine = this.engine
    if (!engine || (details.resourceType !== 'mainFrame' && details.resourceType !== 'subFrame')) return {}
    const pageUrl = details.resourceType === 'mainFrame' ? details.url : (details.webContents?.getURL() ?? details.url)
    if (!this.activeFor(pageUrl)) return {}
    const csp = engine.getCSPDirectives(fromElectronDetails(details))
    if (!csp) return {}
    const headers = { ...(details.responseHeaders ?? {}) }
    const policies = csp.split(';').map((p) => p.trim())
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === 'content-security-policy') {
        policies.push(...headers[name])
        delete headers[name]
      }
    }
    headers['content-security-policy'] = [policies.join(';')]
    return { responseHeaders: headers }
  }

  /** Cosmetic filtering: the page preload asks for CSS/scriptlets for each frame. */
  enableInSession(ses: Session): void {
    ses.registerPreloadScript({ id: 'adblock-cosmetics', type: 'frame', filePath: PRELOAD_PATH })
  }

  private registerCosmeticIpc(): void {
    ipcMain.handle('@ghostery/adblocker/is-mutation-observer-enabled', () => this.engine?.config.enableMutationObserver ?? false)
    ipcMain.handle(
      '@ghostery/adblocker/inject-cosmetic-filters',
      async (event, url: string, msg?: Parameters<ElectronBlocker['onInjectCosmeticFilters']>[2]) => {
        if (!this.engine || !this.activeFor(event.sender.getURL())) return
        await this.engine.onInjectCosmeticFilters(event, url, msg)
      },
    )
  }
}

function buildEngine(lists: string[], resources: string | null): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(path.join(__dirname, 'filter-worker.js'), [], { serviceName: 'Filter list builder' })
    child.once('message', (data: Uint8Array) => resolve(new Uint8Array(data)))
    child.once('exit', (code) => reject(new Error(`Filter builder exited (${code})`)))
    child.postMessage({ lists, resources })
  })
}
