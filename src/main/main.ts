import { app, BrowserWindow, session } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Browser } from './browser'
import { setupExtensions } from './extensions'
import { TabSleeper } from './tab-sleeper'
import { BrowserMcpServer } from './mcp-server'
import { Menus } from './menu'
import { checkForUpdates } from './updater'
import { offerDefaultBrowserOnce } from './default-browser'
import { flushSettings, getSettings } from './settings'
import { applyCommandLineHardening } from './privacy'
import { migrateLegacyProfile } from './profile-migration'

// ---- Process-wide tuning (must run before 'ready') ------------------------

applyCommandLineHardening()

/**
 * Present a plain Chrome user agent. Electron's default ("… Electron/x AppName/y …") gets
 * blocked by some sign-in pages (notably Google) and the Chrome Web Store.
 */
function chromeUserAgent(): string {
  const major = process.versions.chrome.split('.')[0]
  const platform =
    process.platform === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : process.platform === 'darwin'
        ? 'Macintosh; Intel Mac OS X 10_15_7'
        : 'X11; Linux x86_64'
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
}
app.userAgentFallback = chromeUserAgent()

migrateLegacyProfile()

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  main()
}

/** Links and local pages passed on the command line (e.g. clicking a link when Zirtola is the default browser). */
function urlsFromArgv(argv: string[]): string[] {
  const out: string[] = []
  for (const arg of argv.slice(1)) {
    if (/^(https?|file):\/\//i.test(arg)) out.push(arg)
    else if (/\.(x?html?|shtml|pdf|svg)$/i.test(arg) && fs.existsSync(arg)) out.push(pathToFileURL(path.resolve(arg)).href)
  }
  return out
}

function main(): void {
  let browser: Browser | null = null
  let sleeper: TabSleeper | null = null
  let mcp: BrowserMcpServer | null = null

  app.on('second-instance', (_e, argv) => {
    if (!browser) return
    const urls = urlsFromArgv(argv)
    if (urls.length === 0) {
      const w = browser.lastFocused ?? browser.createWindow()
      if (w.win.isMinimized()) w.win.restore()
      w.win.focus()
    }
    for (const url of urls) browser.targetWindow().createTab({ url })
  })

  app.whenReady().then(async () => {
    session.defaultSession.setUserAgent(chromeUserAgent())
    browser = new Browser()
    browser.profile.setUserAgent(chromeUserAgent())

    // Extensions must be ready before tabs exist so content scripts inject into restored tabs.
    try {
      browser.extensions = await setupExtensions(browser)
    } catch (err) {
      console.error('Extension support failed to initialise:', err)
    }

    browser.blocker.start().catch((err) => console.error('Ad blocker failed to start:', err))

    sleeper = new TabSleeper(browser)
    mcp = new BrowserMcpServer(browser)
    browser.mcpEnabled = () => mcp?.running ?? false
    const menus = new Menus(browser, mcp, sleeper)
    menus.installApplicationMenu()

    browser.start(urlsFromArgv(process.argv))
    sleeper.start()

    if (getSettings().mcp.enabled) {
      mcp.start().catch((err) => console.error('MCP server failed to start:', err))
    }
    const first = browser.lastFocused
    if (first) setTimeout(() => offerDefaultBrowserOnce(first.win).catch(() => {}), 3000)
    if (getSettings().checkForUpdatesOnStartup) {
      setTimeout(() => checkForUpdates({ interactive: false }), 10_000)
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) browser?.createWindow()
    })
  })

  app.on('before-quit', () => {
    browser?.freezeSession()
    sleeper?.stop()
    mcp?.stop().catch(() => {})
    flushSettings()
    browser?.bookmarks.flush()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
