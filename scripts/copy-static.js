// Copies non-TypeScript UI assets (HTML/CSS) into dist/.
const fs = require('node:fs')
const path = require('node:path')

const src = path.join(__dirname, '..', 'src', 'renderer')
const out = path.join(__dirname, '..', 'dist', 'renderer')
fs.mkdirSync(out, { recursive: true })
for (const file of fs.readdirSync(src)) {
  if (file.endsWith('.html') || file.endsWith('.css')) {
    fs.copyFileSync(path.join(src, file), path.join(out, file))
  }
}
