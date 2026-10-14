import { app, BrowserWindow, type Session, type ServiceWorkerMain, type WebContents } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Main-process backing for chrome.* APIs that Electron exposes to extensions but doesn't
 * implement (see preload/extension-sw-preload.ts), plus a diagnostics log of what extensions
 * report, so problems with real extensions (LastPass) can be diagnosed on the user's machine.
 */

interface Alarm {
  name: string
  scheduledTime: number
  periodInMinutes?: number
}

/** Chrome's minimum alarm delay/period for installed extensions. */
const MIN_ALARM_MS = 30_000

// ---- Diagnostics ---------------------------------------------------------------

const LOG_LIMIT = 600
const log: string[] = []

export function diag(line: string): void {
  log.push(`${new Date().toISOString().slice(11, 23)} ${line}`)
  if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT)
}

export function diagnosticsText(ses: Session): string {
  const extensions = ses.extensions.getAllExtensions()
  const header = [
    `Zirtola ${app.getVersion()} · Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · ${process.platform} ${process.arch}`,
    `Extensions: ${extensions.map((e) => `${e.name} ${e.version} (${e.id}) mv${e.manifest.manifest_version}`).join('; ') || 'none'}`,
    ...extensions.map((e) => `  ${e.name} permissions: ${JSON.stringify(e.manifest.permissions ?? [])}`),
    '',
  ]
  return [...header, ...log].join('\n')
}

// ---- Wiring --------------------------------------------------------------------

export class ExtensionApis {
  private alarms = new Map<string, Map<string, Alarm>>()
  private timer: NodeJS.Timeout | null = null
  private wired = new WeakSet<ServiceWorkerMain>()

  constructor(private readonly ses: Session) {
    this.loadAlarms()
    ses.serviceWorkers.on('running-status-changed', ({ runningStatus, versionId }) => {
      const worker = ses.serviceWorkers.getWorkerFromVersionID(versionId)
      if (!worker?.scope.startsWith('chrome-extension://')) return
      diag(`worker ${shortScope(worker.scope)} ${runningStatus}`)
      if (runningStatus === 'starting') this.wire(worker)
    })
    ses.serviceWorkers.on('console-message', (_e, d) => {
      const scope = ses.serviceWorkers.getWorkerFromVersionID(d.versionId)?.scope ?? ''
      if (!scope.startsWith('chrome-extension://')) return
      diag(`[${shortScope(scope)} worker ${levelName(d.level)}] ${d.message}${d.sourceUrl ? ` (${d.sourceUrl.split('/').pop()}:${d.lineNumber})` : ''}`)
    })
    ses.extensions.on('extension-loaded', (_e, ext) => diag(`loaded ${ext.name} ${ext.version}`))
    ses.extensions.on('extension-unloaded', (_e, ext) => diag(`unloaded ${ext.name}`))
    app.on('web-contents-created', (_e, wc) => {
      if (wc.session !== ses) return
      wc.on('did-start-navigation', (d) => {
        if (d.isMainFrame && d.url.startsWith('chrome-extension://')) this.watchExtensionPage(wc)
      })
    })
    this.schedule()
  }

  /** Popups, offscreen documents and option pages: record their console and failures. */
  private watchedPages = new WeakSet<WebContents>()
  private watchExtensionPage(wc: WebContents): void {
    if (this.watchedPages.has(wc)) return
    this.watchedPages.add(wc)
    const label = () => shortScope(wc.getURL())
    wc.on('console-message', (e) => {
      const d = e as unknown as { level: string | number; message: string; lineNumber: number; sourceId: string }
      diag(`[${label()} ${levelName(d.level)}] ${d.message}${d.sourceId ? ` (${String(d.sourceId).split('/').pop()}:${d.lineNumber})` : ''}`)
    })
    wc.on('did-fail-load', (_e, code, desc, url) => diag(`[${label()}] failed to load ${url}: ${desc} (${code})`))
    wc.on('render-process-gone', (_e, d) => diag(`[${label()}] renderer gone: ${d.reason}`))
    wc.on('did-finish-load', () => diag(`[${label()}] loaded`))
  }

