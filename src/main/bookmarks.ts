import { app, type Session } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { BookmarkItem } from '../shared/types'

export interface BookmarkNode {
  id: string
  type: 'bookmark' | 'folder'
  title: string
  url?: string
  /** data: URL, so the bar never has to fetch icons from the network. */
  favicon?: string
  children?: BookmarkNode[]
  dateAdded: number
}

/** The two fixed roots, like Chrome: the bar, and everything else. */
export const BAR = 'bar'
export const OTHER = 'other'

interface StoredBookmarks {
  version: 1
  roots: { bar: BookmarkNode; other: BookmarkNode }
}

const MAX_FAVICON_BYTES = 64 * 1024

function newId(): string {
  return crypto.randomBytes(6).toString('base64url')
}

function emptyRoots(): StoredBookmarks['roots'] {
  return {
    bar: { id: BAR, type: 'folder', title: 'Bookmarks bar', children: [], dateAdded: Date.now() },
    other: { id: OTHER, type: 'folder', title: 'Other bookmarks', children: [], dateAdded: Date.now() },
  }
}

export interface NewNode {
  type: 'bookmark' | 'folder'
  title: string
  url?: string
  favicon?: string
  dateAdded?: number
  children?: NewNode[]
}

export class BookmarkStore {
  private roots = emptyRoots()
  private saveTimer: NodeJS.Timeout | null = null
  private urlIndex: Map<string, BookmarkNode[]> | null = null
  /** Bumped on every change; the UI re-renders the bar only when it moves. */
  version = 0
  onChanged: (() => void) | null = null

  private file(): string {
    return path.join(app.getPath('userData'), 'bookmarks.json')
  }

  load(): void {
    try {
      const data = JSON.parse(fs.readFileSync(this.file(), 'utf8')) as StoredBookmarks
      if (data.roots?.bar && data.roots?.other) this.roots = data.roots
    } catch {
      // First run: empty bar.
    }
  }

  // ---- Queries -------------------------------------------------------------

  get bar(): BookmarkNode {
    return this.roots.bar
  }

  get other(): BookmarkNode {
    return this.roots.other
  }

  find(id: string): { node: BookmarkNode; parent: BookmarkNode | null } | null {
    const walk = (node: BookmarkNode, parent: BookmarkNode | null): ReturnType<BookmarkStore['find']> => {
      if (node.id === id) return { node, parent }
      for (const child of node.children ?? []) {
        const found = walk(child, node)
        if (found) return found
      }
      return null
    }
    return walk(this.roots.bar, null) ?? walk(this.roots.other, null)
  }

  findByUrl(url: string): BookmarkNode[] {
    if (!this.urlIndex) {
      this.urlIndex = new Map()
      const walk = (node: BookmarkNode) => {
        if (node.url) {
          const list = this.urlIndex!.get(node.url) ?? []
          list.push(node)
          this.urlIndex!.set(node.url, list)
        }
        node.children?.forEach(walk)
      }
      walk(this.roots.bar)
      walk(this.roots.other)
    }
    return this.urlIndex.get(url) ?? []
  }

  isBookmarked(url: string): boolean {
    return !!url && this.findByUrl(url).length > 0
  }

  /** Every folder, depth-first, for "move to folder" pickers. */
  folders(): { id: string; title: string; depth: number }[] {
    const out: { id: string; title: string; depth: number }[] = []
    const walk = (node: BookmarkNode, depth: number) => {
      out.push({ id: node.id, title: node.title, depth })
      for (const child of node.children ?? []) if (child.type === 'folder') walk(child, depth + 1)
    }
    walk(this.roots.bar, 0)
    walk(this.roots.other, 0)
    return out
  }

  static toItem(node: BookmarkNode): BookmarkItem {
    return { id: node.id, title: node.title, url: node.url ?? null, favicon: node.favicon ?? null, folder: node.type === 'folder' }
  }

