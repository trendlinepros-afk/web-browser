import { app, BrowserWindow, ipcMain, session, type Session, type WebContents } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { ElectronChromeExtensions } from 'electron-chrome-extensions'
import { BrowserWindowController, type SavedWindow } from './window'
import type { SavedTab, Tab } from './tab'
import { getSettings } from './settings'
import { configureSession } from './permissions'
import { toNavigableURL } from './url'
import { AdBlocker } from './blocker'
import { configureNetwork } from './privacy'
import { BookmarkStore } from './bookmarks'
import { onThemeChanged } from './theme'

interface SavedSession {
  version: 1
  windows: SavedWindow[]
}

/** Owns every window and tab, the browsing profiles, and session persistence. */
export class Browser {
  readonly profilePartition = 'persist:default'
  readonly profile: Session
  readonly blocker = new AdBlocker()
  readonly bookmarks = new BookmarkStore()
  private bookmarksSent = -1
  private tabsByWebContents = new WeakMap<WebContents, Tab>()
  extensions: ElectronChromeExtensions | null = null
  windows = new Map<number, BrowserWindowController>()
  lastFocused: BrowserWindowController | null = null
  onMcpTabsChanged: (() => void) | null = null
  mcpEnabled: () => boolean = () => false

  private incognitoCounter = 0
  private saveTimer: NodeJS.Timeout | null = null
  /** Set once the last normal window closes, so tearing down windows doesn't erase the saved session. */
  private sessionFrozen = false
  private quitting = false
  private closedTabs: { saved: SavedTab; incognito: boolean }[] = []

  constructor() {
    onThemeChanged(() => {
      for (const w of this.windows.values()) w.onThemeChanged()
    })
    this.bookmarks.load()
    this.bookmarks.onChanged = () => {
      // Coalesce bursts (e.g. an import) into one UI update.
      setImmediate(() => {
        if (this.bookmarksSent === this.bookmarks.version) return
        this.bookmarksSent = this.bookmarks.version
        this.bookmarksLayoutChanged()
      })
    }
    this.profile = session.fromPartition(this.profilePartition)
    configureSession(this.profile, this)
    configureNetwork(this.profile, this.blocker)
    this.blocker.onBlocked = (wc) => {
      const tab = this.tabsByWebContents.get(wc)
      if (!tab) return
      tab.blockedCount++
      if (tab.window.activeTab === tab) tab.window.pushState()
    }
    this.registerIpc()
  }

  // ---- Windows ------------------------------------------------------------

  createWindow(opts: { incognito?: boolean; url?: string; restore?: SavedWindow } = {}): BrowserWindowController {
    const incognito = opts.incognito ?? false
    let ses = this.profile
    if (incognito) {
      // A fresh in-memory partition per incognito window: nothing touches disk or other windows.
      ses = session.fromPartition(`incognito-${++this.incognitoCounter}-${Date.now()}`, { cache: false })
      configureSession(ses, this)
      configureNetwork(ses, this.blocker)
    }
    if (!incognito) this.sessionFrozen = false
    const controller = new BrowserWindowController(this, { incognito, session: ses, url: opts.url, restore: opts.restore })
    this.windows.set(controller.id, controller)
    this.lastFocused = controller
    return controller
  }

  /** Most recently focused normal (or incognito, if allowed) window; creates one if needed. */
  targetWindow(opts: { incognito?: boolean } = {}): BrowserWindowController {
    const wanted = opts.incognito ?? false
    const focused = BrowserWindow.getFocusedWindow()
    const candidates = [focused && this.windows.get(focused.id), this.lastFocused, ...this.windows.values()]
    for (const c of candidates) {
      if (c && !c.win.isDestroyed() && c.incognito === wanted) return c
    }
    return this.createWindow({ incognito: wanted })
  }

  fromWebContents(wc: WebContents): BrowserWindowController | undefined {
    const win = BrowserWindow.fromWebContents(wc)
    return win ? this.windows.get(win.id) : undefined
  }

  onWindowClosing(controller: BrowserWindowController): void {
    // Closing the last normal window ends the browsing session: save it now, with this window in it.
    const normal = [...this.windows.values()].filter((w) => !w.incognito)
    if (!controller.incognito && normal.length === 1) {
      this.saveSessionNow()
      this.sessionFrozen = true
    }
  }

  onWindowClosed(controller: BrowserWindowController): void {
    this.windows.delete(controller.id)
    if (this.lastFocused === controller) this.lastFocused = null
    if (controller.incognito) {
      // Belt and braces: wipe anything the in-memory partition held.
      controller.session.clearStorageData().catch(() => {})
      controller.session.clearCache().catch(() => {})
    }
    this.scheduleSessionSave()
    this.mcpTabsChanged()
  }

  // ---- Tabs ---------------------------------------------------------------

  allTabs(): Tab[] {
    return [...this.windows.values()].flatMap((w) => w.tabs)
  }

  findTab(id: number): Tab | undefined {
    for (const w of this.windows.values()) {
      const t = w.findTab(id)
      if (t) return t
    }
    return undefined
  }

  findTabByWebContents(wc: WebContents): Tab | undefined {
    return this.tabsByWebContents.get(wc)
  }

  registerTabWebContents(tab: Tab, wc: WebContents): void {
    this.tabsByWebContents.set(wc, tab)
  }

  /** Bookmarks or the bar's visibility changed: refresh every window's bar, stars and layout. */
  bookmarksLayoutChanged(): void {
    for (const w of this.windows.values()) {
      w.sendBookmarks()
      w.pushState()
    }
  }

  rememberClosedTab(window: BrowserWindowController, tab: Tab): void {
    if (!tab.url) return
    this.closedTabs.push({ saved: tab.toSaved(), incognito: window.incognito })
    if (this.closedTabs.length > 25) this.closedTabs.shift()
  }

