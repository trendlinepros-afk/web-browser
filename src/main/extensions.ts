import { session } from 'electron'
import { ElectronChromeExtensions } from 'electron-chrome-extensions'
import { installChromeWebStore, updateExtensions } from 'electron-chrome-web-store'
import path from 'node:path'
import type { Browser } from './browser'
import { ExtensionApis } from './extension-apis'

export const CHROME_WEB_STORE_URL = 'https://chromewebstore.google.com/'
export const LASTPASS_URL = 'https://chromewebstore.google.com/detail/lastpass-free-password-ma/hdokiejnpimakedhajhdlcegeplioahd'

/**
 * Chrome extension support for the main (non-incognito) profile:
 *  - electron-chrome-extensions implements chrome.tabs/windows/action/contextMenus/… on top of our tabs
 *  - electron-chrome-web-store lets "Add to Chrome" work on the Chrome Web Store and keeps extensions updated
 */
export async function setupExtensions(browser: Browser): Promise<ElectronChromeExtensions> {
  const ses = browser.profile

  // The extension toolbar in our UI (default session) loads icons via crx://.
  ElectronChromeExtensions.handleCRXProtocol(session.defaultSession)

  // Our chrome.alarms / chrome.identity must be installed before electron-chrome-extensions'
  // service-worker preload runs, because it freezes `chrome`.
  ses.registerPreloadScript({
    id: 'zirtola-ext-apis',
    type: 'service-worker',
    filePath: path.join(__dirname, '..', 'preload', 'extension-sw-preload.js'),
  })
  browser.extensionApis = new ExtensionApis(ses)

  const extensions = new ElectronChromeExtensions({
    license: 'GPL-3.0',
    session: ses,

    async createTab(details) {
      const target = details.windowId ? browser.windows.get(details.windowId) : undefined
      const w = target && !target.incognito ? target : browser.targetWindow()
      const tab = w.createTab({ url: details.url, background: details.active === false, index: details.index })
      return [tab.wake(), w.win]
    },
    selectTab(wc) {
      const tab = browser.findTabByWebContents(wc)
      tab?.window.activateTab(tab)
    },
    removeTab(wc) {
      const tab = browser.findTabByWebContents(wc)
      tab?.window.closeTab(tab)
    },
    async createWindow(details) {
      const url = Array.isArray(details.url) ? details.url[0] : details.url
      const w = browser.createWindow({ url })
      if (details.width && details.height) w.win.setSize(details.width, details.height)
      if (details.left !== undefined && details.top !== undefined) w.win.setPosition(details.left, details.top)
      return w.win
    },
    removeWindow(win) {
      ;(win as Electron.BrowserWindow).close()
    },
    assignTabDetails(details, wc) {
      const tab = browser.findTabByWebContents(wc)
      if (!tab) return
      details.pinned = tab.pinned
      details.discarded = false
      details.autoDiscardable = true
    },
  })

  // Extension popups (e.g. the LastPass vault popup) should get focus right away.
  extensions.on('browser-action-popup-created', (popup: { browserWindow?: Electron.BrowserWindow }) => {
    popup.browserWindow?.focus()
  })

  await installChromeWebStore({ session: ses, autoUpdate: true })
  return extensions
}

export async function updateAllExtensions(browser: Browser): Promise<void> {
  await updateExtensions(browser.profile)
}
