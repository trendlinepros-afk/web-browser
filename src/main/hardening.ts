import { app, type WebContents } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Guards for Zirtola's own pages (tab strip and toolbar, menus and settings, dialogs). They run
 * with privileged APIs, so they must only ever show Zirtola's own files:
 *  - no navigating away (dropping a link or file onto the toolbar would otherwise load a web
 *    page into the privileged UI window, with the browser's control API exposed to it),
 *  - no opening new windows,
 *  - and no <webview> anywhere.
 */
const RENDERER_DIR = path.join(__dirname, '..', 'renderer')

function isOwnPage(url: string): boolean {
  if (!url.startsWith('file:')) return false
  try {
    const file = fileURLToPath(url)
    return file === RENDERER_DIR || file.startsWith(RENDERER_DIR + path.sep)
  } catch {
    return false
  }
}

export function installHardening(): void {
  app.on('web-contents-created', (_e, wc: WebContents) => {
    wc.on('will-attach-webview', (e) => e.preventDefault())
    const guard = (e: Electron.Event, url: string) => {
      if (isOwnPage(wc.getURL()) && !isOwnPage(url)) e.preventDefault()
    }
    wc.on('will-navigate', guard)
    wc.on('will-redirect', guard)
    wc.on('will-frame-navigate', (e) => {
      if (isOwnPage(wc.getURL()) && !isOwnPage(e.url)) e.preventDefault()
    })
  })
}

/** For windows Zirtola creates for its own pages: they never open other windows. */
export function denyWindowOpen(wc: WebContents): void {
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
}
