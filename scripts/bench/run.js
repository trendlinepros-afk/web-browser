// Speed & stability benchmark for Zirtola. Run with `npm run bench` (builds first).
// Drives the real browser through its UI, the way a person would, and prints a report:
// startup, memory with 1/20/40 heavy tabs, what tab sleeping gives back, tab switching, waking,
// menus, 200-tab and 15-window churn (leak check), a renderer crash and quitting.
// Uses a throwaway profile and serves its own test page, so it never touches your real data.
const launched = Date.now()
const { app, BrowserWindow, webContents, Menu, ipcMain } = require('electron')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'zirtola-bench-'))
app.setPath('userData', profile)
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ askedDefaultBrowser: true, checkForUpdatesOnStartup: false, restoreSession: false }))

// A news-site-sized page: ~400 cards, 2,000+ elements, styles, a ticking timer and 20k JS objects.
function heavyPage() {
  const words = ['alpha', 'beta', 'gamma', 'delta', 'news', 'story', 'market', 'world', 'sport', 'tech']
  let seed = 1
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  const cards = Array.from({ length: 400 }, (_, i) =>
    `<div class="card"><div class="img"></div><h3>Story ${i}</h3><p>${Array.from({ length: 30 }, () => words[Math.floor(rnd() * 10)]).join(' ')}</p><button>Read more</button></div>`).join('')
  return `<!doctype html><meta charset="utf-8"><title>Heavy page</title><style>body{font-family:sans-serif;margin:0}.card{display:inline-block;width:280px;margin:8px;padding:10px;border:1px solid #ddd;border-radius:8px;vertical-align:top}.img{height:120px;background:linear-gradient(135deg,#6a5cff,#19d3e6)}</style>
<nav>${Array.from({ length: 40 }, (_, i) => `<a href="#">Section ${i}</a>`).join(' ')}</nav><main>${cards}</main>
<script>let n=0;setInterval(()=>{n++;document.title='Heavy page '+(n%10)},1000);window.__big=Array.from({length:20000},(_, i)=>({i,s:'x'+i}))</script>`
}
const page = heavyPage()
const server = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(page)).listen(0, '127.0.0.1')

