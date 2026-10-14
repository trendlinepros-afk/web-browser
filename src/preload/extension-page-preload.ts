// Runs in extension pages (popups, options, offscreen documents). Chromium exposes the extension
// APIs both as `chrome` and as a separate `browser` object, and only `chrome` gets
// electron-chrome-extensions' additions (windows, tabs, action, …). Extensions that prefer
// `browser` (LastPass) then find pieces missing, so `browser` is pointed at `chrome`.
const { contextBridge, webFrame } = require('electron') as typeof import('electron')

if (location.protocol === 'chrome-extension:') {
  const alias = () => {
    const d = Object.getOwnPropertyDescriptor(globalThis, 'browser')
    if (!d || d.configurable) {
      Object.defineProperty(globalThis, 'browser', { get: () => (globalThis as { chrome?: unknown }).chrome, configurable: true, enumerable: false })
    }
  }
  if (process.contextIsolated) {
    if ('executeInMainWorld' in contextBridge) contextBridge.executeInMainWorld({ func: alias })
    else void webFrame.executeJavaScript(`(${alias.toString()})()`)
  } else {
    alias()
  }
}
