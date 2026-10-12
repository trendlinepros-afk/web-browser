import { app, BrowserWindow, clipboard, dialog, Menu, nativeTheme, shell, type MenuItemConstructorOptions } from 'electron'
import type { SettingsModel } from '../shared/types'
import type { Browser } from './browser'
import type { BrowserWindowController } from './window'
import type { Tab } from './tab'
import { BrowserMcpServer } from './mcp-server'
import type { TabSleeper } from './tab-sleeper'
import { getSettings, updateSettings } from './settings'
import { checkForUpdates } from './updater'
import { makeDefaultBrowser } from './default-browser'
import { AdBlocker } from './blocker'
import { BookmarkUi } from './bookmark-ui'
import { CHROME_WEB_STORE_URL, LASTPASS_URL, updateAllExtensions } from './extensions'
import { diagnosticsText } from './extension-apis'
import { toNavigableURL } from './url'

const REPO_URL = 'https://github.com/trendlinepros-afk/web-browser'

const SEARCH_ENGINES: [string, string][] = [
  ['Google', 'https://www.google.com/search?q=%s'],
  ['DuckDuckGo', 'https://duckduckgo.com/?q=%s'],
  ['Bing', 'https://www.bing.com/search?q=%s'],
  ['Brave Search', 'https://search.brave.com/search?q=%s'],
]

const SLEEP_OPTIONS: [string, number][] = [
  ['5 minutes', 5],
  ['15 minutes', 15],
  ['30 minutes', 30],
  ['1 hour', 60],
  ['4 hours', 240],
  ['Never', 0],
]

export class Menus {
  readonly bookmarkUi: BookmarkUi

  constructor(
    private readonly browser: Browser,
    private readonly mcp: BrowserMcpServer,
    private readonly sleeper: TabSleeper,
  ) {
    browser.onShowAppMenu = (w, x, y) => this.showAppMenu(w, x, y)
    browser.onShowTabMenu = (w, tab, x, y) => this.showTabMenu(w, tab, x, y)
    browser.onShowShieldMenu = (w, x, y) => this.showShieldMenu(w, x, y)
    this.bookmarkUi = new BookmarkUi(browser)
    browser.onBookmarkCommand = (w, name, args) => this.bookmarkUi.handle(w, name, args)
  }

  private current(): BrowserWindowController | undefined {
    const win = BrowserWindow.getFocusedWindow()
    return (win && this.browser.windows.get(win.id)) || this.browser.lastFocused || undefined
  }

  private withWindow(fn: (w: BrowserWindowController) => void): () => void {
    return () => {
      const w = this.current()
      if (w) fn(w)
      else fn(this.browser.createWindow())
    }
  }

  private withTab(fn: (tab: Tab, w: BrowserWindowController) => void): () => void {
    return this.withWindow((w) => w.activeTab && fn(w.activeTab, w))
  }

