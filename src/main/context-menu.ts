import { clipboard, Menu, type MenuItem, type MenuItemConstructorOptions, type WebContents } from 'electron'
import type { Tab } from './tab'
import { getSettings } from './settings'
import { isMagnet, isTorrentURL } from './torrents'

/**
 * Links and images the page offers that "Open in new tab/window" may open. The page picks these URLs,
 * and opening them from the menu skips the rules for the page's own navigations, so local files,
 * extension pages and internal pages only open from a page of the same kind (a local page linking to
 * another local file, an extension page to its own pages).
 */
function openable(url: string, pageUrl: string): boolean {
  try {
    const target = new URL(url)
    if (/^(https?|blob):$/.test(target.protocol)) return true
    if (target.protocol === 'data:') return /^data:image\//i.test(url)
    const page = new URL(pageUrl)
    if (target.protocol === 'file:') return page.protocol === 'file:'
    if (target.protocol === 'chrome-extension:') return page.protocol === 'chrome-extension:' && page.host === target.host
    return false
  } catch {
    return false
  }
}

export function attachContextMenu(tab: Tab, wc: WebContents): void {
  wc.on('context-menu', (_event, params) => {
    const window = tab.window
    const browser = window.browser
    const items: (MenuItemConstructorOptions | MenuItem)[] = []
    const sep = () => {
      if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' })
    }

    if (params.linkURL && (isMagnet(params.linkURL) || isTorrentURL(params.linkURL))) {
      items.push({ label: 'Send to Deluge', click: () => browser.torrents.sendLink(params.linkURL, wc.session, window) })
    }
    if (params.linkURL && isMagnet(params.linkURL)) {
      items.push({ label: 'Copy magnet link', click: () => clipboard.writeText(params.linkURL) })
      sep()
    } else if (params.linkURL && openable(params.linkURL, params.pageURL)) {
      items.push(
        { label: 'Open link in new tab', click: () => window.createTab({ url: params.linkURL, background: true }) },
        { label: 'Open link in new window', click: () => browser.createWindow({ incognito: tab.incognito, url: params.linkURL }) },
        { label: 'Open link in private window', click: () => browser.createWindow({ incognito: true, url: params.linkURL }) },
        { label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) },
      )
      sep()
    }

    if (params.mediaType === 'image' && params.srcURL && openable(params.srcURL, params.pageURL)) {
      items.push(
        { label: 'Open image in new tab', click: () => window.createTab({ url: params.srcURL, background: true }) },
        { label: 'Save image as…', click: () => wc.downloadURL(params.srcURL) },
        { label: 'Copy image', click: () => wc.copyImageAt(params.x, params.y) },
        { label: 'Copy image address', click: () => clipboard.writeText(params.srcURL) },
      )
      sep()
    }

    if (params.isEditable) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
        items.push({ label: suggestion, click: () => wc.replaceMisspelling(suggestion) })
      }
      if (params.misspelledWord) {
        items.push({
          label: 'Add to dictionary',
          click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord),
        })
        sep()
      }
      items.push(
        { role: 'undo', enabled: params.editFlags.canUndo },
        { role: 'redo', enabled: params.editFlags.canRedo },
        { type: 'separator' },
        { role: 'cut', enabled: params.editFlags.canCut },
        { role: 'copy', enabled: params.editFlags.canCopy },
        { role: 'paste', enabled: params.editFlags.canPaste },
        { role: 'pasteAndMatchStyle', enabled: params.editFlags.canPaste },
        { role: 'selectAll' },
      )
      sep()
    } else if (params.selectionText.trim()) {
      const text = params.selectionText.trim()
      const short = text.length > 30 ? `${text.slice(0, 30)}…` : text
      items.push(
        { role: 'copy' },
        {
          label: `Search for “${short}”`,
          click: () =>
            window.createTab({ url: getSettings().searchEngine.replace('%s', encodeURIComponent(text)) }),
        },
      )
      sep()
    }

    if (!params.linkURL && !params.isEditable && !params.selectionText.trim() && params.mediaType === 'none') {
      items.push(
        { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
        { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
        { label: 'Reload', click: () => wc.reload() },
        { type: 'separator' },
        { label: 'Save page as…', click: () => wc.downloadURL(wc.getURL()) },
        { label: 'Print…', click: () => wc.print() },
        { label: 'View page source', click: () => window.createTab({ url: `view-source:${wc.getURL()}` }) },
      )
      sep()
    }

    // Items registered by extensions (e.g. LastPass "fill" menus).
    if (!tab.incognito && browser.extensions) {
      const extensionItems = browser.extensions.getContextMenuItems(wc, params)
      if (extensionItems.length) {
        items.push(...extensionItems)
        sep()
      }
    }

    items.push({ label: 'Inspect', click: () => wc.inspectElement(params.x, params.y) })
    // Page coordinates → window coordinates (the page sits inside a card below the toolbar).
    const bounds = tab.view?.getBounds() ?? { x: 0, y: 0 }
    window.popup.menu(items, params.x + bounds.x, params.y + bounds.y, { target: wc })
  })
}
