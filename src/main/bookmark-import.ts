import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { BAR, OTHER, type BookmarkNode, type BookmarkStore, type NewNode } from './bookmarks'

export interface FirefoxProfile {
  name: string
  dir: string
  isDefault: boolean
}

export interface ImportResult {
  bookmarks: number
  folders: number
  duplicates: number
}

/** Bookmark trees from another browser, before they are merged into ours. */
interface ImportedTree {
  toolbar: NewNode[]
  /** Everything else, already grouped (e.g. "Bookmarks Menu", "Other Bookmarks"). */
  rest: NewNode[]
}

// ---- Firefox profile discovery ---------------------------------------------

function firefoxDataDirs(): string[] {
  const home = os.homedir()
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
    return [path.join(appData, 'Mozilla', 'Firefox')]
  }
  if (process.platform === 'darwin') return [path.join(home, 'Library', 'Application Support', 'Firefox')]
  return [
    path.join(home, '.mozilla', 'firefox'),
    path.join(home, '.config', 'mozilla', 'firefox'),
    path.join(home, 'snap', 'firefox', 'common', '.mozilla', 'firefox'),
    path.join(home, '.var', 'app', 'org.mozilla.firefox', '.mozilla', 'firefox'),
  ]
}

function parseIni(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  let section = ''
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const header = /^\[(.+)\]$/.exec(line)
    if (header) {
      section = header[1]
      out[section] ??= {}
    } else if (section && line.includes('=')) {
      const i = line.indexOf('=')
      out[section][line.slice(0, i).trim()] = line.slice(i + 1).trim()
    }
  }
  return out
}

/** Firefox profiles that have bookmarks, the one Firefox currently uses first. */
export function findFirefoxProfiles(): FirefoxProfile[] {
  const found = new Map<string, FirefoxProfile>()
  for (const base of firefoxDataDirs()) {
    let ini: Record<string, Record<string, string>>
    try {
      ini = parseIni(fs.readFileSync(path.join(base, 'profiles.ini'), 'utf8'))
    } catch {
      continue
    }
    // [Install…] sections name the profile each Firefox install actually opens.
    const installDefaults = new Set(
      Object.entries(ini)
        .filter(([k]) => k.startsWith('Install'))
        .map(([, v]) => v.Default)
        .filter(Boolean),
    )
    for (const [key, s] of Object.entries(ini)) {
      if (!key.startsWith('Profile') || !s.Path) continue
      const dir = s.IsRelative === '0' ? s.Path : path.join(base, s.Path)
      if (!fs.existsSync(path.join(dir, 'places.sqlite'))) continue
      found.set(dir, {
        name: s.Name || path.basename(dir),
        dir,
        isDefault: installDefaults.has(s.Path) || (installDefaults.size === 0 && s.Default === '1'),
      })
    }
  }
  return [...found.values()].sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1
    return mtime(b.dir) - mtime(a.dir)
  })
}

function mtime(dir: string): number {
  try {
    return fs.statSync(path.join(dir, 'places.sqlite')).mtimeMs
  } catch {
    return 0
  }
}

/**
 * Firefox keeps its databases locked while running, so we read copies. The -wal file holds
 * changes not yet merged into the main file; copying it too means nothing recent is missed.
 */
function openCopy(profileDir: string, name: string, tmp: string): DatabaseSync | null {
  const src = path.join(profileDir, name)
  if (!fs.existsSync(src)) return null
  for (const suffix of ['', '-wal']) {
    if (fs.existsSync(src + suffix)) fs.copyFileSync(src + suffix, path.join(tmp, name + suffix))
  }
  return new DatabaseSync(path.join(tmp, name))
}

// ---- Firefox places.sqlite -------------------------------------------------

interface PlacesRow {
  id: number
  type: number
  parent: number
  title: string | null
  dateAdded: number | null
  guid: string
  url: string | null
}

const FF_TOOLBAR = 'toolbar_____'
const FF_MENU = 'menu________'
const FF_UNFILED = 'unfiled_____'
const FF_MOBILE = 'mobile______'

