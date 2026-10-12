import { WebContentsView, type NavigationEntry, type Session, type WebContents } from 'electron'
import type { TabInfo } from '../shared/types'
import type { BrowserWindowController } from './window'
import { attachContextMenu } from './context-menu'

let nextTabId = 1

export interface SavedTab {
  url: string
  title: string
  favicon: string | null
  pinned: boolean
  history?: { entries: NavigationEntry[]; index: number }
}

export interface TabOptions {
  url?: string
  /** Start the tab asleep, holding this state until it is first activated. */
  sleeping?: SavedTab
  /** Adopt a WebContents Chromium already created (window.open / target=_blank), keeping window.opener. */
  webContentsOptions?: Electron.WebContentsViewConstructorOptions
}

const MAX_SAVED_HISTORY = 50

/**
 * A browser tab. The tab id is stable for the tab's lifetime, while the underlying
 * WebContents is destroyed when the tab sleeps and recreated when it wakes.
 */
export class Tab {
  readonly id = nextTabId++
  view: WebContentsView | null = null

  title = 'New Tab'
  url = ''
  favicon: string | null = null
  pinned = false
  muted = false
  crashed = false
  htmlFullscreen = false
  /** When this tab last became hidden (or Date.now() while active). Drives the tab sleeper. */
  lastActiveAt = Date.now()
  /** Last time Claude (MCP) interacted with this tab. */
  lastControlledAt = 0
  /** Ads/trackers blocked since the current page started loading. */
  blockedCount = 0

  private savedHistory: { entries: NavigationEntry[]; index: number } | null = null

  constructor(
    readonly window: BrowserWindowController,
    readonly session: Session,
    opts: TabOptions = {},
  ) {
    if (opts.sleeping) {
      const s = opts.sleeping
      this.url = s.url
      this.title = s.title || s.url
      this.favicon = s.favicon
      this.pinned = s.pinned
      this.savedHistory = s.history ?? null
      return
    }
    this.createView(opts.webContentsOptions)
    if (opts.url) this.loadURL(opts.url)
  }

  get webContents(): WebContents | null {
    return this.view && !this.view.webContents.isDestroyed() ? this.view.webContents : null
  }

  get sleeping(): boolean {
    return this.view === null
  }

  get controlled(): boolean {
    return Date.now() - this.lastControlledAt < 120_000
  }

  get incognito(): boolean {
    return this.window.incognito
  }

  loadURL(url: string): void {
    this.url = url
    const wc = this.wake()
    wc.loadURL(url).catch(() => {
      // Navigation errors (aborted, DNS failure…) are shown by Chromium's own error page.
    })
  }

  /** Ensures the tab has a live WebContents, restoring it from sleep if needed. */
  wake(): WebContents {
    if (this.webContents) return this.webContents
    this.view = null
    const wc = this.createView()
    const history = this.savedHistory
    this.savedHistory = null
    if (history && history.entries.length > 0) {
      wc.navigationHistory.restore({ entries: history.entries, index: history.index }).catch(() => {
        if (this.url) wc.loadURL(this.url).catch(() => {})
      })
    } else if (this.url) {
      wc.loadURL(this.url).catch(() => {})
    }
    this.window.onTabWoke(this)
    return wc
  }

  /**
   * Puts the tab to sleep: destroys its renderer process but keeps url, title, favicon
   * and back/forward history so it can be restored transparently.
   */
  discard(): boolean {
    const wc = this.webContents
    if (!wc) return false
    this.savedHistory = this.captureHistory(wc)
    const view = this.view!
    this.view = null
    this.window.detachTabView(view)
    wc.close({ waitForBeforeUnload: false })
    this.window.onTabStateChanged(this)
    return true
  }

  canDiscard(opts: { sleepPinned: boolean }): boolean {
    const wc = this.webContents
    if (!wc) return false
    if (this.window.activeTab === this) return false
    if (this.pinned && !opts.sleepPinned) return false
    if (this.controlled) return false
    if (wc.isCurrentlyAudible()) return false
    if (wc.isBeingCaptured()) return false
    if (wc.isDevToolsOpened()) return false
    if (this.htmlFullscreen) return false
    return true
  }

