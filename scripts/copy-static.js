// Copies non-TypeScript UI assets (HTML/CSS) into dist/.
const fs = require('node:fs')
const path = require('node:path')

const src = path.join(__dirname, '..', 'src', 'renderer')
const out = path.join(__dirname, '..', 'dist', 'renderer')
fs.mkdirSync(out, { recursive: true })
for (const file of fs.readdirSync(src)) {
  if (file.endsWith('.html') || file.endsWith('.css') || file.endsWith('.png')) {
    fs.copyFileSync(path.join(src, file), path.join(out, file))
  }
}

// The browser UI runs sandboxed, and a sandboxed preload can only require('electron'). Inline the one
// other module it uses (electron-chrome-extensions' toolbar element, which itself needs only electron).
const uiPreload = path.join(__dirname, '..', 'dist', 'preload', 'ui-preload.js')
const browserAction = fs.readFileSync(require.resolve('electron-chrome-extensions/browser-action'), 'utf8')
const call = 'require("electron-chrome-extensions/browser-action")'
const code = fs.readFileSync(uiPreload, 'utf8')
if (!code.includes(call)) throw new Error(`ui-preload.js no longer contains ${call}: update scripts/copy-static.js`)
if (/require\((?!["']electron["'])/.test(browserAction)) throw new Error('browser-action now requires more than electron')
fs.writeFileSync(uiPreload, code.replace(call, `(() => {\nconst module = { exports: {} }, exports = module.exports;\n${browserAction}\nreturn module.exports\n})()`))
