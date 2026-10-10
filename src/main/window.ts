import { BrowserWindow, type HandlerDetails, type Session, type WebContentsView, type WindowOpenHandlerResponse } from 'electron'
import path from 'node:path'
import type { BookmarkBarState, WindowState } from '../shared/types'
import { BookmarkStore } from './bookmarks'
import { getSettings } from './settings'
import { APP_NAME } from './brand'
import { accentColor, frameOptions, integratedTitleBar, titleBarOverlay, uiPlatform } from './theme'
import { Tab, type SavedTab } from './tab'
import type { Browser } from './browser'

/** Height of the browser UI (tab strip + toolbar) in DIPs. Must match styles.css. */
export const UI_HEIGHT = 78
/** Height of the bookmarks bar when shown. Must match --bookmarks-h in styles.css. */
export const BOOKMARKS_BAR_HEIGHT = 32

export interface SavedWindow {
  bounds: Electron.Rectangle
  maximized: boolean
  tabs: SavedTab[]
  activeIndex: number
}

export interface WindowOptions {
  incognito: boolean
  session: Session
  restore?: SavedWindow
  url?: string
}

export class BrowserWindowController {
  readonly win: BrowserWindow
  readonly incognito: boolean
  readonly session: Session
  tabs: Tab[] = []
  activeTab: Tab | null = null

  private shownView: WebContentsView | null = null
  private statePending = false
  private uiReady = false

  constructor(
    readonly browser: Browser,
    opts: WindowOptions,
  ) {
    this.incognito = opts.incognito
    this.session = opts.session
    const bounds = opts.restore?.bounds

    this.win = new BrowserWindow({
      width: bounds?.width ?? 1280,
      height: bounds?.height ?? 840,
      x: bounds?.x,
      y: bounds?.y,
      minWidth: 480,
      minHeight: 300,
      show: false,
      title: opts.incognito ? `${APP_NAME} Incognito` : APP_NAME,
      backgroundColor: opts.incognito ? '#202124' : '#f1f3f4',
      autoHideMenuBar: true,
      icon: process.platform === 'linux' ? path.join(__dirname, '..', 'renderer', 'icon.png') : undefined,
      ...frameOptions(opts.incognito),
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'ui-preload.js'),
        // The UI preload needs Node's require() for the extension toolbar element.
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    })
    this.win.setMenuBarVisibility(false)
    if (opts.restore?.maximized) this.win.maximize()