export function readFirefoxBookmarks(profileDir: string): ImportedTree {
  const tmp = fs.mkdtempSync(path.join(app.getPath('temp'), 'ff-import-'))
  try {
    const places = openCopy(profileDir, 'places.sqlite', tmp)
    if (!places) throw new Error('This Firefox profile has no bookmarks database.')
    let rows: PlacesRow[]
    try {
      rows = places
        .prepare(
          `SELECT b.id, b.type, b.parent, b.title, b.dateAdded, b.guid, p.url
           FROM moz_bookmarks b LEFT JOIN moz_places p ON p.id = b.fk
           ORDER BY b.parent, b.position`,
        )
        .all() as unknown as PlacesRow[]
    } finally {
      places.close()
    }

    const icons = readFirefoxFavicons(profileDir, tmp, rows.map((r) => r.url).filter((u): u is string => !!u))

    const byParent = new Map<number, PlacesRow[]>()
    for (const r of rows) {
      const list = byParent.get(r.parent) ?? []
      list.push(r)
      byParent.set(r.parent, list)
    }
    const build = (parentId: number): NewNode[] => {
      const out: NewNode[] = []
      for (const r of byParent.get(parentId) ?? []) {
        const dateAdded = r.dateAdded ? Math.round(r.dateAdded / 1000) : undefined
        if (r.type === 1 && r.url && !r.url.startsWith('place:')) {
          out.push({ type: 'bookmark', title: r.title || r.url, url: r.url, favicon: icons.get(r.url), dateAdded })
        } else if (r.type === 2) {
          const children = build(r.id)
          if (children.length) out.push({ type: 'folder', title: r.title || 'Folder', children, dateAdded })
        }
        // type 3 = separator: no equivalent on our bar.
      }
      return out
    }
    const root = (guid: string) => {
      const row = rows.find((r) => r.guid === guid)
      return row ? build(row.id) : []
    }

    const rest: NewNode[] = []
    const menu = root(FF_MENU)
    if (menu.length) rest.push({ type: 'folder', title: 'Bookmarks Menu', children: menu })
    const unfiled = root(FF_UNFILED)
    if (unfiled.length) rest.push({ type: 'folder', title: 'Other Bookmarks', children: unfiled })
    const mobile = root(FF_MOBILE)
    if (mobile.length) rest.push({ type: 'folder', title: 'Mobile Bookmarks', children: mobile })
    return { toolbar: root(FF_TOOLBAR), rest }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

/** Firefox's stored icons for the given pages, as data: URLs (best effort). */
function readFirefoxFavicons(profileDir: string, tmp: string, urls: string[]): Map<string, string> {
  const result = new Map<string, string>()
  let db: DatabaseSync | null = null
  try {
    db = openCopy(profileDir, 'favicons.sqlite', tmp)
    if (!db) return result
    const wanted = new Set(urls)
    const pageIds = new Map<number, string>()
    for (const row of db.prepare('SELECT id, page_url FROM moz_pages_w_icons').all() as { id: number; page_url: string }[]) {
      if (wanted.has(row.page_url)) pageIds.set(row.id, row.page_url)
    }
    const best = new Map<string, { width: number; data: Uint8Array }>()
    const ids = [...pageIds.keys()]
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500)
      const rows = db
        .prepare(
          `SELECT ip.page_id AS page, i.width AS width, i.data AS data FROM moz_icons_to_pages ip
           JOIN moz_icons i ON i.id = ip.icon_id WHERE ip.page_id IN (${chunk.map(() => '?').join(',')})`,
        )
        .all(...chunk) as { page: number; width: number; data: Uint8Array | null }[]
      for (const r of rows) {
        if (!r.data || r.data.length > 64 * 1024) continue
        const url = pageIds.get(r.page)!
        const current = best.get(url)
        // Prefer 32px (crisp on high-DPI screens), then the closest size.
        if (!current || Math.abs(r.width - 32) < Math.abs(current.width - 32)) best.set(url, { width: r.width, data: r.data })
      }
    }
    // Pages without their own icon fall back to the site's /favicon.ico.
    const rootIcons = new Map<string, Uint8Array | null>()
    const rootStmt = db.prepare('SELECT data FROM moz_icons WHERE root = 1 AND icon_url = ? AND data IS NOT NULL ORDER BY width DESC LIMIT 1')
    for (const url of wanted) {
      if (best.has(url)) continue
      let origin: string
      try {
        origin = new URL(url).origin
      } catch {
        continue
      }
      if (!rootIcons.has(origin)) {
        const row = rootStmt.get(`${origin}/favicon.ico`) as { data: Uint8Array } | undefined
        rootIcons.set(origin, row?.data && row.data.length <= 64 * 1024 ? row.data : null)
      }
      const data = rootIcons.get(origin)
      if (data) best.set(url, { width: 16, data })
    }
    for (const [url, { data }] of best) result.set(url, toDataUrl(Buffer.from(data)))
  } catch (err) {
    console.warn('Could not read Firefox favicons:', err)
  } finally {
    db?.close()
  }
  return result
}

function toDataUrl(buf: Buffer): string {
  const head = buf.subarray(0, 12)
  const type =
    head[0] === 0x89 && head.toString('latin1', 1, 4) === 'PNG'
      ? 'image/png'
      : head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP'
        ? 'image/webp'
        : head.toString('latin1', 0, 3) === 'GIF'
          ? 'image/gif'
          : head[0] === 0xff && head[1] === 0xd8
            ? 'image/jpeg'
            : /^\s*</.test(head.toString('utf8'))
              ? 'image/svg+xml'
              : 'image/x-icon'
  return `data:${type};base64,${buf.toString('base64')}`
}

// ---- Bookmarks HTML (Netscape format: Firefox, Chrome, Edge, Safari exports) --

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(attrs)
  return m ? decodeEntities(m[1]) : undefined
}