  private wire(worker: ServiceWorkerMain): void {
    if (this.wired.has(worker)) return
    this.wired.add(worker)
    const extensionId = new URL(worker.scope).host
    worker.ipc.handle('zirtola-ext', async (_e, api: string, op: string, ...args: unknown[]) => {
      try {
        if (api === 'alarms') return this.alarmOp(extensionId, op, args)
        if (api === 'identity' && op === 'launchWebAuthFlow') return await this.launchWebAuthFlow(extensionId, args[0] as { url: string; interactive?: boolean })
      } catch (err) {
        diag(`[${extensionId.slice(0, 6)}] ${api}.${op} failed: ${err instanceof Error ? err.message : String(err)}`)
        throw err
      }
      return undefined
    })
  }

  // ---- chrome.alarms ----------------------------------------------------------

  private file(): string {
    return path.join(app.getPath('userData'), 'extension-alarms.json')
  }

  private loadAlarms(): void {
    try {
      const data = JSON.parse(fs.readFileSync(this.file(), 'utf8')) as Record<string, Alarm[]>
      for (const [id, list] of Object.entries(data)) this.alarms.set(id, new Map(list.map((a) => [a.name, a])))
    } catch {
      // None yet.
    }
  }

  private saveAlarms(): void {
    const data: Record<string, Alarm[]> = {}
    for (const [id, map] of this.alarms) if (map.size) data[id] = [...map.values()]
    try {
      fs.writeFileSync(this.file(), JSON.stringify(data))
    } catch {
      // Best effort.
    }
  }

  private alarmOp(extensionId: string, op: string, args: unknown[]): unknown {
    const map = this.alarms.get(extensionId) ?? new Map<string, Alarm>()
    this.alarms.set(extensionId, map)
    switch (op) {
      case 'create': {
        const name = String(args[0] ?? '')
        const info = (args[1] ?? {}) as { when?: number; delayInMinutes?: number; periodInMinutes?: number }
        const period = info.periodInMinutes ? Math.max(info.periodInMinutes * 60_000, MIN_ALARM_MS) : undefined
        let when = info.when ?? Date.now() + (info.delayInMinutes !== undefined ? Math.max(info.delayInMinutes * 60_000, MIN_ALARM_MS) : (period ?? MIN_ALARM_MS))
        when = Math.max(when, Date.now())
        map.set(name, { name, scheduledTime: when, ...(period ? { periodInMinutes: period / 60_000 } : {}) })
        this.saveAlarms()
        this.schedule()
        return undefined
      }
      case 'get':
        return map.get(String(args[0] ?? '')) ?? undefined
      case 'getAll':
        return [...map.values()]
      case 'clear': {
        const had = map.delete(String(args[0] ?? ''))
        this.saveAlarms()
        this.schedule()
        return had
      }
      case 'clearAll': {
        const had = map.size > 0
        map.clear()
        this.saveAlarms()
        this.schedule()
        return had
      }
    }
    return undefined
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    let next = Infinity
    for (const map of this.alarms.values()) for (const a of map.values()) next = Math.min(next, a.scheduledTime)
    if (next === Infinity) return
    // setTimeout can't wait longer than ~24.8 days; re-check at least hourly.
    this.timer = setTimeout(() => void this.fireDue(), Math.min(Math.max(0, next - Date.now()), 3_600_000))
    this.timer.unref()
  }

  private async fireDue(): Promise<void> {
    const now = Date.now()
    const due: [string, Alarm][] = []
    for (const [id, map] of this.alarms) {
      for (const a of [...map.values()]) {
        if (a.scheduledTime > now) continue
        due.push([id, { ...a }])
        if (a.periodInMinutes) {
          const period = a.periodInMinutes * 60_000
          a.scheduledTime += Math.ceil((now - a.scheduledTime + 1) / period) * period
        } else {
          map.delete(a.name)
        }
      }
    }
    this.saveAlarms()
    this.schedule()
    for (const [id, alarm] of due) {
      diag(`[${id.slice(0, 6)}] alarm "${alarm.name}" due`)
      void this.deliver(id, alarm, 1)
    }
  }