  reopenClosedTab(window: BrowserWindowController): void {
    for (let i = this.closedTabs.length - 1; i >= 0; i--) {
      if (this.closedTabs[i].incognito !== window.incognito) continue
      const [{ saved }] = this.closedTabs.splice(i, 1)
      const tab = window.createTab({ url: saved.url })
      tab.pinned = saved.pinned
      return
    }
  }

  mcpTabsChanged(): void {
    this.onMcpTabsChanged?.()
  }

  // ---- Session persistence ------------------------------------------------

  private sessionFile(): string {
    return path.join(app.getPath('userData'), 'session.json')
  }

  scheduleSessionSave(): void {
    if (this.sessionFrozen || this.quitting) return
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.saveSessionNow(), 1500)
  }

  saveSessionNow(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    if (this.sessionFrozen || this.quitting) return
    const data: SavedSession = {
      version: 1,
      windows: [...this.windows.values()]
        .filter((w) => !w.incognito && !w.win.isDestroyed())
        .map((w) => w.toSaved())
        .filter((w) => w.tabs.length > 0),
    }
    try {
      const file = this.sessionFile()
      fs.writeFileSync(file + '.tmp', JSON.stringify(data))
      fs.renameSync(file + '.tmp', file)
    } catch (err) {
      console.error('Failed to save session', err)
    }
  }

  /** Called on quit: save once, then ignore the changes caused by windows closing. */
  freezeSession(): void {
    this.saveSessionNow()
    this.quitting = true
  }

  /** Opens the startup windows: restores the previous session if enabled, else one new window. */
  start(urls: string[]): void {
    let restored = false
    if (getSettings().restoreSession) {
      try {
        const data = JSON.parse(fs.readFileSync(this.sessionFile(), 'utf8')) as SavedSession
        for (const w of data.windows ?? []) {
          if (w.tabs.length === 0) continue
          this.createWindow({ restore: w })
          restored = true
        }
      } catch {
        // No previous session.
      }
    }
    if (!restored) this.createWindow({ url: urls.shift() })
    for (const url of urls) this.targetWindow().createTab({ url })
  }

  // ---- IPC from the browser UI -------------------------------------------

  private registerIpc(): void {
    ipcMain.on('ui:cmd', (event, name: string, ...args: unknown[]) => {
      const w = this.fromWebContents(event.sender)
      if (!w) return
      const tab = typeof args[0] === 'number' ? w.findTab(args[0]) : undefined
      switch (name) {
        case 'ready':
          return w.onUiReady()
        case 'newTab':
          return void w.createTab({ url: typeof args[0] === 'string' ? args[0] : undefined })
        case 'closeTab':
          return tab && w.closeTab(tab)
        case 'activateTab':
          return tab && w.activateTab(tab)
        case 'navigate': {
          if (!tab || typeof args[1] !== 'string') return
          const url = toNavigableURL(args[1], getSettings().searchEngine)
          if (!url) return
          tab.loadURL(url)
          tab.webContents?.focus()
          return
        }
        case 'moveTab': {
          const before = typeof args[1] === 'number' ? (w.findTab(args[1]) ?? null) : null
          return tab && w.moveTab(tab, before, typeof args[2] === 'number' ? args[2] : null)
        }
        case 'moveGroup': {
          const before = typeof args[1] === 'number' ? (w.findTab(args[1]) ?? null) : null
          return w.moveGroup(Number(args[0]), before)
        }
        case 'toggleGroupCollapsed': {
          const group = w.groups.get(Number(args[0]))
          return group && w.updateGroup(group.id, { collapsed: !group.collapsed })
        }
        case 'renameGroup':
          return typeof args[1] === 'string' && w.updateGroup(Number(args[0]), { title: args[1] })
        case 'showGroupMenu':
          return this.onShowGroupMenu?.(w, Number(args[0]), Number(args[1]), Number(args[2]))
        case 'goHome':
          return tab && w.goHome(tab)
        case 'goBack':
          return tab?.wake().navigationHistory.goBack()
        case 'goForward':
          return tab?.wake().navigationHistory.goForward()
        case 'reload':
          return tab?.wake().reload()
        case 'stop':
          return tab?.webContents?.stop()
        case 'toggleMute':
          if (!tab) return
          tab.muted = !tab.muted
          tab.webContents?.setAudioMuted(tab.muted)
          return w.pushState()
        case 'showAppMenu':
          return this.onShowAppMenu?.(w, Number(args[0]), Number(args[1]))
        case 'showTabMenu':
          return tab && this.onShowTabMenu?.(w, tab, Number(args[1]), Number(args[2]))
        case 'openChat':
          return this.onOpenChat?.(w, Number(args[0]), Number(args[1]))
        case 'showShieldMenu':
          return this.onShowShieldMenu?.(w, Number(args[0]), Number(args[1]))
        default:
          if (name === 'bookmarkActiveTab' || name.startsWith('bookmark:')) return this.onBookmarkCommand?.(w, name, args)
      }
    })
  }

  onShowAppMenu: ((w: BrowserWindowController, x: number, y: number) => void) | null = null
  onShowTabMenu: ((w: BrowserWindowController, tab: Tab, x: number, y: number) => void) | null = null
  onShowGroupMenu: ((w: BrowserWindowController, groupId: number, x: number, y: number) => void) | null = null
  onOpenChat: ((w: BrowserWindowController, x: number, y: number) => void) | null = null
  onShowShieldMenu: ((w: BrowserWindowController, x: number, y: number) => void) | null = null
  onBookmarkCommand: ((w: BrowserWindowController, name: string, args: unknown[]) => void) | null = null
}
