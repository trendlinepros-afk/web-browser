import { app, BrowserWindow, nativeTheme, type HandlerDetails, type Session, type WebContentsView, type WindowOpenHandlerResponse } from 'electron'
import path from 'node:path'
import { GROUP_COLORS, type BookmarkBarState, type GroupColor, type TabGroupInfo, type WindowState } from '../shared/types'
import { BookmarkStore } from './bookmarks'
import { getSettings } from './settings'
import { APP_NAME } from './brand'
import { accentColor, frameOptions, integratedTitleBar, titleBarOverlay, uiPlatform } from './theme'
import { Tab, type SavedTab } from './tab'
import type { Browser } from './browser'
import { PopupHost } from './popup'
import { homepageURL } from './url'
import { denyWindowOpen } from './hardening'
import { chromiumStatus } from './chromium-status'

/** Height of the browser UI (tab strip + toolbar) in DIPs. Must match --strip-h + --toolbar-h in styles.css. */
export const UI_HEIGHT = 86
/** Height of the bookmarks bar when shown. Must match --bookmarks-h in styles.css. */
export const BOOKMARKS_BAR_HEIGHT = 34
/** The page is a rounded card inset from the window edges. */
const CARD_MARGIN = 8
const CARD_RADIUS = 12

export interface SavedWindow {
  bounds: Electron.Rectangle
  maximized: boolean
  tabs: SavedTab[]
  activeIndex: number
  groups?: Omit<TabGroupInfo, 'id'>[]
}

let nextGroupId = 1

export interface WindowOptions {
  incognito: boolean
  session: Session
  restore?: SavedWindow
  url?: string
}

export class BrowserWindowController {
  readonly win: BrowserWindow
  /** Zirtola-styled menus and the settings panel for this window. */
  readonly popup: PopupHost
  readonly incognito: boolean
  readonly session: Session
  tabs: Tab[] = []
  activeTab: Tab | null = null
  /** Tab groups, in no particular order; their place in the strip comes from their tabs. */
  readonly groups = new Map<number, TabGroupInfo>()

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
      title: opts.incognito ? `${APP_NAME} Private` : APP_NAME,
      backgroundColor: opts.incognito ? '#0e0918' : nativeTheme.shouldUseDarkColors ? '#0a0d1a' : '#eceff8',
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
    denyWindowOpen(this.win.webContents)
    if (opts.restore?.maximized) this.win.maximize()