  /** The application menu. Hidden on Windows/Linux but its accelerators are the browser's shortcuts. */
  installApplicationMenu(): void {
    const isMac = process.platform === 'darwin'
    const template: MenuItemConstructorOptions[] = [
      ...(isMac ? [{ role: 'appMenu' as const }] : []),
      {
        label: 'File',
        submenu: [
          { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: this.withWindow((w) => w.createTab()) },
          { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => this.browser.createWindow() },
          {
            label: 'New Private Window',
            accelerator: 'CmdOrCtrl+Shift+N',
            click: () => this.browser.createWindow({ incognito: true }),
          },
          { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: this.withWindow((w) => this.browser.reopenClosedTab(w)) },
          { type: 'separator' },
          { label: 'Bookmark This Page', accelerator: 'CmdOrCtrl+D', click: this.withWindow((w) => this.bookmarkUi.bookmarkActiveTab(w)) },
          { label: 'Show Bookmarks Bar', accelerator: 'CmdOrCtrl+Shift+B', click: () => this.bookmarkUi.toggleBar() },
          { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: this.withWindow((w) => this.openSettings(w)) },
          { label: 'Clear Browsing Data', accelerator: 'CmdOrCtrl+Shift+Delete', click: this.withWindow((w) => this.openSettings(w, 'clear')) },
          { type: 'separator' },
          { label: 'Open Location', accelerator: 'CmdOrCtrl+L', click: this.withWindow((w) => w.focusAddressBar()) },
          { label: 'Open Location', accelerator: 'Alt+D', visible: false, click: this.withWindow((w) => w.focusAddressBar()) },
          { label: 'Open Location', accelerator: 'F6', visible: false, click: this.withWindow((w) => w.focusAddressBar()) },
          { type: 'separator' },
          { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: this.withTab((t) => t.webContents?.print()) },
          { type: 'separator' },
          { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: this.withTab((t, w) => w.closeTab(t)) },
          { label: 'Close Tab', accelerator: 'CmdOrCtrl+F4', visible: false, click: this.withTab((t, w) => w.closeTab(t)) },
          { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', click: this.withWindow((w) => w.win.close()) },
          ...(isMac ? [] : [{ type: 'separator' as const }, { role: 'quit' as const }]),
        ],
      },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: this.withTab((t) => t.wake().reload()) },
          { label: 'Reload', accelerator: 'F5', visible: false, click: this.withTab((t) => t.wake().reload()) },
          {
            label: 'Hard Reload',
            accelerator: 'CmdOrCtrl+Shift+R',
            click: this.withTab((t) => t.wake().reloadIgnoringCache()),
          },
          { label: 'Stop', accelerator: 'Escape', visible: false, enabled: false },
          { type: 'separator' },
          { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: this.withTab((t) => zoom(t, 0.5)) },
          { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', visible: false, click: this.withTab((t) => zoom(t, 0.5)) },
          { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: this.withTab((t) => zoom(t, -0.5)) },
          { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: this.withTab((t) => t.webContents?.setZoomLevel(0)) },
          { type: 'separator' },
          { role: 'togglefullscreen' },
          {
            label: 'Developer Tools',
            accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
            click: this.withTab((t) => t.webContents?.toggleDevTools()),
          },
          { label: 'Developer Tools', accelerator: 'F12', visible: false, click: this.withTab((t) => t.webContents?.toggleDevTools()) },
          {
            label: 'Browser UI Developer Tools',
            accelerator: 'CmdOrCtrl+Alt+Shift+I',
            visible: false,
            click: this.withWindow((w) => w.win.webContents.openDevTools({ mode: 'detach' })),
          },
        ],
      },
      {
        label: 'History',
        submenu: [
          { label: 'Back', accelerator: isMac ? 'Cmd+[' : 'Alt+Left', click: this.withTab((t) => t.wake().navigationHistory.goBack()) },
          { label: 'Forward', accelerator: isMac ? 'Cmd+]' : 'Alt+Right', click: this.withTab((t) => t.wake().navigationHistory.goForward()) },
          { label: 'Home', accelerator: isMac ? 'Cmd+Shift+H' : 'Alt+Home', click: this.withTab((t, w) => w.goHome(t)) },
        ],
      },
      {
        label: 'Tabs',
        submenu: [
          { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: this.withWindow((w) => w.cycleTab(1)) },
          { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: this.withWindow((w) => w.cycleTab(-1)) },
          { label: 'Next Tab', accelerator: 'CmdOrCtrl+PageDown', visible: false, click: this.withWindow((w) => w.cycleTab(1)) },
          { label: 'Previous Tab', accelerator: 'CmdOrCtrl+PageUp', visible: false, click: this.withWindow((w) => w.cycleTab(-1)) },
          ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
            label: `Tab ${n}`,
            accelerator: `CmdOrCtrl+${n}`,
            visible: false,
            click: this.withWindow((w) => w.tabs[n - 1] && w.activateTab(w.tabs[n - 1])),
          })),
          {
            label: 'Last Tab',
            accelerator: 'CmdOrCtrl+9',
            visible: false,
            click: this.withWindow((w) => w.tabs.length && w.activateTab(w.tabs[w.tabs.length - 1])),
          },
        ],
      },
      { role: 'windowMenu' },
      {
        role: 'help',
        submenu: [
          { label: 'Check for Updates…', click: () => checkForUpdates({ interactive: true }) },
          { label: 'Project on GitHub', click: () => shell.openExternal(REPO_URL) },
          { label: 'Report an Issue', click: () => shell.openExternal(`${REPO_URL}/issues/new`) },
        ],
      },
    ]
    Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  }

  /** The ⚙ menu in the toolbar: quick actions; everything configurable lives in Settings. */
  showAppMenu(w: BrowserWindowController, x: number, y: number): void {
    const template: MenuItemConstructorOptions[] = [
      { label: 'New tab', accelerator: 'CmdOrCtrl+T', click: () => w.createTab() },
      { label: 'New window', accelerator: 'CmdOrCtrl+N', click: () => this.browser.createWindow() },
      { label: 'New private window', accelerator: 'CmdOrCtrl+Shift+N', click: () => this.browser.createWindow({ incognito: true }) },
      { type: 'separator' },
      { label: 'Bookmarks', submenu: this.bookmarkUi.appMenu(w) },
      { label: 'Extensions', submenu: this.extensionsMenu(w) },
      { type: 'separator' },
      { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => this.openSettings(w) },
      { label: 'Check for updates', click: () => checkForUpdates({ interactive: true }) },
      { type: 'separator' },
      { label: `Zirtola ${app.getVersion()}`, enabled: false },
      { label: 'Quit Zirtola', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
    ]
    w.popup.menu(template, x, y, { align: 'right' })
  }

  private extensionsMenu(w: BrowserWindowController): MenuItemConstructorOptions[] {
    return [
      { label: 'Get extensions (Chrome Web Store)', click: () => this.openInNormalWindow(w, CHROME_WEB_STORE_URL) },
      { label: 'Install LastPass', click: () => this.openInNormalWindow(w, LASTPASS_URL) },
      { type: 'separator' },
      ...this.installedExtensionItems(),
      { type: 'separator' },
      {
        label: 'Update extensions now',
        click: () => updateAllExtensions(this.browser).catch((err) => dialog.showErrorBox('Extension update failed', String(err))),
      },
    ]
  }

  // ---- Settings panel ---------------------------------------------------------

  private lastCleared: { cache?: string; site?: string } = {}

  openSettings(w: BrowserWindowController, section?: string, keepStatus = false): void {
    w.popup.onSetting = (key, value) => {
      void this.applySetting(key, value).then(() => w.popup.updateSettings(this.settingsModel()))
    }
    w.popup.onAction = (name) => this.runAction(w, name)
    if (!keepStatus) this.lastCleared = {}
    w.popup.settings({ ...this.settingsModel(), focus: section })
  }

  /** Clears the HTTP cache and compiled-code cache. Cookies and logins are untouched. */
  private async clearCache(w: BrowserWindowController): Promise<void> {
    await w.session.clearCache()
    await w.session.clearCodeCaches({}).catch(() => {})
    this.lastCleared.cache = `Cache cleared at ${new Date().toLocaleTimeString()}.`
  }

  /**
   * Clears cookies and site storage for every website. Service workers are left alone because
   * extensions (e.g. LastPass) run on them; chrome.storage lives elsewhere and is untouched.
   */
  private async clearAllSiteData(w: BrowserWindowController): Promise<void> {
    const choice = await w.popup.prompt({
      kind: 'warning',
      title: 'Clear cookies and site data?',
      message: 'You will be signed out of websites. Bookmarks, settings and extensions are kept.',
      buttons: ['Clear', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
    })
    if (choice !== 0) return
    await w.session.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage', 'filesystem', 'shadercache'] })
    await w.session.clearCache()
    // The confirmation replaced the settings panel; reopen it showing the result.
    this.lastCleared.site = `Cookies and site data cleared at ${new Date().toLocaleTimeString()}.`
    this.openSettings(w, 'clear', true)
  }

  /** Clears cookies and storage for the current site (including its parent domain's cookies). */
  async clearSiteData(w: BrowserWindowController, url: string): Promise<void> {
    let origin: URL
    try {
      origin = new URL(url)
    } catch {
      return
    }
    const site = AdBlocker.siteOf(url) ?? origin.hostname
    const origins = new Set([origin.origin, `https://${site}`, `http://${site}`, `https://www.${site}`])
    for (const o of origins) await w.session.clearStorageData({ origin: o }).catch(() => {})
    // Cookies set on the parent domain (e.g. .google.com) by any subdomain.
    const cookies = await w.session.cookies.get({ domain: site })
    for (const c of cookies) {
      const host = (c.domain ?? '').replace(/^\./, '')
      await w.session.cookies.remove(`${c.secure ? 'https' : 'http'}://${host}${c.path ?? '/'}`, c.name).catch(() => {})
    }
    w.activeTab?.wake().reloadIgnoringCache()
  }

  private settingsModel(): SettingsModel {
    const s = getSettings()
    const updated = this.browser.blocker.lastUpdated
    const extensions = this.browser.profile.extensions.getAllExtensions()
    return {
      version: app.getVersion(),
      sections: [
        {
          id: 'appearance',
          title: 'Appearance',
          controls: [
            {
              kind: 'select',
              key: 'theme',
              label: 'Theme',
              description: 'System follows your Windows light/dark setting.',
              value: s.theme,
              options: [
                { value: 'system', label: 'System' },
                { value: 'dark', label: 'Dark' },
                { value: 'light', label: 'Light' },
              ],
            },
            { kind: 'toggle', key: 'showBookmarksBar', label: 'Show bookmarks bar', description: 'Ctrl+Shift+B', value: s.showBookmarksBar },
          ],
        },
        {
          id: 'search',
          title: 'Search',
          controls: [
            {
              kind: 'select',
              key: 'searchEngine',
              label: 'Search engine',
              description: 'Used when you type something that isn\'t an address.',
              value: s.searchEngine,
              options: SEARCH_ENGINES.map(([label, url]) => ({ value: url, label })),
            },
          ],
        },
        {
          id: 'speed',
          title: 'Speed & memory',
          controls: [
            {
              kind: 'select',
              key: 'discardAfterMinutes',
              label: 'Put idle tabs to sleep after',
              description: 'Sleeping tabs use no memory and wake when you click them.',
              value: String(s.discardAfterMinutes),
              options: SLEEP_OPTIONS.map(([label, minutes]) => ({ value: String(minutes), label })),
            },
            { kind: 'toggle', key: 'memoryPressure', label: 'Sleep tabs when memory runs low', value: s.memoryPressureFreeMB > 0 },
            { kind: 'toggle', key: 'sleepPinnedTabs', label: 'Let pinned tabs sleep', value: s.sleepPinnedTabs },
            { kind: 'button', action: 'sleepAll', label: 'Sleep now', description: 'Put every background tab to sleep.' },
          ],
        },
        {
          id: 'privacy',
          title: 'Privacy & blocking',
          controls: [
            { kind: 'toggle', key: 'blocking.enabled', label: 'Block ads and trackers', description: 'Turn off for one site from the shield next to the address bar.', value: s.blocking.enabled },
            { kind: 'toggle', key: 'blocking.cookieBanners', label: 'Hide cookie banners', value: s.blocking.cookieBanners },
            { kind: 'toggle', key: 'privacy.globalPrivacyControl', label: 'Ask sites not to sell or share my data', description: 'Sends the Global Privacy Control signal.', value: s.privacy.globalPrivacyControl },
            {
              kind: 'button',
              action: 'updateFilters',
              label: 'Update',
              description: `Filter lists ${updated ? `updated ${new Date(updated).toLocaleString()}` : 'not downloaded yet'}. They also update daily.`,
            },
          ],
        },
        {
          id: 'clear',
          title: 'Clear browsing data',
          controls: [
            { kind: 'button', action: 'clearCache', label: 'Clear cache', description: this.lastCleared.cache ?? 'Remove saved copies of pages and images. Sites load fresh; you stay signed in.' },
            {
              kind: 'button',
              action: 'clearSiteData',
              label: 'Clear',
              style: 'danger',
              description: this.lastCleared.site ?? 'Cookies and site data for every site. Signs you out of websites; extensions keep their data.',
            },
          ],
        },
        {
          id: 'startup',
          title: 'Startup & home',
          controls: [
            { kind: 'toggle', key: 'restoreSession', label: 'Reopen my tabs when Zirtola starts', value: s.restoreSession },
            { kind: 'toggle', key: 'showHomeButton', label: 'Show home button', description: 'Next to reload. Alt+Home also goes home.', value: s.showHomeButton },
            {
              kind: 'text',
              key: 'homepage',
              label: 'Homepage',
              description: 'Empty opens a blank page.',
              value: s.homepage === 'about:blank' ? '' : s.homepage,
              placeholder: 'Blank page',
            },
            { kind: 'button', action: 'homepageCurrent', label: 'Use current page', description: 'Make the page you\'re on your homepage.' },
            { kind: 'button', action: 'makeDefault', label: 'Make default', description: 'Open links from other apps in Zirtola.' },
          ],
        },
        {
          id: 'bookmarks',
          title: 'Bookmarks',
          controls: [
            { kind: 'button', action: 'importFirefox', label: 'Import', description: 'Import bookmarks from Firefox (icons and folders included).', style: 'primary' },
            { kind: 'button', action: 'importHtml', label: 'Import file', description: 'Import a bookmarks HTML file from any browser.' },
            { kind: 'button', action: 'exportHtml', label: 'Export', description: 'Save all bookmarks as an HTML file.' },
          ],
        },
        {
          id: 'extensions',
          title: 'Extensions',
          controls: [
            ...extensions.map((e) => ({ kind: 'info' as const, label: e.name, value: e.version })),
            ...(extensions.length ? [] : [{ kind: 'info' as const, label: 'No extensions installed', value: '' }]),
            { kind: 'button', action: 'getExtensions', label: 'Browse', description: 'Install extensions from the Chrome Web Store.' },
            { kind: 'button', action: 'installLastPass', label: 'Install', description: 'LastPass password manager' },
            { kind: 'button', action: 'copyExtensionDiagnostics', label: 'Copy', description: 'Extension diagnostics, for reporting a problem with an extension.' },
          ],
        },
        {
          id: 'claude',
          title: 'Claude',
          controls: [
            {
              kind: 'toggle',
              key: 'mcp.enabled',
              label: 'Let Claude control Zirtola',
              description: this.mcp.running
                ? `Running on 127.0.0.1:${s.mcp.port}. Only apps with your secret token can connect.`
                : 'Starts a local MCP server that Claude Code or Claude Desktop can connect to.',
              value: s.mcp.enabled,
            },
            { kind: 'button', action: 'copyMcpCommand', label: 'Copy', description: 'Copy the "claude mcp add" command (contains your secret token).' },
            { kind: 'toggle', key: 'mcp.allowEvaluate', label: 'Allow Claude to run JavaScript in pages', value: s.mcp.allowEvaluate },
            { kind: 'toggle', key: 'mcp.allowIncognito', label: 'Allow Claude in private windows', value: s.mcp.allowIncognito },
            { kind: 'button', action: 'regenerateToken', label: 'Reset', description: 'Make a new secret token (disconnects existing connections).', style: 'danger' },
          ],
        },
        {
          id: 'updates',
          title: 'Updates',
          controls: [
            { kind: 'info', label: 'Version', value: app.getVersion() },
            { kind: 'toggle', key: 'checkForUpdatesOnStartup', label: 'Check for updates automatically', value: s.checkForUpdatesOnStartup },
            { kind: 'button', action: 'checkUpdates', label: 'Check now', description: 'Look for a newer version of Zirtola.', style: 'primary' },
          ],
        },
      ],
    }
  }

  private async applySetting(key: string, value: unknown): Promise<void> {
    const bool = value === true
    switch (key) {
      case 'theme':
        if (value === 'system' || value === 'dark' || value === 'light') {
          updateSettings((s) => (s.theme = value))
          nativeTheme.themeSource = value
        }
        break
      case 'showBookmarksBar':
        if (getSettings().showBookmarksBar !== bool) this.bookmarkUi.toggleBar()
        break
      case 'searchEngine':
        if (typeof value === 'string' && SEARCH_ENGINES.some(([, url]) => url === value)) updateSettings((s) => (s.searchEngine = value))
        break
      case 'discardAfterMinutes':
        updateSettings((s) => (s.discardAfterMinutes = Number(value) || 0))
        break
      case 'memoryPressure':
        updateSettings((s) => (s.memoryPressureFreeMB = bool ? 800 : 0))
        break
      case 'sleepPinnedTabs':
        updateSettings((s) => (s.sleepPinnedTabs = bool))
        break
      case 'blocking.enabled':
        updateSettings((s) => (s.blocking.enabled = bool))
        break
      case 'blocking.cookieBanners':
        updateSettings((s) => (s.blocking.cookieBanners = bool))
        this.browser.blocker.refresh().catch(() => {})
        break
      case 'privacy.globalPrivacyControl':
        updateSettings((s) => (s.privacy.globalPrivacyControl = bool))
        break
      case 'showHomeButton':
        updateSettings((s) => (s.showHomeButton = bool))
        break
      case 'homepage': {
        const text = typeof value === 'string' ? value.trim() : ''
        const url = text ? toNavigableURL(text, getSettings().searchEngine) : ''
        if (url !== null) updateSettings((s) => (s.homepage = url))
        break
      }
      case 'restoreSession':
        updateSettings((s) => (s.restoreSession = bool))
        break
      case 'checkForUpdatesOnStartup':
        updateSettings((s) => (s.checkForUpdatesOnStartup = bool))
        break
      case 'mcp.enabled':
        await this.setMcpEnabled(bool)
        break
      case 'mcp.allowEvaluate':
        updateSettings((s) => (s.mcp.allowEvaluate = bool))
        break
      case 'mcp.allowIncognito':
        updateSettings((s) => (s.mcp.allowIncognito = bool))
        break
    }
    for (const win of this.browser.windows.values()) win.pushState()
  }

  private runAction(w: BrowserWindowController, name: string): void {
    const refresh = () => w.popup.updateSettings(this.settingsModel())
    switch (name) {
      case 'clearCache':
        void this.clearCache(w).then(refresh)
        return
      case 'clearSiteData':
        void this.clearAllSiteData(w)
        return
      case 'sleepAll':
        for (const t of this.browser.allTabs()) if (t.canDiscard({ sleepPinned: true })) t.discard()
        return
      case 'updateFilters':
        this.browser.blocker
          .refresh()
          .then(refresh)
          .catch((err) => dialog.showErrorBox('Filter list update failed', String(err)))
        return
      case 'makeDefault':
        return makeDefaultBrowser()
      case 'importFirefox':
        w.popup.close()
        return void this.bookmarkUi.importFromFirefox(w)
      case 'importHtml':
        w.popup.close()
        return void this.bookmarkUi.importFromHtml(w)
      case 'exportHtml':
        w.popup.close()
        return void this.bookmarkUi.exportHtml(w)
      case 'getExtensions':
        w.popup.close()
        return this.openInNormalWindow(w, CHROME_WEB_STORE_URL)
      case 'installLastPass':
        w.popup.close()
        return this.openInNormalWindow(w, LASTPASS_URL)
      case 'homepageCurrent': {
        const url = w.activeTab?.url
        if (url && /^https?:/.test(url)) {
          updateSettings((s) => (s.homepage = url))
          refresh()
        }
        return
      }
      case 'copyExtensionDiagnostics':
        clipboard.writeText(diagnosticsText(this.browser.profile))
        return
      case 'copyMcpCommand':
        clipboard.writeText(BrowserMcpServer.connectCommand())
        return
      case 'regenerateToken':
        updateSettings((x) => (x.mcp.token = ''))
        BrowserMcpServer.ensureToken()
        if (this.mcp.running) void this.mcp.stop().then(() => this.mcp.start())
        return
      case 'checkUpdates':
        w.popup.close()
        return void checkForUpdates({ interactive: true })
    }
  }

  /** The shield button: per-site and global ad/tracker blocking controls. */
  showShieldMenu(w: BrowserWindowController, x: number, y: number): void {
    const tab = w.activeTab
    if (!tab) return
    const blocker = this.browser.blocker
    const s = getSettings()
    const site = AdBlocker.siteOf(tab.url)
    const updated = blocker.lastUpdated
    const refreshAll = () => {
      for (const win of this.browser.windows.values()) win.pushState()
    }
    const template: MenuItemConstructorOptions[] = [
      {
        label: !s.blocking.enabled
          ? 'Ad & tracker blocking is off'
          : !blocker.ready
            ? 'Downloading filter lists…'
            : `${tab.blockedCount} ads & trackers blocked on this page`,
        enabled: false,
      },
      { type: 'separator' },
      {
        label: site ? `Block on ${site}` : 'Block on this site',
        type: 'checkbox',
        enabled: !!site && s.blocking.enabled,
        checked: !!site && !s.blocking.allowlist.includes(site),
        click: (item) => {
          blocker.setSiteAllowed(tab.url, !item.checked)
          tab.wake().reload()
          refreshAll()
        },
      },
      { type: 'separator' },
      {
        label: 'Block ads & trackers on all sites',
        type: 'checkbox',
        checked: s.blocking.enabled,
        click: (item) => {
          updateSettings((x) => (x.blocking.enabled = item.checked))
          refreshAll()
        },
      },
      {
        label: 'Hide cookie banners',
        type: 'checkbox',
        checked: s.blocking.cookieBanners,
        click: (item) => {
          updateSettings((x) => (x.blocking.cookieBanners = item.checked))
          blocker.refresh().catch((err) => dialog.showErrorBox('Filter list update failed', String(err)))
        },
      },
      {
        label: 'Send “Do Not Sell or Share” signal (GPC)',
        type: 'checkbox',
        checked: s.privacy.globalPrivacyControl,
        click: (item) => updateSettings((x) => (x.privacy.globalPrivacyControl = item.checked)),
      },
      { type: 'separator' },
      {
        label: site ? `Clear cookies & data for ${site}` : 'Clear data for this site',
        enabled: !!site,
        click: () => void this.clearSiteData(w, tab.url),
      },
      {
        label: updated ? `Update filter lists (last: ${new Date(updated).toLocaleDateString()})` : 'Update filter lists',
        click: () =>
          blocker
            .refresh()
            .then(refreshAll)
            .catch((err) => dialog.showErrorBox('Filter list update failed', String(err))),
      },
    ]
    w.popup.menu(template, x, y, { align: 'right' })
  }

  showTabMenu(w: BrowserWindowController, tab: Tab, x: number, y: number): void {
    const template: MenuItemConstructorOptions[] = [
      { label: 'New tab to the right', click: () => w.createTab({ index: w.tabs.indexOf(tab) + 1 }) },
      { type: 'separator' },
      { label: 'Reload', click: () => tab.wake().reload() },
      { label: 'Duplicate', click: () => w.createTab({ url: tab.url, index: w.tabs.indexOf(tab) + 1 }) },
      {
        label: tab.pinned ? 'Unpin' : 'Pin',
        click: () => {
          tab.pinned = !tab.pinned
          // Pinned tabs live at the start of the strip.
          w.tabs.splice(w.tabs.indexOf(tab), 1)
          const firstUnpinned = w.tabs.findIndex((t) => !t.pinned)
          w.tabs.splice(firstUnpinned === -1 ? w.tabs.length : firstUnpinned, 0, tab)
          w.onTabStateChanged(tab)
        },
      },
      {
        label: tab.muted ? 'Unmute site' : 'Mute site',
        click: () => {
          tab.muted = !tab.muted
          tab.webContents?.setAudioMuted(tab.muted)
          w.pushState()
        },
      },
      {
        label: 'Sleep this tab',
        enabled: tab.canDiscard({ sleepPinned: true }),
        click: () => tab.discard(),
      },
      { type: 'separator' },
      { label: 'Close', accelerator: 'CmdOrCtrl+W', click: () => w.closeTab(tab) },
      {
        label: 'Close other tabs',
        click: () => {
          for (const t of [...w.tabs]) if (t !== tab && !t.pinned) w.closeTab(t)
        },
      },
      {
        label: 'Close tabs to the right',
        click: () => {
          for (const t of w.tabs.slice(w.tabs.indexOf(tab) + 1)) if (!t.pinned) w.closeTab(t)
        },
      },
    ]
    w.popup.menu(template, x, y)
  }

  private installedExtensionItems(): MenuItemConstructorOptions[] {
    const all = this.browser.profile.extensions.getAllExtensions()
    if (all.length === 0) return [{ label: 'No extensions installed', enabled: false }]
    return all.map((ext) => ({
      label: `${ext.name} ${ext.version}`,
      submenu: [
        {
          label: 'Options',
          enabled: !!ext.manifest.options_ui?.page || !!ext.manifest.options_page,
          click: () => {
            const page = ext.manifest.options_ui?.page ?? ext.manifest.options_page
            if (page) this.openInNormalWindow(this.current(), `${ext.url}${page}`)
          },
        },
        {
          label: 'Remove…',
          click: async () => {
            const { response } = await dialog.showMessageBox({
              type: 'warning',
              buttons: ['Remove', 'Cancel'],
              defaultId: 1,
              cancelId: 1,
              message: `Remove ${ext.name}?`,
            })
            if (response !== 0) return
            const { uninstallExtension } = await import('electron-chrome-web-store')
            await uninstallExtension(ext.id, { session: this.browser.profile })
          },
        },
      ],
    }))
  }

  private openInNormalWindow(w: BrowserWindowController | undefined, url: string): void {
    const target = w && !w.incognito ? w : this.browser.targetWindow()
    target.createTab({ url })
    target.win.focus()
  }

  async setMcpEnabled(enabled: boolean): Promise<void> {
    updateSettings((x) => (x.mcp.enabled = enabled))
    try {
      if (enabled) {
        await this.mcp.start()
        const choice = await dialog.showMessageBox({
          type: 'info',
          buttons: ['Copy connect command', 'Close'],
          defaultId: 0,
          message: `MCP server running at http://127.0.0.1:${getSettings().mcp.port}/mcp`,
          detail: 'To connect Claude Code, copy the command and run it in a terminal. It includes your secret token.',
        })
        if (choice.response === 0) clipboard.writeText(BrowserMcpServer.connectCommand())
      } else {
        await this.mcp.stop()
      }
    } catch (err) {
      updateSettings((x) => (x.mcp.enabled = false))
      dialog.showErrorBox('Could not start MCP server', err instanceof Error ? err.message : String(err))
    }
    for (const w of this.browser.windows.values()) w.pushState()
  }
}

function zoom(tab: Tab, delta: number): void {
  const wc = tab.webContents
  if (wc) wc.setZoomLevel(Math.max(-8, Math.min(9, wc.getZoomLevel() + delta)))
}