  toSaved(): SavedTab {
    const wc = this.webContents
    return {
      url: this.url,
      title: this.title,
      favicon: this.favicon,
      pinned: this.pinned,
      history: wc ? this.captureHistory(wc) : (this.savedHistory ?? undefined),
    }
  }

  info(): TabInfo {
    const wc = this.webContents
    return {
      id: this.id,
      title: this.title,
      url: this.url,
      favicon: this.favicon,
      loading: wc ? wc.isLoading() : false,
      sleeping: !wc,
      audible: wc ? wc.isCurrentlyAudible() : false,
      muted: this.muted,
      pinned: this.pinned,
      canGoBack: wc ? wc.navigationHistory.canGoBack() : (this.savedHistory?.index ?? 0) > 0,
      canGoForward: wc
        ? wc.navigationHistory.canGoForward()
        : !!this.savedHistory && this.savedHistory.index < this.savedHistory.entries.length - 1,
      controlled: this.controlled,
      blocked: this.blockedCount,
      blockingActive: !!this.url && this.window.browser.blocker.activeFor(this.url),
      bookmarked: this.window.browser.bookmarks.isBookmarked(this.url),
    }
  }

  destroy(): void {
    const wc = this.webContents
    if (this.view) this.window.detachTabView(this.view)
    this.view = null
    if (wc) wc.close({ waitForBeforeUnload: false })
  }

  private captureHistory(wc: WebContents): { entries: NavigationEntry[]; index: number } {
    const entries = wc.navigationHistory.getAllEntries()
    let index = wc.navigationHistory.getActiveIndex()
    // Keep the most recent entries around the active one.
    if (entries.length > MAX_SAVED_HISTORY) {
      const start = Math.max(0, Math.min(index - MAX_SAVED_HISTORY + 10, entries.length - MAX_SAVED_HISTORY))
      index -= start
      return { entries: entries.slice(start, start + MAX_SAVED_HISTORY), index }
    }
    return { entries, index }
  }

  private createView(adopt?: Electron.WebContentsViewConstructorOptions): WebContents {
    const view = adopt
      ? new WebContentsView(adopt)
      : new WebContentsView({
          webPreferences: {
            session: this.session,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: true,
            spellcheck: true,
            scrollBounce: true,
            // Run the page preload (bot-check fixes, GPC) in iframes too. With the sandbox on,
            // this does not give frames any Node.js access despite the option's name.
            nodeIntegrationInSubFrames: true,
          },
        })
    view.setBackgroundColor('#ffffff')
    this.view = view
    this.crashed = false
    const wc = view.webContents
    wc.setAudioMuted(this.muted)
    // WebRTC (video calls) still works, but pages can't read your local network IP addresses.
    wc.setWebRTCIPHandlingPolicy('default_public_interface_only')
    this.wireEvents(wc)
    attachContextMenu(this, wc)
    this.window.onTabViewCreated(this, view)
    return wc
  }

  private wireEvents(wc: WebContents): void {
    const changed = () => this.window.onTabStateChanged(this)

    wc.on('page-title-updated', (_e, title) => {
      this.title = title
      changed()
    })
    wc.on('page-favicon-updated', (_e, favicons) => {
      this.favicon = favicons[0] ?? null
      // Bookmarks keep a local copy of the icon (imported ones may not have one yet).
      void this.window.browser.bookmarks.captureFavicon(this.url, this.favicon, this.session)
      changed()
    })
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) this.blockedCount = 0
    })
    wc.on('did-start-loading', changed)
    wc.on('did-stop-loading', changed)
    wc.on('did-navigate', (_e, url) => {
      this.url = url
      this.favicon = null
      changed()
    })
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame) return
      this.url = url
      changed()
    })
    wc.on('audio-state-changed', changed)
    wc.on('enter-html-full-screen', () => {
      this.htmlFullscreen = true
      this.window.layout()
    })
    wc.on('leave-html-full-screen', () => {
      this.htmlFullscreen = false
      this.window.layout()
    })
    wc.on('render-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit') return
      this.crashed = true
      changed()
    })
    wc.setWindowOpenHandler((details) => this.window.handleWindowOpen(this, details))
  }
}
