import { shell, type Session } from 'electron'
import type { Browser } from './browser'
import type { BrowserWindowController } from './window'
import { DelugeClient, endpointFor, magnetName, type AddResult } from './deluge'
import { getSettings } from './settings'

/**
 * Built-in "siphon": clicking a magnet link or a .torrent download sends it to your Deluge server
 * (Settings → Magnet Torrent) instead of opening a torrent app, and a toast says how it went. Links can
 * also be sent from the right-click menu.
 */

const MAX_TORRENT_FILE = 20 * 1024 * 1024

export const isMagnet = (url: string) => /^magnet:\?/i.test(url)

/** A link that looks like a .torrent file (by its path). */
export function isTorrentURL(url: string): boolean {
  try {
    const u = new URL(url)
    return /^https?:$/.test(u.protocol) && /\.torrent$/i.test(decodeURIComponent(u.pathname))
  } catch {
    return false
  }
}

export class TorrentSender {
  readonly deluge = new DelugeClient()
  /** Opens Settings at the Magnet Torrent section (set by menu.ts). */
  openSetup: ((w: BrowserWindowController) => void) | null = null
  /** "Not now" on the set-up question: don't ask again until restart. */
  private declinedSetup = false
  /** Links sent in the last few seconds, so a double-click (or a page firing twice) sends once. */
  private recent = new Map<string, number>()
  /** A "Send to Deluge?" question is on screen; others are dropped so a page can't pile them up. */
  private confirming = false

  constructor(private readonly browser: Browser) {}

  /** Turned on and pointed at a server. */
  get active(): boolean {
    const t = getSettings().torrents
    return t.enabled && !!endpointFor(t.url)
  }

  /** Intercepts .torrent downloads in this session. */
  attach(ses: Session): void {
    ses.on('will-download', (event, item, wc) => {
      if (!this.active) return
      const name = item.getFilename()
      if (item.getMimeType() !== 'application/x-bittorrent' && !/\.torrent$/i.test(name)) return
      event.preventDefault()
      const w = (wc && (this.browser.findTabByWebContents(wc)?.window ?? this.browser.fromWebContents(wc))) || this.browser.lastFocused
      const url = item.getURL()
      // A download you didn't click (started by a script or a hidden frame) is asked about first.
      if (item.hasUserGesture()) void this.sendTorrentFile(url, name, ses, w ?? undefined)
      else void this.confirm(name.replace(/\.torrent$/i, ''), w ?? undefined, () => this.sendTorrentFile(url, name, ses, w ?? undefined))
    })
  }

  /**
   * A page asked to open a link in another app. Returns true when it was a magnet link and has been
   * dealt with (sent, or the user was asked to set up Deluge). A magnet link you clicked is sent right
   * away; one a page opened by itself (a script, an ad, a hidden frame) is asked about first.
   */
  handleExternal(url: string, w: BrowserWindowController | undefined, clicked: boolean): boolean {
    if (!isMagnet(url)) return false
    if (this.active) {
      if (clicked) void this.sendMagnet(url, w)
      else void this.confirm(magnetName(url), w, () => this.sendMagnet(url, w))
      return true
    }
    if (!w || this.declinedSetup) return false
    void w.popup
      .prompt({
        kind: 'info',
        title: 'Set up Magnet Torrent?',
        message: 'Zirtola can send magnet and .torrent links straight to your Deluge server (for example a Docker container on Unraid).',
        buttons: ['Set up', 'Open in torrent app', 'Not now'],
        defaultId: 0,
        cancelId: 2,
      })
      .then((choice) => {
        if (choice === 0) this.openSetup?.(w)
        else if (choice === 1) void shell.openExternal(url)
        else this.declinedSetup = true
      })
    return true
  }

  async sendMagnet(uri: string, w?: BrowserWindowController): Promise<void> {
    if (this.isRepeat(uri)) return
    await this.report(w, magnetName(uri), () => this.deluge.addMagnet(uri))
  }

  /** Fetches a .torrent with the page's cookies (private trackers need them) and sends it. */
  async sendTorrentFile(url: string, filename: string, ses: Session, w?: BrowserWindowController): Promise<void> {
    if (this.isRepeat(url)) return
    await this.report(w, filename.replace(/\.torrent$/i, ''), async () => {
      const res = await ses.fetch(url, { signal: AbortSignal.timeout(30_000) })
      if (!res.ok) throw new Error(`Couldn't download the .torrent file (${res.status}).`)
      const data = Buffer.from(await res.arrayBuffer())
      if (data.length > MAX_TORRENT_FILE) throw new Error('That file is too big to be a .torrent.')
      // Torrent files are bencoded dictionaries: they start with "d" and hold an "info" key.
      if (data[0] !== 0x64 || !data.includes('4:info')) throw new Error('That link isn\'t a .torrent file (the site may need you to sign in).')
      const name = /\.torrent$/i.test(filename) ? filename : `${filename || 'download'}.torrent`
      return this.deluge.addTorrentFile(name, data)
    })
  }

  /** Right-click → "Send to Deluge". */
  sendLink(url: string, ses: Session, w?: BrowserWindowController): void {
    if (!getSettings().torrents.url.trim()) {
      if (w) this.openSetup?.(w)
      return
    }
    if (isMagnet(url)) void this.sendMagnet(url, w)
    else void this.sendTorrentFile(url, decodeURIComponent(new URL(url).pathname.split('/').pop() ?? ''), ses, w)
  }

  private async confirm(name: string, w: BrowserWindowController | undefined, send: () => Promise<void>): Promise<void> {
    const target = w ?? this.browser.lastFocused
    if (!target || this.confirming) return
    this.confirming = true
    try {
      const choice = await target.popup.prompt({
        kind: 'info',
        title: 'Send to Deluge?',
        message: `This page wants to send "${name}" to your Deluge server.`,
        buttons: ['Send', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
      })
      if (choice === 0) await send()
    } finally {
      this.confirming = false
    }
  }

  private isRepeat(key: string): boolean {
    const now = Date.now()
    for (const [k, t] of this.recent) if (now - t > 3000) this.recent.delete(k)
    if (this.recent.has(key)) return true
    this.recent.set(key, now)
    return false
  }

  private async report(w: BrowserWindowController | undefined, name: string, add: () => Promise<AddResult>): Promise<void> {
    const target = w ?? this.browser.lastFocused ?? undefined
    target?.toast({ kind: 'busy', text: `Sending to Deluge: ${name}` })
    try {
      const result = await add()
      const text = result.duplicate
        ? `Already in Deluge: ${result.name}`
        : `Sent to Deluge: ${result.name}${result.labelNote ? ` (${result.labelNote})` : ''}`
      target?.toast({ kind: 'ok', text })
    } catch (err) {
      target?.toast({ kind: 'error', text: err instanceof Error ? err.message : String(err), action: 'torrent-settings' })
    }
  }
}