    this.win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), {
      query: {
        incognito: opts.incognito ? '1' : '0',
        platform: uiPlatform,
        frame: integratedTitleBar ? 'integrated' : 'native',
        version: app.getVersion(),
      },
    })
    this.win.once('ready-to-show', () => this.win.show())
    this.popup = new PopupHost(this)
    this.win.on('resize', () => this.layout())
    this.win.on('blur', () => {
      // Menus close when you switch apps, like native ones.
      if (!this.win.webContents.isFocused()) setTimeout(() => !this.win.isDestroyed() && !this.win.isFocused() && this.popup.close(), 50)
    })
    this.win.on('enter-full-screen', () => this.layout())
    this.win.on('leave-full-screen', () => this.layout())
    this.win.on('focus', () => {
      browser.lastFocused = this
      if (this.activeTab?.webContents) this.notifyExtensionsSelected(this.activeTab.webContents)
    })
    this.win.on('close', () => {
      browser.onWindowClosing(this)
      this.popup.destroy()
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
      const groups = (opts.restore.groups ?? []).map((g) => this.addGroup(g.title, g.color, g.collapsed))
      for (const saved of opts.restore.tabs) {
        const tab = new Tab(this, this.session, { sleeping: saved })
        tab.groupId = saved.group !== undefined ? (groups[saved.group]?.id ?? null) : null
        this.tabs.push(tab)
      }
      this.normalizeGroups()
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
    else {
      // A tab opened from inside a group (a link, "new tab to the right") joins that group.
      this.tabs.splice(index, 0, tab)
      tab.groupId ??= this.tabs[index - 1]?.groupId ?? null
    }
    if (!background || !this.activeTab) this.activateTab(tab)
    else tab.lastActiveAt = Date.now()
    this.pushState()
  }

  activateTab(tab: Tab): void {
    const group = tab.groupId !== null ? this.groups.get(tab.groupId) : undefined
    if (group?.collapsed) group.collapsed = false
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
    this.normalizeGroups()
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

  /** Puts a tab before another one (null: at the end), inside a group or not. Pinned tabs stay pinned. */
  moveTab(tab: Tab, before: Tab | null, groupId: number | null): void {
    if (before === tab) before = this.tabs[this.tabs.indexOf(tab) + 1] ?? null
    this.tabs.splice(this.tabs.indexOf(tab), 1)
    let index = before ? this.tabs.indexOf(before) : this.tabs.length
    if (index === -1) index = this.tabs.length
    const pinnedCount = this.tabs.filter((t) => t.pinned).length
    index = tab.pinned ? Math.min(index, pinnedCount) : Math.max(index, pinnedCount)
    this.tabs.splice(index, 0, tab)
    tab.groupId = !tab.pinned && groupId !== null && this.groups.has(groupId) ? groupId : null
    this.groupsChanged()
  }

  // ---- Tab groups -----------------------------------------------------------

  private addGroup(title: string, color?: GroupColor, collapsed = false): TabGroupInfo {
    const used = new Set([...this.groups.values()].map((g) => g.color))
    const group: TabGroupInfo = {
      id: nextGroupId++,
      title,
      color: color && GROUP_COLORS.includes(color) ? color : (GROUP_COLORS.find((c) => !used.has(c)) ?? GROUP_COLORS[this.groups.size % GROUP_COLORS.length]),
      collapsed,
    }
    this.groups.set(group.id, group)
    return group
  }

  /** Groups the given tabs together where the first of them is. */
  createGroup(tabs: Tab[], title = ''): TabGroupInfo {
    const group = this.addGroup(title)
    const members = this.tabs.filter((t) => tabs.includes(t))
    for (const t of members) {
      t.pinned = false
      t.groupId = group.id
    }
    // Gather the members where the first one is.
    const first = this.tabs.indexOf(members[0])
    const rest = this.tabs.filter((t) => !members.includes(t))
    const insertAt = rest.indexOf(this.tabs.slice(first).find((t) => !members.includes(t))!)
    rest.splice(insertAt === -1 ? rest.length : insertAt, 0, ...members)
    this.tabs = rest
    this.groupsChanged()
    return group
  }

  addToGroup(tab: Tab, groupId: number): void {
    const last = this.tabs.findLast((t) => t.groupId === groupId)
    tab.pinned = false
    this.moveTab(tab, last ? (this.tabs[this.tabs.indexOf(last) + 1] ?? null) : null, groupId)
  }

  removeFromGroup(tab: Tab): void {
    if (tab.groupId === null) return
    const last = this.tabs.findLast((t) => t.groupId === tab.groupId)!
    // Step out to just after the group so the rest stays together.
    this.moveTab(tab, last === tab ? (this.tabs[this.tabs.indexOf(tab) + 1] ?? null) : (this.tabs[this.tabs.indexOf(last) + 1] ?? null), null)
  }

  /** Moves a whole group before a tab (null: to the end). It can't land inside another group. */
  moveGroup(groupId: number, before: Tab | null): void {
    const members = this.tabs.filter((t) => t.groupId === groupId)
    if (!members.length || (before && members.includes(before))) return
    if (before && before.groupId !== null) before = this.tabs.find((t) => t.groupId === before!.groupId) ?? before
    const rest = this.tabs.filter((t) => t.groupId !== groupId)
    const pinnedCount = rest.filter((t) => t.pinned).length
    let index = before ? rest.indexOf(before) : rest.length
    index = Math.max(index === -1 ? rest.length : index, pinnedCount)
    rest.splice(index, 0, ...members)
    this.tabs = rest
    this.groupsChanged()
  }

  updateGroup(groupId: number, change: Partial<Pick<TabGroupInfo, 'title' | 'color' | 'collapsed'>>): void {
    const group = this.groups.get(groupId)
    if (!group) return
    if (change.title !== undefined) group.title = change.title.trim().slice(0, 60)
    if (change.color !== undefined && GROUP_COLORS.includes(change.color)) group.color = change.color
    if (change.collapsed !== undefined && change.collapsed !== group.collapsed) {
      if (change.collapsed && this.activeTab?.groupId === groupId) {
        // Like Chrome: collapsing the group you're in moves you to the nearest tab outside it.
        const i = this.tabs.indexOf(this.activeTab)
        const outside = [...this.tabs.slice(i + 1), ...this.tabs.slice(0, i).reverse()].find((t) => t.groupId !== groupId)
        if (outside) this.activateTab(outside)
        else this.createTab()
      }
      group.collapsed = change.collapsed
    }
    this.groupsChanged()
  }

  ungroup(groupId: number): void {
    for (const t of this.tabs) if (t.groupId === groupId) t.groupId = null
    this.groupsChanged()
  }

  closeGroup(groupId: number): void {
    for (const t of this.tabs.filter((t) => t.groupId === groupId)) this.closeTab(t)
  }

  /** Keeps every group's tabs side by side and drops empty groups. */
  normalizeGroups(): void {
    const ordered: Tab[] = []
    const placed = new Set<number>()
    for (const t of this.tabs) {
      if (t.pinned) t.groupId = null
      if (t.groupId === null || !this.groups.has(t.groupId)) {
        t.groupId = null
        ordered.push(t)
      } else if (!placed.has(t.groupId)) {
        placed.add(t.groupId)
        ordered.push(...this.tabs.filter((x) => x.groupId === t.groupId))
      }
    }
    this.tabs = ordered
    for (const id of this.groups.keys()) if (!placed.has(id)) this.groups.delete(id)
  }

  private groupsChanged(): void {
    this.normalizeGroups()
    this.pushState()
    this.browser.scheduleSessionSave()
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
    if (fullscreen) {
      view.setBorderRadius(0)
      view.setBounds({ x: 0, y: 0, width, height })
    } else {
      const top = this.uiHeight()
      view.setBorderRadius(CARD_RADIUS)
      view.setBounds({ x: CARD_MARGIN, y: top, width: Math.max(0, width - 2 * CARD_MARGIN), height: Math.max(0, height - top - CARD_MARGIN) })
    }
    this.popup.layout()
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
    this.popup.raise()
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

  /** The home button: the homepage from Settings, or a blank page ready for typing. */
  goHome(tab: Tab): void {
    const home = homepageURL()
    tab.loadURL(home ?? 'about:blank')
    if (tab !== this.activeTab) return
    if (home) tab.webContents?.focus()
    else this.focusAddressBar()
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
    this.win.setTitle(title ? `${title}${this.incognito ? ' (Private)' : ''} - ${APP_NAME}` : APP_NAME)
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
      showHomeButton: getSettings().showHomeButton,
      groups: [...this.groups.values()],
      chromium: chromiumStatus(),
    }
  }

  toSaved(): SavedWindow {
    const normal = this.win.getNormalBounds()
    const tabs = this.tabs.filter((t) => t.url)
    const groupIds = [...new Set(tabs.map((t) => t.groupId).filter((id): id is number => id !== null))]
    return {
      bounds: normal,
      maximized: this.win.isMaximized(),
      tabs: tabs.map((t) => ({ ...t.toSaved(), ...(t.groupId !== null ? { group: groupIds.indexOf(t.groupId) } : {}) })),
      activeIndex: Math.max(0, tabs.indexOf(this.activeTab!)),
      groups: groupIds.map((id) => {
        const { title, color, collapsed } = this.groups.get(id)!
        return { title, color, collapsed }
      }),
    }
  }

  /** Asks the UI to show the name editor for a group. */
  startRenamingGroup(groupId: number): void {
    if (this.uiReady && !this.win.isDestroyed()) {
      this.win.webContents.focus()
      this.win.webContents.send('ui:rename-group', groupId)
    }
  }
}