export function parseBookmarksHtml(html: string): ImportedTree {
  const tree: ImportedTree = { toolbar: [], rest: [] }
  const top: NewNode[] = []
  const stack: NewNode[][] = [top]
  let pendingFolder: { node: NewNode; toolbar: boolean } | null = null
  let toolbarNode: NewNode | null = null

  const token = /<dl[^>]*>|<\/dl>|<h3([^>]*)>([\s\S]*?)<\/h3>|<a\s([^>]*)>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = token.exec(html))) {
    const tag = m[0].slice(0, 3).toLowerCase()
    if (tag === '<dl') {
      // The <DL> after an <H3> holds that folder's children; the first one is the document root.
      if (pendingFolder) {
        stack.push(pendingFolder.node.children!)
        pendingFolder = null
      } else if (stack.length > 1 || top.length) {
        stack.push(stack[stack.length - 1])
      }
    } else if (tag === '</d') {
      if (stack.length > 1) stack.pop()
    } else if (m[1] !== undefined) {
      const node: NewNode = { type: 'folder', title: decodeEntities(m[2].trim()) || 'Folder', children: [] }
      const isToolbar = attr(m[1], 'PERSONAL_TOOLBAR_FOLDER') === 'true'
      if (isToolbar && !toolbarNode) toolbarNode = node
      else stack[stack.length - 1].push(node)
      pendingFolder = { node, toolbar: isToolbar }
    } else if (m[3] !== undefined) {
      const url = attr(m[3], 'HREF')
      if (!url || url.startsWith('place:') || url.startsWith('javascript:')) continue
      const added = Number(attr(m[3], 'ADD_DATE'))
      const icon = attr(m[3], 'ICON')
      stack[stack.length - 1].push({
        type: 'bookmark',
        title: decodeEntities(m[4].replace(/<[^>]+>/g, '').trim()) || url,
        url,
        favicon: icon?.startsWith('data:image/') ? icon : undefined,
        dateAdded: added ? added * 1000 : undefined,
      })
    }
  }
  tree.toolbar = toolbarNode?.children ?? []
  const prune = (nodes: NewNode[]): NewNode[] =>
    nodes
      .map((n) => (n.type === 'folder' ? { ...n, children: prune(n.children ?? []) } : n))
      .filter((n) => n.type === 'bookmark' || (n.children?.length ?? 0) > 0)
  tree.toolbar = prune(tree.toolbar)
  tree.rest = prune(top)
  return tree
}

export function exportBookmarksHtml(store: BookmarkStore): string {
  const lines = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This is an automatically generated file. It will be read and overwritten. DO NOT EDIT! -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
  ]
  const secs = (ms: number) => Math.floor(ms / 1000)
  const walk = (node: BookmarkNode, indent: string, extra = '') => {
    if (node.type === 'folder') {
      lines.push(`${indent}<DT><H3 ADD_DATE="${secs(node.dateAdded)}"${extra}>${escapeHtml(node.title)}</H3>`)
      lines.push(`${indent}<DL><p>`)
      for (const c of node.children ?? []) walk(c, indent + '    ')
      lines.push(`${indent}</DL><p>`)
    } else {
      const icon = node.favicon ? ` ICON="${escapeHtml(node.favicon)}"` : ''
      lines.push(`${indent}<DT><A HREF="${escapeHtml(node.url ?? '')}" ADD_DATE="${secs(node.dateAdded)}"${icon}>${escapeHtml(node.title)}</A>`)
    }
  }
  walk(store.bar, '    ', ' PERSONAL_TOOLBAR_FOLDER="true"')
  walk(store.other, '    ')
  lines.push('</DL><p>')
  return lines.join('\n') + '\n'
}

// ---- Merge into our bookmarks -----------------------------------------------

/**
 * Adds imported bookmarks. Toolbar items go straight onto the bar when it's empty, otherwise into
 * an "Imported from <source>" folder on the bar. Everything else goes under Other bookmarks.
 * Pages already bookmarked are skipped, so importing twice doesn't create duplicates.
 */
export function mergeImport(store: BookmarkStore, tree: ImportedTree, source: string): ImportResult {
  const result: ImportResult = { bookmarks: 0, folders: 0, duplicates: 0 }
  const seen = new Set<string>()
  const dedupe = (nodes: NewNode[]): NewNode[] => {
    const out: NewNode[] = []
    for (const n of nodes) {
      if (n.type === 'bookmark') {
        if (!n.url || store.isBookmarked(n.url) || seen.has(n.url)) {
          result.duplicates++
          continue
        }
        seen.add(n.url)
        result.bookmarks++
        out.push(n)
      } else {
        const children = dedupe(n.children ?? [])
        if (children.length) {
          result.folders++
          out.push({ ...n, children })
        }
      }
    }
    return out
  }

  const toolbar = dedupe(tree.toolbar)
  const rest = dedupe(tree.rest)
  const folderName = `Imported from ${source}`

  if (toolbar.length) {
    if ((store.bar.children ?? []).length === 0) {
      for (const n of toolbar) store.add(BAR, n)
    } else {
      store.add(BAR, { type: 'folder', title: folderName, children: toolbar })
      result.folders++
    }
  }
  if (rest.length) {
    store.add(OTHER, { type: 'folder', title: folderName, children: rest })
    result.folders++
  }
  return result
}