    this.win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), {
      query: { incognito: opts.incognito ? '1' : '0', platform: uiPlatform, frame: integratedTitleBar ? 'integrated' : 'native' },
    })
    this.win.once('ready-to-show', () => this.win.show())
    this.win.on('resize', () => this.layout())
    this.win.on('enter-full-screen', () => this.layout())
    this.win.on('leave-full-screen', () => this.layout())
    this.win.on('focus', () => {
      browser.lastFocused = this
      if (this.activeTab?.webContents) this.notifyExtensionsSelected(this.activeTab.webContents)
    })
    this.win.on('close', () => {
      browser.onWindowClosing(this)
      // Tear tabs down while the window still exists: the extension layer looks up each
      // tab's window when it's removed, which throws once the window is destroyed.
      const tabs = this.tabs
      this.tabs = []
      this.activeTab = null
      for (const tab of tabs) tab.destroy()
    })
    this.win.on('closed', () => browser.onWindowClosed(this))

    if (opts.restore && opts.restore.tabs.length > 0) {
      // Lazy restore: every tab starts asleep; only the active one is woken.
      for (const saved of opts.restore.tabs) this.tabs.push(new Tab(this, this.session, { sleeping: saved }))
      const active = this.tabs[Math.min(Math.max(opts.restore.activeIndex, 0), this.tabs.length - 1)]
      this.activateTab(active)
    } else {
      this.createTab({ url: opts.url })
    }
  }

  get id(): number {
    return this.win.id
  }

  // ---- Tabs ---------------------------------------------------------------

  createTab(opts: { url?: string; background?: boolean; index?: number } = {}): Tab {
    const tab = new Tab(this, this.session, { url: opts.url && opts.url !== 'about:blank' ? opts.url : undefined })
    this.insertTab(tab, opts.index, opts.background)
    if (!tab.url && !opts.background) this.focusAddressBar()
    return tab
  }

  /** Adopts a WebContents created by Chromium for window.open/target=_blank, preserving window.opener. */
  adoptTab(webContentsOptions: Electron.WebContentsViewConstructorOptions, opener: Tab, background: boolean): Tab {
    const tab = new Tab(this, this.session, { webContentsOptions })
    const index = this.tabs.indexOf(opener) + 1
    this.insertTab(tab, index > 0 ? index : undefined, background)
    return tab
  }

  private insertTab(tab: Tab, index: number | undefined, background = false): void {
    if (index === undefined || index < 0 || index > this.tabs.length) this.tabs.push(tab)
    else this.tabs.splice(index, 0, tab)
    if (!background || !this.activeTab) this.activateTab(tab)
    else tab.lastActiveAt = Date.now()
    this.pushState()
  }

  activateTab(tab: Tab): void {
    const previous = this.activeTab
    if (previous && previous !== tab) previous.lastActiveAt = Date.now()
    this.activeTab = tab
    tab.lastActiveAt = Date.now()
    const wc = tab.wake()
    this.showActiveView()
    if (tab.crashed) wc.reload()
    if (this.win.isFocused() && this.uiReady) wc.focus()
    this.notifyExtensionsSelected(wc)
    this.pushState()
  }

  /** Extensions only run in the normal profile; incognito tabs live in a different session. */
  private notifyExtensionsSelected(wc: Electron.WebContents): void {
    if (!this.incognito) this.browser.extensions?.selectTab(wc)
  }

  closeTab(tab: Tab): void {
    const index = this.tabs.indexOf(tab)
    if (index === -1) return
    this.browser.rememberClosedTab(this, tab)
    this.tabs.splice(index, 1)
    if (this.activeTab === tab) {
      this.activeTab = null
      const next = this.tabs[index] ?? this.tabs[index - 1]
      if (next) this.activateTab(next)
    }
    tab.destroy()
    if (this.tabs.length === 0) {
      this.win.close()
      return
    }
    this.pushState()
  }

  cycleTab(delta: number): void {
    if (!this.activeTab || this.tabs.length < 2) return
    const i = this.tabs.indexOf(this.activeTab)
    this.activateTab(this.tabs[(i + delta + this.tabs.length) % this.tabs.length])
  }

  findTab(id: number): Tab | undefined {
    return this.tabs.find((t) => t.id === id)
  }

  // ---- Views & layout -----------------------------------------------------

  /**
   * Awake tabs stay attached to the window; only the active one is visible. Hidden views report
   * `document.visibilityState === 'hidden'`, so Chromium throttles their timers and rendering.
   * (Detaching and re-attaching a view instead leaves it stuck in the hidden state.)
   */
  private showActiveView(): void {
    const view = this.activeTab?.view ?? null
    if (this.shownView !== view) {
      this.shownView?.setVisible(false)
      this.shownView = view
      view?.setVisible(true)
    }
    this.layout()
  }

  layout(): void {
    const view = this.shownView
    if (!view || this.win.isDestroyed()) return
    const [width, height] = this.win.getContentSize()
    const fullscreen = this.activeTab?.htmlFullscreen ?? false
    const top = fullscreen ? 0 : this.uiHeight()
    view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) })
  }

  detachTabView(view: WebContentsView): void {
    if (!this.win.isDestroyed()) this.win.contentView.removeChildView(view)
    if (this.shownView === view) this.shownView = null
  }

  // ---- Hooks from Tab -----------------------------------------------------

  onTabViewCreated(tab: Tab, view: WebContentsView): void {
    view.setVisible(false)
    this.win.contentView.addChildView(view)
    this.browser.registerTabWebContents(tab, view.webContents)
    if (!this.incognito) this.browser.extensions?.addTab(view.webContents, this.win)
    this.browser.mcpTabsChanged()
    if (this.activeTab === tab) this.showActiveView()
  }

  onTabWoke(tab: Tab): void {
    if (this.activeTab === tab) this.showActiveView()
    this.pushState()
  }

  onTabStateChanged(_tab: Tab): void {
    this.pushState()
    this.browser.scheduleSessionSave()
  }

  handleWindowOpen(opener: Tab, details: HandlerDetails): WindowOpenHandlerResponse {
    if (details.disposition === 'foreground-tab' || details.disposition === 'background-tab') {
      return {
        action: 'allow',
        createWindow: (options) => {
          const tab = this.adoptTab(
            // Chromium pre-creates the WebContents and passes it in the options; adopting it keeps window.opener.
            { webContents: (options as { webContents?: Electron.WebContents }).webContents, webPreferences: options.webPreferences },
            opener,
            details.disposition === 'background-tab',
          )
          return tab.webContents!
        },
      }
    }
    // Real popups (window.open with features, e.g. OAuth/SSO): a minimal window that keeps window.opener.
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        autoHideMenuBar: true,
        backgroundColor: '#ffffff',
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
      },
    }
  }

  // ---- UI -----------------------------------------------------------------

  uiHeight(): number {
    return UI_HEIGHT + (getSettings().showBookmarksBar ? BOOKMARKS_BAR_HEIGHT : 0)
  }

  onUiReady(): void {
    this.uiReady = true
    this.sendState()
    this.sendBookmarks()
    if (this.activeTab && !this.activeTab.url) this.focusAddressBar()
  }

  focusAddressBar(): void {
    if (this.win.isDestroyed()) return
    this.win.webContents.focus()
    this.win.webContents.send('ui:focus-address-bar')
  }

  /** Coalesces many tab events into one UI update per tick. */
  pushState(): void {
    if (this.statePending) return
    this.statePending = true
    setImmediate(() => {
      this.statePending = false
      this.sendState()
    })
  }

  /** The bar's top-level items; sent only when bookmarks or the bar's visibility change. */
  sendBookmarks(): void {
    if (!this.uiReady || this.win.isDestroyed()) return
    const store = this.browser.bookmarks
    const bar: BookmarkBarState = {
      visible: getSettings().showBookmarksBar,
      items: (store.bar.children ?? []).map((n) => BookmarkStore.toItem(n)),
      otherCount: store.other.children?.length ?? 0,
    }
    this.win.webContents.send('ui:bookmarks', bar)
    this.layout()
  }

  /** Light/dark mode or accent color changed: recolor the native caption buttons and the UI. */
  onThemeChanged(): void {
    const overlay = titleBarOverlay(this.incognito)
    if (overlay && !this.win.isDestroyed()) this.win.setTitleBarOverlay(overlay)
    this.pushState()
  }

  private sendState(): void {
    if (!this.uiReady || this.win.isDestroyed()) return
    const title = this.activeTab?.title
    this.win.setTitle(title ? `${title}${this.incognito ? ' — Incognito' : ''} - ${APP_NAME}` : APP_NAME)
    this.win.webContents.send('ui:state', this.state())
  }

  state(): WindowState {
    return {
      windowId: this.id,
      incognito: this.incognito,
      extensionPartition: this.incognito ? null : this.browser.profilePartition,
      activeTabId: this.activeTab?.id ?? null,
      tabs: this.tabs.map((t) => t.info()),
      mcpEnabled: this.browser.mcpEnabled(),
      accent: accentColor(),
    }
  }

  toSaved(): SavedWindow {
    const normal = this.win.getNormalBounds()
    return {
      bounds: normal,
      maximized: this.win.isMaximized(),
      tabs: this.tabs.filter((t) => t.url).map((t) => t.toSaved()),
      activeIndex: Math.max(0, this.tabs.filter((t) => t.url).indexOf(this.activeTab!)),
    }
  }
}