  /** Wakes the extension's background worker if Chrome put it to sleep, then delivers the alarm. */
  private async deliver(id: string, alarm: Alarm, attempt: number): Promise<void> {
    try {
      const worker = await this.ses.serviceWorkers.startWorkerForScope(`chrome-extension://${id}/`)
      this.wire(worker)
      worker.send('zirtola-alarm', alarm)
      diag(`[${id.slice(0, 6)}] alarm "${alarm.name}" delivered`)
    } catch (err) {
      diag(`[${id.slice(0, 6)}] couldn't deliver alarm "${alarm.name}" (try ${attempt}): ${err instanceof Error ? err.message : String(err)}`)
      // Alarms that came due while Zirtola was starting arrive before the extension has loaded.
      if (attempt < 6) setTimeout(() => void this.deliver(id, alarm, attempt + 1), 5_000).unref()
    }
  }

  // ---- chrome.omnibox ----------------------------------------------------------

  /** The extension whose address-bar keyword starts this input ("lp facebook" → LastPass), if any. */
  omniboxTarget(input: string): { extensionId: string; text: string } | null {
    const m = /^(\S+)\s+(.+)$/.exec(input.trim())
    if (!m) return null
    for (const ext of this.ses.extensions.getAllExtensions()) {
      const keyword = (ext.manifest as { omnibox?: { keyword?: string } }).omnibox?.keyword
      if (keyword && keyword.toLowerCase() === m[1].toLowerCase()) return { extensionId: ext.id, text: m[2] }
    }
    return null
  }

  /** Delivers "<keyword> <text>" + Enter from the address bar, like Chrome's omnibox. */
  async omniboxEnter(extensionId: string, text: string): Promise<void> {
    try {
      const worker = await this.ses.serviceWorkers.startWorkerForScope(`chrome-extension://${extensionId}/`)
      this.wire(worker)
      worker.send('zirtola-omnibox', 'onInputStarted', [])
      worker.send('zirtola-omnibox', 'onInputEntered', [text, 'currentTab'])
      diag(`[${extensionId.slice(0, 6)}] omnibox "${text}"`)
    } catch (err) {
      diag(`[${extensionId.slice(0, 6)}] omnibox failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ---- chrome.identity ----------------------------------------------------------

  /** Opens the sign-in page in a window; resolves with the final URL once it redirects to the extension. */
  private launchWebAuthFlow(extensionId: string, details: { url: string; interactive?: boolean }): Promise<string> {
    const redirectPrefix = `https://${extensionId}.chromiumapp.org/`
    return new Promise((resolve, reject) => {
      const win = new BrowserWindow({
        width: 520,
        height: 720,
        show: details.interactive !== false,
        autoHideMenuBar: true,
        title: 'Sign in',
        webPreferences: { session: this.ses, sandbox: true, contextIsolation: true, nodeIntegration: false },
      })
      let done = false
      const finish = (url: string | null, error?: string) => {
        if (done) return
        done = true
        if (!win.isDestroyed()) win.close()
        if (url) resolve(url)
        else reject(new Error(error ?? 'The user did not approve access.'))
      }
      const check = (url: string) => {
        if (url.startsWith(redirectPrefix)) finish(url)
      }
      win.webContents.on('will-redirect', (e, url) => {
        if (url.startsWith(redirectPrefix)) {
          e.preventDefault()
          finish(url)
        }
      })
      win.webContents.on('will-navigate', (e, url) => {
        if (url.startsWith(redirectPrefix)) {
          e.preventDefault()
          finish(url)
        }
      })
      win.webContents.on('did-navigate', (_e, url) => check(url))
      win.on('closed', () => finish(null))
      win.loadURL(details.url).catch((err) => finish(null, String(err)))
    })
  }
}

function shortScope(url: string): string {
  try {
    const u = new URL(url)
    return u.protocol === 'chrome-extension:' ? `${u.host.slice(0, 6)}…${u.pathname}` : url
  } catch {
    return url
  }
}

function levelName(level: string | number): string {
  if (typeof level === 'string') return level
  return ['verbose', 'info', 'warning', 'error'][level] ?? String(level)
}
