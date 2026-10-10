// Bundles a ready-to-use ad/tracker blocking engine into dist/filters/ so blocking works on
// first launch (and offline). The browser refreshes lists itself every 24 hours after that.
// Run after `npm run build` (it uses the compiled list definitions).
const fs = require('node:fs')
const path = require('node:path')
const { FiltersEngine } = require('@ghostery/adblocker')
const { filterListUrls, RESOURCES_URL } = require('../dist/main/filter-lists.js')

async function download(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return res.text()
}

async function main() {
  const [lists, resources] = await Promise.all([Promise.all(filterListUrls(true).map(download)), download(RESOURCES_URL)])
  const engine = FiltersEngine.parse(lists.join('\n'), { loadNetworkFilters: true, loadCosmeticFilters: true, enableCompression: true })
  engine.updateResources(resources, String(resources.length))
  const out = path.join(__dirname, '..', 'dist', 'filters')
  fs.mkdirSync(out, { recursive: true })
  const serialized = engine.serialize()
  fs.writeFileSync(path.join(out, 'engine.bin'), serialized)
  fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify({ updatedAt: Date.now(), cookieBanners: true }))
  console.log(`Filter engine: ${(serialized.length / 1e6).toFixed(1)} MB from ${lists.length} lists`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