require('../../dist/main/main.js')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const report = {}
const errors = []
process.on('uncaughtException', (e) => errors.push(`uncaught: ${e.message}`))
process.on('unhandledRejection', (e) => errors.push(`unhandled: ${e?.message ?? e}`))
const record = (k, v) => {
  report[k] = v
  console.log(`  ${k.padEnd(34)} ${typeof v === 'object' ? JSON.stringify(v) : v}`)
}
function mem() {
  let total = 0
  const m = app.getAppMetrics()
  for (const p of m) total += p.memory.workingSetSize / 1024
  return `${Math.round(total)} MB in ${m.length} processes`
}
const mainWin = () => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html'))
const ui = (js) => mainWin().webContents.executeJavaScript(js)
const tabIds = () => ui(`[...document.querySelectorAll('#tabs .tab')].map(t => Number(t.dataset.id))`)
const pages = () => webContents.getAllWebContents().filter((w) => /^https?:|about:blank/.test(w.getURL()))
const overlay = () => webContents.getAllWebContents().find((c) => c.getURL().includes('overlay.html'))
const allLoaded = () => pages().every((w) => !w.isLoading())
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]
async function waitFor(fn, timeout = 30000, step = 25) {
  const t = Date.now()
  while (Date.now() - t < timeout) {
    if (await fn()) return Date.now() - t
    await sleep(step)
  }
  return -1
}
const fileMenu = (label) => Menu.getApplicationMenu().items.find((i) => i.label === 'File').submenu.items.find((i) => label.test(i.label))
async function sleepAll() {
  fileMenu(/Settings/).click()
  await sleep(500)
  await overlay().executeJavaScript(`[...document.querySelectorAll('.nav-item')].find(b => b.textContent.startsWith('Speed')).click()`)
  await sleep(150)
  await overlay().executeJavaScript(`[...document.querySelectorAll('#settings-body .btn')].find(b => b.textContent === 'Sleep now').click()`)
  await sleep(300)
  await overlay().executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}))`)
}

app.whenReady().then(() => setTimeout(async () => {
  let failed = false
  try {
    const url = `http://127.0.0.1:${server.address().port}/`
    console.log('\nZirtola speed & stability benchmark\n')
    await waitFor(() => !!mainWin())
    await waitFor(() => ui(`document.querySelectorAll('#tabs .tab').length > 0`).catch(() => false), 15000, 5)
    record('startup to usable window (ms)', Date.now() - launched)
    await sleep(3000)
    record('memory, 1 blank tab', mem())
    const before = { pages: webContents.getAllWebContents().length, uiListeners: ipcMain.listenerCount('ui:cmd') }

    let t = Date.now()
    for (let i = 0; i < 20; i++) await ui(`window.browser.newTab(${JSON.stringify(`${url}?t=${i}`)})`)
    await waitFor(() => pages().filter((w) => w.getURL().includes('?t=')).length >= 20 && allLoaded(), 60000)
    record('open 20 heavy tabs (ms)', Date.now() - t)
    await sleep(4000)
    record('memory, 20 heavy tabs awake', mem())

    let ids = await tabIds()
    const switches = []
    for (const id of ids.slice(-10)) {
      t = Date.now()
      await ui(`window.browser.activateTab(${id})`)
      await waitFor(() => ui(`document.querySelector('#tabs .tab.active')?.dataset.id === '${id}'`), 3000, 2)
      switches.push(Date.now() - t)
    }
    record('switch tab (ms, median)', median(switches))

    await sleepAll()
    await sleep(30000)
    ids = await tabIds()
    record('memory, 30s after "Sleep now"', `${mem()}; ${pages().length} awake, ${ids.length} tabs kept`)
    if (ids.length !== 21) throw new Error(`sleeping lost tabs: ${ids.length} of 21 left`)

    const wakes = []
    for (const id of ids.slice(1, 6)) {
      t = Date.now()
      await ui(`window.browser.activateTab(${id})`)
      await sleep(5)
      await waitFor(async () => (await ui(`!document.querySelector('#tabs .tab.active')?.classList.contains('sleeping')`)) && allLoaded(), 10000, 5)
      wakes.push(Date.now() - t)
    }
    record('wake a sleeping tab (ms, median)', median(wakes))

    for (let i = 20; i < 40; i++) await ui(`window.browser.newTab(${JSON.stringify(`${url}?t=${i}`)})`)
    await waitFor(allLoaded, 60000)
    await sleep(3000)
    record('memory, 41 tabs (26 awake)', mem())
    await sleepAll()
    await sleep(30000)
    record('memory, 41 tabs after sleep', mem())

    for (const id of (await tabIds()).slice(1)) await ui(`window.browser.closeTab(${id})`)
    t = Date.now()
    for (let i = 0; i < 200; i++) {
      await ui(`window.browser.newTab(${JSON.stringify(url)})`)
      await ui(`window.browser.closeTab(${(await tabIds()).pop()})`)
    }
    record('open+close 200 tabs (ms)', Date.now() - t)
    await sleep(30000)
    const after = { pages: webContents.getAllWebContents().length, uiListeners: ipcMain.listenerCount('ui:cmd') }
    record('leftover pages after churn', after.pages - before.pages - 1) // -1: the menus overlay, created on first use
    record('memory after churn (1 tab)', mem())

    for (let i = 0; i < 15; i++) {
      fileMenu(/^New Window$/).click()
      await sleep(400)
      const wins = BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().includes('index.html'))
      wins[wins.length - 1].close()
      await sleep(250)
    }
    await sleep(2000)
    record('windows left after 15 open/close', BrowserWindow.getAllWindows().length)

    const opens = []
    for (let i = 0; i < 20; i++) {
      t = Date.now()
      fileMenu(/Settings/).click()
      await waitFor(() => overlay()?.executeJavaScript(`!document.getElementById('settings').hidden`), 3000, 2)
      opens.push(Date.now() - t)
      await overlay().executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}))`)
      await sleep(80)
    }
    record('open Settings (ms, median)', median(opens))

    await ui(`window.browser.newTab(${JSON.stringify(`${url}?crash`)})`)
    await waitFor(() => pages().some((w) => w.getURL().includes('crash') && !w.isLoading()), 15000)
    pages().find((w) => w.getURL().includes('crash')).forcefullyCrashRenderer()
    await sleep(1500)
    const alive = (await Promise.race([ui('1+1'), sleep(3000).then(() => 0)])) === 2
    const crashed = (await tabIds()).pop()
    await ui(`window.browser.activateTab(${(await tabIds())[0]})`)
    await sleep(300)
    await ui(`window.browser.activateTab(${crashed})`)
    const recovered = await waitFor(() => pages().some((w) => w.getURL().includes('crash') && !w.isCrashed() && !w.isLoading()), 10000)
    record('crashed tab: UI still responsive', alive)
    record('crashed tab: reloads on click (ms)', recovered)
    record('errors', errors.length ? errors : 'none')
  } catch (e) {
    failed = true
    console.error('\nBENCHMARK FAILED:', e.stack || e)
  }
  if (process.env.BENCH_JSON) fs.writeFileSync(process.env.BENCH_JSON, JSON.stringify(report, null, 2))
  const t = Date.now()
  app.once('will-quit', () => {
    console.log(`  ${'quit (ms)'.padEnd(34)} ${Date.now() - t}\n`)
    fs.rmSync(profile, { recursive: true, force: true })
    if (failed || errors.length) process.exitCode = 1
  })
  app.quit()
}, 500))
