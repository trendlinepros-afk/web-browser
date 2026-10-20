// Security checks for Zirtola. Run with `npm run security` (builds first); CI runs it on every
// release. Starts the real browser on a throwaway profile, serves its own test pages, and checks the
// protections that keep web pages away from your files, your other sites and the browser itself:
// sandboxing, site isolation, navigation and IPC guards, certificate errors, external apps,
// permissions and the MCP server. Any failure exits non-zero.
const { app, BrowserWindow, webContents, ipcMain, shell, session } = require('electron')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')
const os = require('node:os')
const path = require('node:path')

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'zirtola-security-'))
app.setPath('userData', profile)
const MCP_PORT = 47000 + Math.floor(Math.random() * 900)
const MCP_TOKEN = 'security-check-token-' + Math.random().toString(36).slice(2)
fs.writeFileSync(
  path.join(profile, 'settings.json'),
  JSON.stringify({
    askedDefaultBrowser: true,
    checkForUpdatesOnStartup: false,
    restoreSession: false,
    mcp: { enabled: true, port: MCP_PORT, token: MCP_TOKEN, allowEvaluate: false, allowIncognito: false },
  }),
)

// Pages can't open other apps: count every attempt.
const externalOpens = []
shell.openExternal = async (url) => void externalOpens.push(url)

const SECRET = 'zirtola-secret-' + Math.random().toString(36).slice(2)
const pages = {
  '/': '<!doctype html><title>home</title><p>home</p>',
  '/frame': (port) => `<!doctype html><title>frame</title><iframe src="http://localhost:${port}/"></iframe>`,
  '/secret': `<!doctype html><title>secret</title><p>${SECRET}</p>`,
}
const server = http
  .createServer((req, res) => {
    const page = pages[req.url.split('?')[0]] ?? pages['/']
    res.writeHead(200, { 'content-type': 'text/html' }).end(typeof page === 'function' ? page(server.address().port) : page)
  })
  .listen(0, '127.0.0.1')

// An HTTPS server with a self-signed certificate (needs openssl; skipped without it).
let tlsServer = null
try {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zirtola-cert-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' })
  tlsServer = https
    .createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, (_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(pages['/secret']))
    .listen(0, '127.0.0.1')
} catch {
  tlsServer = null
}

require('../../dist/main/main.js')
const { getSettings } = require('../../dist/main/settings.js')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, timeout = 15000, step = 50) {
  const t = Date.now()
  while (Date.now() - t < timeout) {
    if (await fn().catch(() => false)) return true
    await sleep(step)
  }
  return false
}
const results = []
async function check(name, fn) {
  try {
    const detail = await fn()
    if (detail === 'skip') {
      results.push({ name, ok: true, skipped: true })
      console.log(`  skip  ${name}`)
    } else {
      results.push({ name, ok: true })
      console.log(`  pass  ${name}`)
    }
  } catch (err) {
    results.push({ name, ok: false })
    console.log(`  FAIL  ${name}\n        ${err?.message ?? err}`)
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg)
}

const mainWin = () => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html'))
const ui = (js) => mainWin().webContents.executeJavaScript(js)
const tabIds = () => ui(`[...document.querySelectorAll('#tabs .tab')].map(t => Number(t.dataset.id))`)
const webPages = () => webContents.getAllWebContents().filter((w) => /^https?:/.test(w.getURL()))
const pageAt = (prefix) => webContents.getAllWebContents().find((w) => w.getURL().startsWith(prefix))

async function openTab(url) {
  const before = new Set(webContents.getAllWebContents().map((w) => w.id))
  await ui(`window.browser.newTab(${JSON.stringify(url)})`)
  let wc
  await waitFor(async () => {
    wc = webContents.getAllWebContents().find((w) => !before.has(w.id) && w.getType() !== 'backgroundPage' && !/^(file|devtools|chrome-extension):/.test(w.getURL()))
    return !!wc && !wc.isLoading() && wc.getURL() !== ''
  })
  assert(wc, `tab for ${url} didn't open`)
  return wc
}

