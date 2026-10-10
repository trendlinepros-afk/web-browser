import { app, BrowserWindow, clipboard, dialog, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import type { Browser } from './browser'
import type { BrowserWindowController } from './window'
import type { Tab } from './tab'
import { BrowserMcpServer } from './mcp-server'
import type { TabSleeper } from './tab-sleeper'
import { getSettings, updateSettings } from './settings'
import { checkForUpdates } from './updater'
import { AdBlocker } from './blocker'
import { CHROME_WEB_STORE_URL, LASTPASS_URL, updateAllExtensions } from './extensions'

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
  constructor(
    private readonly browser: Browser,
    private readonly mcp: BrowserMcpServer,
    private readonly sleeper: TabSleeper,
  ) {
    browser.onShowAppMenu = (w, x, y) => this.showAppMenu(w, x, y)
    browser.onShowTabMenu = (w, tab) => this.showTabMenu(w, tab)
    browser.onShowShieldMenu = (w, x, y) => this.showShieldMenu(w, x, y)
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
            label: 'New Incognito Window',
            accelerator: 'CmdOrCtrl+Shift+N',
            click: () => this.browser.createWindow({ incognito: true }),
          },
          { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: this.withWindow((w) => this.browser.reopenClosedTab(w)) },
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

  /** The ☰ menu in the toolbar. */
  showAppMenu(w: BrowserWindowController, x: number, y: number): void {
    const s = getSettings()
    const template: MenuItemConstructorOptions[] = [
      { label: 'New tab', accelerator: 'CmdOrCtrl+T', click: () => w.createTab() },
      { label: 'New window', accelerator: 'CmdOrCtrl+N', click: () => this.browser.createWindow() },
      { label: 'New incognito window', accelerator: 'CmdOrCtrl+Shift+N', click: () => this.browser.createWindow({ incognito: true }) },
      { type: 'separator' },
      {
        label: 'Extensions',
        submenu: [
          { label: 'Get extensions (Chrome Web Store)', click: () => this.openInNormalWindow(w, CHROME_WEB_STORE_URL) },
          { label: 'Install LastPass', click: () => this.openInNormalWindow(w, LASTPASS_URL) },
          { type: 'separator' },
          ...this.installedExtensionItems(),
          { type: 'separator' },
          {
            label: 'Update extensions now',
            click: () => updateAllExtensions(this.browser).catch((err) => dialog.showErrorBox('Extension update failed', String(err))),
          },
        ],
      },
      {
        label: 'Claude (MCP)',
        submenu: [
          {
            label: this.mcp.running ? `MCP server running on port ${s.mcp.port}` : 'MCP server is off',
            enabled: false,
          },
          {
            label: 'Enable MCP server',
            type: 'checkbox',
            checked: s.mcp.enabled,
            click: (item) => this.setMcpEnabled(item.checked),
          },
          {
            label: 'Copy "claude mcp add" command',
            click: () => {
              clipboard.writeText(BrowserMcpServer.connectCommand())
              dialog.showMessageBox(w.win, {
                type: 'info',
                message: 'Copied to clipboard.',
                detail: 'Paste it in a terminal to connect Claude Code. It contains a secret token; treat it like a password.',
              })
            },
          },
          {
            label: 'Regenerate token',
            click: async () => {
              updateSettings((x) => (x.mcp.token = ''))
              BrowserMcpServer.ensureToken()
              if (this.mcp.running) {
                await this.mcp.stop()
                await this.mcp.start()
              }
            },
          },
          { type: 'separator' },
          {
            label: 'Allow Claude to run JavaScript (evaluate)',
            type: 'checkbox',
            checked: s.mcp.allowEvaluate,
            click: (item) => updateSettings((x) => (x.mcp.allowEvaluate = item.checked)),
          },
          {
            label: 'Allow Claude in incognito windows',
            type: 'checkbox',
            checked: s.mcp.allowIncognito,
            click: (item) => updateSettings((x) => (x.mcp.allowIncognito = item.checked)),
          },
        ],
      },
      {
        label: 'Settings',
        submenu: [
          {
            label: 'Search engine',
            submenu: SEARCH_ENGINES.map(([label, url]) => ({
              label,
              type: 'radio' as const,
              checked: s.searchEngine === url,
              click: () => updateSettings((x) => (x.searchEngine = url)),
            })),
          },
          {
            label: 'Sleep inactive tabs after',
            submenu: SLEEP_OPTIONS.map(([label, minutes]) => ({
              label,
              type: 'radio' as const,
              checked: s.discardAfterMinutes === minutes,
              click: () => updateSettings((x) => (x.discardAfterMinutes = minutes)),
            })),
          },
          {
            label: 'Sleep tabs when memory is low',
            type: 'checkbox',
            checked: s.memoryPressureFreeMB > 0,
            click: (item) => updateSettings((x) => (x.memoryPressureFreeMB = item.checked ? 800 : 0)),
          },
          {
            label: 'Allow pinned tabs to sleep',
            type: 'checkbox',
            checked: s.sleepPinnedTabs,
            click: (item) => updateSettings((x) => (x.sleepPinnedTabs = item.checked)),
          },
          {
            label: 'Sleep all background tabs now',
            click: () => {
              for (const t of this.browser.allTabs()) if (t.canDiscard({ sleepPinned: true })) t.discard()
              this.sleeper.check()
            },
          },
          { type: 'separator' },
          {
            label: 'Restore tabs on startup',
            type: 'checkbox',
            checked: s.restoreSession,
            click: (item) => updateSettings((x) => (x.restoreSession = item.checked)),
          },
          {
            label: 'Check for updates on startup',
            type: 'checkbox',
            checked: s.checkForUpdatesOnStartup,
            click: (item) => updateSettings((x) => (x.checkForUpdatesOnStartup = item.checked)),
          },
        ],
      },
      { type: 'separator' },
      { label: 'Check for updates…', click: () => checkForUpdates({ interactive: true }) },
      { label: `About (v${app.getVersion()})`, click: () => shell.openExternal(REPO_URL) },
      { type: 'separator' },
      { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
    ]
    Menu.buildFromTemplate(template).popup({ window: w.win, x: Math.round(x), y: Math.round(y) })
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
        label: updated ? `Update filter lists (last: ${new Date(updated).toLocaleDateString()})` : 'Update filter lists',
        click: () =>
          blocker
            .refresh()
            .then(refreshAll)
            .catch((err) => dialog.showErrorBox('Filter list update failed', String(err))),
      },
    ]
    Menu.buildFromTemplate(template).popup({ window: w.win, x: Math.round(x), y: Math.round(y) })
  }

  showTabMenu(w: BrowserWindowController, tab: Tab): void {
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
    Menu.buildFromTemplate(template).popup({ window: w.win })
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
