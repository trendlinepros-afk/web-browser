// Renders build/icon.svg to build/icon.png (1024px) with Chromium, so gradients and filters
// render exactly. electron-builder derives the Windows .ico and macOS .icns from the PNG.
// Usage: npx electron scripts/render-icon.js
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.svg'), 'utf8')
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } })
  await win.loadURL(`data:text/html,<style>html,body{margin:0;background:transparent}</style>${encodeURIComponent(svg.replace('<svg ', '<svg width="1024" height="1024" '))}`)
  await new Promise((r) => setTimeout(r, 300))
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })
  fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon.png'), image.resize({ width: 1024, height: 1024 }).toPNG())
  app.quit()
})