// node:http rather than fetch(), which won't send a custom Host header.
function mcp(body, headers = {}) {
  const payload = JSON.stringify(body)
  const all = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${MCP_TOKEN}`, host: `127.0.0.1:${MCP_PORT}`, ...headers }
  for (const k of Object.keys(all)) if (all[k] === '') delete all[k]
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: MCP_PORT, path: '/mcp', method: 'POST', headers: { ...all, 'content-length': Buffer.byteLength(payload) } }, (res) => {
      let text = ''
      res.on('data', (d) => (text += d)).on('end', () => {
        const data = text.split('\n').find((l) => l.startsWith('data:'))
        resolve({ status: res.statusCode, json: data ? JSON.parse(data.slice(5)) : text.startsWith('{') ? JSON.parse(text) : null })
      })
    })
    req.on('error', reject)
    req.end(payload)
  })
}
const mcpCall = (name, args) => mcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })

app.whenReady().then(() =>
  setTimeout(async () => {
    const port = server.address().port
    const site = `http://127.0.0.1:${port}`
    console.log('\nZirtola security checks\n')
    try {
      await waitFor(() => Promise.resolve(!!mainWin()))
      await waitFor(() => ui(`document.querySelectorAll('#tabs .tab').length > 0`))
      const page = await openTab(`${site}/`)
      // Open the menus overlay once so its webContents exists for the checks below.
      await ui(`window.browser.openMenu?.(0, 0)`).catch(() => {})
      await sleep(500)

      await check('every page and browser view is sandboxed and context-isolated', async () => {
        const bad = []
        for (const wc of webContents.getAllWebContents()) {
          const p = wc.getLastWebPreferences()
          if (!p) continue
          if (!p.sandbox || !p.contextIsolation || p.nodeIntegration || p.webviewTag) bad.push(`${wc.getType()} ${wc.getURL() || '(blank)'}: ${JSON.stringify({ sandbox: p.sandbox, contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration, webviewTag: p.webviewTag })}`)
        }
        assert(!bad.length, bad.join('\n        '))
      })

      await check('web pages see no Node.js and no browser APIs', async () => {
        const env = await page.executeJavaScript(`({ require: typeof require, process: typeof process, Buffer: typeof Buffer, module: typeof module, browser: typeof window.browser, ipc: typeof window.ipcRenderer, electron: typeof window.electron })`)
        const leaked = Object.entries(env).filter(([, t]) => t !== 'undefined')
        assert(!leaked.length, `page can see: ${leaked.map(([k]) => k).join(', ')}`)
      })

      await check('pages run in a sandboxed renderer process', async () => {
        const pid = page.getOSProcessId()
        const metric = app.getAppMetrics().find((m) => m.pid === pid)
        assert(metric?.sandboxed !== false, `renderer ${pid} is not sandboxed (${JSON.stringify(metric)})`)
      })

      await check('different sites get different processes (site isolation)', async () => {
        const framed = await openTab(`${site}/frame`)
        await waitFor(() => Promise.resolve(framed.mainFrame.frames.length > 0 && framed.mainFrame.frames[0].url.startsWith('http://localhost')))
        const child = framed.mainFrame.frames[0]
        assert(child, 'cross-site iframe did not load')
        assert(child.osProcessId !== framed.mainFrame.osProcessId, `cross-site iframe shares the page's process (${child.osProcessId})`)
        const other = await openTab(`http://localhost:${port}/`)
        assert(other.getOSProcessId() !== page.getOSProcessId(), 'tabs on different sites share a process')
      })

      await check('web pages cannot open local files', async () => {
        const target = 'file://' + path.join(profile, 'settings.json').replace(/\\/g, '/')
        const tabsBefore = (await tabIds()).length
        await page.executeJavaScript(`location.href = ${JSON.stringify(target)}`)
        await sleep(800)
        assert(!page.getURL().startsWith('file:'), `page navigated to ${page.getURL()}`)
        await page.executeJavaScript(`window.open(${JSON.stringify(target)}); document.body.innerHTML = '<iframe src=${JSON.stringify(target)}></iframe>'`)
        await sleep(800)
        assert(!webContents.getAllWebContents().some((w) => w.getURL().startsWith('file:') && w.getURL().includes('settings.json')), 'a file:// page was opened')
        assert(page.mainFrame.frames.every((f) => !f.url.startsWith('file:')), 'a file:// iframe loaded')
        assert((await tabIds()).length === tabsBefore, 'window.open of a file:// URL opened a tab')
      })

      await check('web pages cannot open internal pages (chrome://, devtools://)', async () => {
        for (const url of ['chrome://gpu', 'chrome://settings', 'devtools://devtools/bundled/inspector.html']) {
          await page.executeJavaScript(`location.href = ${JSON.stringify(url)}`).catch(() => {})
          await sleep(500)
          assert(/^https?:/.test(page.getURL()), `page navigated to ${page.getURL()}`)
        }
      })

      await check("Chromium's HTTPS-only list (HSTS preload) is enforced", async () => {
        // http:// to a preloaded site is upgraded inside the browser, before anything goes on the network.
        const ses = session.fromPartition('persist:default')
        let upgraded = null
        await new Promise((resolve) => {
          const { net } = require('electron')
          const req = net.request({ url: 'http://accounts.google.com/', session: ses, redirect: 'manual' })
          req.on('redirect', (status, _m, url) => {
            upgraded = { status, url }
            req.abort()
            resolve()
          })
          req.on('error', () => resolve())
          req.on('response', () => resolve())
          req.end()
          setTimeout(resolve, 5000)
        })
        assert(upgraded?.url?.startsWith('https://accounts.google.com'), `not upgraded: ${JSON.stringify(upgraded)}`)
      })

      await check('the browser UI cannot be navigated to a web page', async () => {
        const before = mainWin().webContents.getURL()
        await ui(`location.href = ${JSON.stringify(`${site}/secret`)}`).catch(() => {})
        await sleep(800)
        assert(mainWin().webContents.getURL() === before, `UI navigated to ${mainWin().webContents.getURL()}`)
        assert((await ui(`document.querySelector('#tabs') !== null`)) === true, 'UI page was replaced')
      })

      await check('browser commands are ignored when sent by a web page', async () => {
        const tabsBefore = (await tabIds()).length
        const fake = { sender: page, senderFrame: page.mainFrame, reply() {}, returnValue: undefined }
        ipcMain.emit('ui:cmd', fake, 'newTab', `${site}/secret`)
        ipcMain.emit('overlay:setting', fake, 'mcp.allowEvaluate', true)
        ipcMain.emit('overlay:action', fake, 'mcpResetToken')
        await sleep(800)
        assert((await tabIds()).length === tabsBefore, 'a page opened a tab through the UI channel')
        assert(getSettings().mcp.allowEvaluate === false, 'a page changed a setting through the menus channel')
        assert(getSettings().mcp.token === MCP_TOKEN, 'a page reset the MCP token through the menus channel')
      })

      await check('certificate errors block the page (no silent bypass)', async () => {
        if (!tlsServer) return 'skip'
        const bad = await openTab(`https://127.0.0.1:${tlsServer.address().port}/`)
        await sleep(500)
        const text = await bad.executeJavaScript('document.body?.innerText ?? ""').catch(() => '')
        assert(!text.includes(SECRET), 'a page with an invalid certificate was shown')
      })

      await check('pages cannot open other apps without you (mailto:, ms-settings:, custom schemes)', async () => {
        externalOpens.length = 0
        for (const url of ['mailto:someone@example.com', 'ms-settings:privacy', 'zirtola-test-scheme://x']) {
          await page.executeJavaScript(`location.href = ${JSON.stringify(url)}`).catch(() => {})
          await sleep(300)
          await page.executeJavaScript(`{ const a = document.createElement('a'); a.href = ${JSON.stringify(url)}; document.body.append(a); a.click() }`).catch(() => {})
          await sleep(300)
        }
        assert(!externalOpens.length, `opened in another app: ${externalOpens.join(', ')}`)
      })

      await check('powerful permissions are never granted without asking', async () => {
        const states = await page.executeJavaScript(`Promise.all(['geolocation','notifications','camera','microphone','clipboard-read','midi'].map(n => navigator.permissions.query({ name: n }).then(s => n + '=' + s.state, () => n + '=n/a')))`)
        const granted = states.filter((s) => s.endsWith('=granted'))
        assert(!granted.length, `granted without asking: ${granted.join(', ')}`)
        const clip = await page.executeJavaScript(`navigator.clipboard.readText().then(() => 'read', () => 'blocked')`)
        assert(clip === 'blocked', 'a page read the clipboard without asking')
      })

      await check('MCP server: rejects missing or wrong token, other hosts and web pages', async () => {
        const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'security-check', version: '1' } } }
        assert((await mcp(init, { authorization: '' })).status === 401, 'no token was accepted')
        assert((await mcp(init, { authorization: 'Bearer wrong' })).status === 401, 'a wrong token was accepted')
        assert((await mcp(init, { origin: 'https://evil.example' })).status === 403, 'a browser-originated request was accepted')
        assert((await mcp(init, { host: `evil.example:${MCP_PORT}` })).status === 403, 'a foreign Host header was accepted (DNS rebinding)')
        assert((await mcp(init)).status === 200, 'the real token was refused')
      })

      await check('MCP server: no script evaluation unless enabled, no local files', async () => {
        const list = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
        const names = (list.json?.result?.tools ?? []).map((t) => t.name)
        assert(names.length > 0, `tools/list failed: ${JSON.stringify(list.json)}`)
        assert(!names.some((n) => /eval/i.test(n)), `evaluate tool offered while disabled: ${names.join(', ')}`)
        const target = 'file://' + path.join(profile, 'settings.json').replace(/\\/g, '/')
        const res = await mcpCall('open_tab', { url: target })
        const text = JSON.stringify(res.json)
        assert(!text.includes(MCP_TOKEN), 'MCP read a local file')
        assert(!webContents.getAllWebContents().some((w) => w.getURL().startsWith('file:') && w.getURL().includes('settings.json')), 'MCP opened a local file')
      })
    } catch (err) {
      results.push({ name: 'harness', ok: false })
      console.log(`  FAIL  harness: ${err?.stack ?? err}`)
    }
    const failed = results.filter((r) => !r.ok)
    console.log(`\n${results.length - failed.length} passed, ${failed.length} failed${results.some((r) => r.skipped) ? ' (some skipped)' : ''}\n`)
    server.close()
    tlsServer?.close()
    process.exitCode = failed.length ? 1 : 0
    app.quit()
    setTimeout(() => app.exit(process.exitCode), 10000).unref()
  }, 1500),
)