  count(node: BookmarkNode = this.roots.bar): { bookmarks: number; folders: number } {
    let bookmarks = 0
    let folders = 0
    const walk = (n: BookmarkNode) => {
      for (const c of n.children ?? []) {
        if (c.type === 'folder') {
          folders++
          walk(c)
        } else bookmarks++
      }
    }
    walk(node)
    return { bookmarks, folders }
  }

  // ---- Mutations -----------------------------------------------------------

  add(parentId: string, node: NewNode, index?: number): BookmarkNode {
    const parent = this.find(parentId)?.node
    if (!parent || parent.type !== 'folder') throw new Error(`No folder ${parentId}`)
    const created = this.materialize(node)
    const children = (parent.children ??= [])
    if (index === undefined || index < 0 || index > children.length) children.push(created)
    else children.splice(index, 0, created)
    this.changed()
    return created
  }

  update(id: string, patch: { title?: string; url?: string; favicon?: string }): void {
    const found = this.find(id)
    if (!found || id === BAR || id === OTHER) return
    if (patch.title !== undefined) found.node.title = patch.title
    if (patch.url !== undefined && found.node.type === 'bookmark') found.node.url = patch.url
    if (patch.favicon !== undefined) found.node.favicon = patch.favicon
    this.changed()
  }

  remove(id: string): void {
    const found = this.find(id)
    if (!found?.parent) return
    found.parent.children = found.parent.children!.filter((c) => c !== found.node)
    this.changed()
  }

  move(id: string, parentId: string, index?: number): void {
    const found = this.find(id)
    const target = this.find(parentId)?.node
    if (!found?.parent || !target || target.type !== 'folder') return
    // A folder can't move into itself or its own descendants.
    if (found.node.type === 'folder' && this.contains(found.node, parentId)) return
    const siblings = found.parent.children!
    const from = siblings.indexOf(found.node)
    siblings.splice(from, 1)
    const children = (target.children ??= [])
    let at = index ?? children.length
    if (target === found.parent && from < at) at--
    children.splice(Math.max(0, Math.min(at, children.length)), 0, found.node)
    this.changed()
  }

  private contains(folder: BookmarkNode, id: string): boolean {
    return folder.id === id || (folder.children ?? []).some((c) => this.contains(c, id))
  }

  private materialize(node: NewNode): BookmarkNode {
    return {
      id: newId(),
      type: node.type,
      title: node.title,
      ...(node.type === 'bookmark' ? { url: node.url } : { children: (node.children ?? []).map((c) => this.materialize(c)) }),
      ...(node.favicon ? { favicon: node.favicon } : {}),
      dateAdded: node.dateAdded ?? Date.now(),
    }
  }

  /** Stores the page's icon (as a data: URL) on every bookmark of that page, fetched through the tab's session. */
  async captureFavicon(pageUrl: string, faviconUrl: string | null, ses: Session): Promise<void> {
    if (!faviconUrl) return
    const targets = this.findByUrl(pageUrl).filter((b) => !b.favicon)
    if (targets.length === 0) return
    try {
      let dataUrl = faviconUrl
      if (!faviconUrl.startsWith('data:')) {
        const res = await ses.fetch(faviconUrl)
        if (!res.ok) return
        const buf = Buffer.from(await res.arrayBuffer())
        if (buf.length > MAX_FAVICON_BYTES) return
        const type = res.headers.get('content-type')?.split(';')[0] || 'image/x-icon'
        dataUrl = `data:${type};base64,${buf.toString('base64')}`
      }
      for (const b of targets) b.favicon = dataUrl
      this.changed()
    } catch {
      // Icons are cosmetic.
    }
  }

  private changed(): void {
    this.urlIndex = null
    this.version++
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.flush(), 500)
    this.onChanged?.()
  }

  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    const data: StoredBookmarks = { version: 1, roots: this.roots }
    const file = this.file()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file + '.tmp', JSON.stringify(data))
    fs.renameSync(file + '.tmp', file)
  }
}
