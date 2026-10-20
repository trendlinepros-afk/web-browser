// Security fixes for bundled dependencies, applied after `npm install` and before every build.
// Each patch must match exactly once (or already be applied); otherwise the build fails, so an
// upgrade that changes the code is noticed instead of silently shipping without the fix.
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..', 'node_modules')

/**
 * electron-chrome-web-store 0.13.0:
 * - its IPC and preload trusted any origin that merely *starts with* https://chromewebstore.google.com,
 *   so a page on chromewebstore.google.com.evil.example could install extensions and call its APIs;
 * - chrome.management.uninstall(id) deleted `Extensions/<id>` with the page's id unchecked, so
 *   "../../x" removed any folder.
 */
const STORE = 'electron-chrome-web-store/dist'
const ID_CHECK = 'if (!/^[a-p]{32}$/.test(String(extensionId))) throw new Error("Invalid extension ID");'
const patches = [
  ...['cjs/browser/index.js', 'esm/browser/index.mjs'].flatMap((file) => [
    {
      file: `${STORE}/${file}`,
      from: 'if (!senderOrigin || !senderOrigin.startsWith(WEBSTORE_URL)) {',
      to: 'if (!senderOrigin || senderOrigin !== WEBSTORE_URL) {',
    },
    {
      file: `${STORE}/${file}`,
      from: 'async function uninstallExtension(extensionId, opts = {}) {\n',
      to: `async function uninstallExtension(extensionId, opts = {}) {\n  ${ID_CHECK}\n`,
    },
  ]),
  {
    file: `${STORE}/chrome-web-store.preload.js`,
    from: 'if (location.href.startsWith("https://chromewebstore.google.com")) {',
    to: 'if (location.origin === "https://chromewebstore.google.com") {',
  },
]

/**
 * electron-chrome-extensions 4.9:
 * - crx-msg / crx-add-listener took the extension ID from the caller, so any extension, or a web page
 *   that took over its renderer, could act as another extension (e.g. LastPass) and use its APIs;
 *   now the ID must match the sender (an extension page, or the extension's service worker), and
 *   crx-msg-remote (used by the toolbar's extension buttons) only accepts Zirtola's own pages and
 *   extension pages;
 * - chrome.cookies worked for every extension, even without the "cookies" permission.
 */
const EXT = 'electron-chrome-extensions/dist'
const SENDER_HELPER = `function zirtolaSenderExtensionId(event) {
  try {
    const url = new URL(event.type === "service-worker" ? event.serviceWorker?.scope : event.senderFrame?.url);
    return url.protocol === "chrome-extension:" ? url.host : null;
  } catch {
    return null;
  }
}
function zirtolaTrustedRemote(event) {
  if (event.type === "service-worker") return true;
  const url = event.senderFrame?.url ?? "";
  return (url.startsWith("file:") && url.includes("/dist/renderer/")) || url.startsWith("chrome-extension:");
}
var RoutingDelegate = class _RoutingDelegate {`
for (const file of ['cjs/index.js', 'esm/index.mjs']) {
  const f = `${EXT}/${file}`
  patches.push(
    { file: f, from: 'var RoutingDelegate = class _RoutingDelegate {', to: SENDER_HELPER },
    {
      file: f,
      from: 'this.onRouterMessage = async (event, extensionId, handlerName, ...args) => {\n',
      to: 'this.onRouterMessage = async (event, extensionId, handlerName, ...args) => {\n      if (zirtolaSenderExtensionId(event) !== extensionId) throw new Error(`${handlerName}: sender is not extension ${extensionId}`);\n',
    },
    {
      file: f,
      from: 'this.onRemoteMessage = async (event, sessionPartition, handlerName, ...args) => {\n',
      to: 'this.onRemoteMessage = async (event, sessionPartition, handlerName, ...args) => {\n      if (!zirtolaTrustedRemote(event)) throw new Error(`${handlerName}: not allowed from this page`);\n',
    },
    {
      file: f,
      from: 'this.onAddListener = (event, extensionId, eventName) => {\n',
      to: 'this.onAddListener = (event, extensionId, eventName) => {\n      if (zirtolaSenderExtensionId(event) !== extensionId) return;\n',
    },
    {
      file: f,
      from: 'this.onRemoveListener = (event, extensionId, eventName) => {\n',
      to: 'this.onRemoveListener = (event, extensionId, eventName) => {\n      if (zirtolaSenderExtensionId(event) !== extensionId) return;\n',
    },
    ...['get', 'getAll', 'set', 'remove'].map((op) => ({
      file: f,
      from: `handle("cookies.${op}", this.${op}.bind(this));`,
      to: `handle("cookies.${op}", this.${op}.bind(this), { permission: "cookies" });`,
    })),
  )
}

let failed = false
for (const { file, from, to } of patches) {
  const full = path.join(root, file)
  const code = fs.readFileSync(full, 'utf8')
  if (code.includes(to)) continue
  const count = code.split(from).length - 1
  if (count !== 1) {
    console.error(`patch-deps: expected 1 match in ${file}, found ${count}: ${from.trim()}`)
    failed = true
    continue
  }
  fs.writeFileSync(full, code.replace(from, to))
  console.log(`patch-deps: patched ${file}`)
}
if (failed) process.exit(1)
