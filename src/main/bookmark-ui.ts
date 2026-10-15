import { BrowserWindow, dialog, ipcMain, nativeImage, nativeTheme, type MenuItemConstructorOptions } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { OpenDisposition } from '../shared/types'
import type { Browser } from './browser'
import type { BrowserWindowController } from './window'
import { BAR, OTHER, type BookmarkStore, type BookmarkNode } from './bookmarks'
import { exportBookmarksHtml, findFirefoxProfiles, mergeImport, parseBookmarksHtml, readFirefoxBookmarks, type ImportResult } from './bookmark-import'
import { denyWindowOpen } from './hardening'
import { updateSettings, getSettings } from './settings'

/** Bookmark bar interactions, menus, the edit dialog, and import/export. */
export class BookmarkUi {
  constructor(private readonly browser: Browser) {
    this.registerEditorIpc()
  }

  private get store(): BookmarkStore {
    return this.browser.bookmarks
  }

  handle(w: BrowserWindowController, name: string, args: unknown[]): void {
    switch (name) {
      case 'bookmarkActiveTab':
        return this.bookmarkActiveTab(w)
      case 'bookmark:open':
        return this.open(w, String(args[0]), args[1] as OpenDisposition)
      case 'bookmark:folder':
        return this.showFolder(w, String(args[0]), Number(args[1]), Number(args[2]))
      case 'bookmark:context':
        return this.showContextMenu(w, args[0] === null ? null : String(args[0]), Number(args[1]), Number(args[2]))
      case 'bookmark:overflow':
        return this.showOverflow(w, (args[0] as string[]).map(String), Number(args[1]), Number(args[2]))
      case 'bookmark:move':
        return this.store.move(String(args[0]), String(args[1]), Number(args[2]))
      case 'bookmark:import-firefox':
        return void this.importFromFirefox(w)
    }
  }

  // ---- Opening -------------------------------------------------------------

  openNode(w: BrowserWindowController, node: BookmarkNode, disposition: OpenDisposition): void {
    if (!node.url) return
    // Bookmarklets run in the current page.
    if (node.url.startsWith('javascript:')) {
      const code = decodeURIComponent(node.url.slice('javascript:'.length))
      w.activeTab?.webContents?.executeJavaScript(code, true).catch(() => {})
      return
    }
    if (disposition === 'current' && w.activeTab) {
      w.activeTab.loadURL(node.url)
      w.activeTab.webContents?.focus()
    } else {
      w.createTab({ url: node.url, background: disposition === 'background-tab' })
    }
  }

  private open(w: BrowserWindowController, id: string, disposition: OpenDisposition): void {
    const node = this.store.find(id)?.node
    if (node) this.openNode(w, node, disposition)
  }

  private openAll(w: BrowserWindowController, folder: BookmarkNode, opts: { incognito?: boolean; newWindow?: boolean; group?: boolean } = {}): void {
    const urls = (folder.children ?? []).filter((c) => c.url && !c.url.startsWith('javascript:')).map((c) => c.url!)
    if (urls.length === 0) return
    if (urls.length > 15) {
      const ok = dialog.showMessageBoxSync(w.win, {
        type: 'question',
        buttons: ['Open all', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        message: `Open ${urls.length} tabs?`,
      })
      if (ok !== 0) return
    }
    if (opts.newWindow || opts.incognito) {
      const target = this.browser.createWindow({ incognito: opts.incognito, url: urls[0] })
      for (const url of urls.slice(1)) target.createTab({ url, background: true })
    } else if (opts.group) {
      // A tab group named after the folder.
      const tabs = urls.map((url) => w.createTab({ url, background: true }))
      w.createGroup(tabs, folder.title)
      w.activateTab(tabs[0])
    } else {
      for (const url of urls) w.createTab({ url, background: true })
    }
  }

  // ---- Menus ---------------------------------------------------------------

  private icon(node: BookmarkNode): Electron.NativeImage | undefined {
    if (node.type === 'folder') return undefined
    if (!node.favicon?.startsWith('data:')) return undefined
    const img = nativeImage.createFromDataURL(node.favicon)
    return img.isEmpty() ? undefined : img.resize({ width: 16, height: 16 })
  }

  /** A folder's contents as a native menu (submenus for subfolders). */
  private folderMenu(w: BrowserWindowController, folder: BookmarkNode): MenuItemConstructorOptions[] {
    const children = folder.children ?? []
    const items: MenuItemConstructorOptions[] = children.map((child) =>
      child.type === 'folder'
        ? { label: menuLabel(child.title), submenu: this.folderMenu(w, child) }
        : {
            label: menuLabel(child.title || child.url || ''),
            icon: this.icon(child),
            click: (_item, _win, event) =>
              this.openNode(w, child, event.ctrlKey || event.metaKey ? 'background-tab' : event.shiftKey ? 'foreground-tab' : 'current'),
          },
    )
    if (items.length === 0) return [{ label: '(empty)', enabled: false }]
    if (children.filter((c) => c.url).length > 1) {
      items.push(
        { type: 'separator' },
        { label: 'Open all in new tabs', click: () => this.openAll(w, folder) },
        { label: 'Open in group', click: () => this.openAll(w, folder, { group: true }) },
      )
    }
    return items
  }

  private showFolder(w: BrowserWindowController, id: string, x: number, y: number): void {
    const folder = this.store.find(id)?.node
    if (!folder) return
    w.popup.menu(this.folderMenu(w, folder), x, y)
  }

  private showOverflow(w: BrowserWindowController, ids: string[], x: number, y: number): void {
    const nodes = ids.map((id) => this.store.find(id)?.node).filter((n): n is BookmarkNode => !!n)
    const pseudo: BookmarkNode = { id: '', type: 'folder', title: '', children: nodes, dateAdded: 0 }
    w.popup.menu(this.folderMenu(w, pseudo), x, y)
  }

  private showContextMenu(w: BrowserWindowController, id: string | null, x: number, y: number): void {
    const found = id ? this.store.find(id) : null
    const node = found?.node
    const parentId = found?.parent?.id ?? BAR
    const index = found?.parent ? found.parent.children!.indexOf(node!) + 1 : undefined
    const items: MenuItemConstructorOptions[] = []
    if (node?.type === 'bookmark') {
      items.push(
        { label: 'Open in new tab', click: () => this.openNode(w, node, 'background-tab') },
        { label: 'Open in new window', click: () => this.browser.createWindow({ url: node.url }) },
        { label: 'Open in private window', click: () => this.browser.createWindow({ incognito: true, url: node.url }) },
        { type: 'separator' },
        { label: 'Edit…', click: () => this.edit(w, node.id) },
      )
    } else if (node?.type === 'folder' && node.id !== OTHER) {
      items.push(
        { label: 'Open all in new tabs', click: () => this.openAll(w, node) },
        { label: 'Open in group', click: () => this.openAll(w, node, { group: true }) },
        { label: 'Open all in new window', click: () => this.openAll(w, node, { newWindow: true }) },
        { label: 'Open all in private window', click: () => this.openAll(w, node, { incognito: true }) },
        { type: 'separator' },
        { label: 'Rename…', click: () => this.edit(w, node.id) },
      )
    }
    if (node && node.id !== OTHER) {
      items.push({ label: 'Delete', click: () => this.store.remove(node.id) }, { type: 'separator' })
    }
    const addParent = node?.id === OTHER ? OTHER : parentId
    const addIndex = node?.id === OTHER ? undefined : index
    items.push(
      {
        label: 'Add page…',
        click: () => {
          const tab = w.activeTab
          const created = this.store.add(addParent, { type: 'bookmark', title: tab?.title || 'New bookmark', url: tab?.url || 'https://' }, addIndex)
          this.edit(w, created.id, { isNew: true })
        },
      },
      {
        label: 'Add folder…',
        click: () => {
          const created = this.store.add(addParent, { type: 'folder', title: 'New folder' }, addIndex)
          this.edit(w, created.id, { isNew: true })
        },
      },
      { type: 'separator' },
      ...this.managementItems(w),
    )
    w.popup.menu(items, x, y)
  }

  /** Shared by the bar's context menu and the app menu. */
  managementItems(w: BrowserWindowController): MenuItemConstructorOptions[] {
    return [
      {
        label: 'Show bookmarks bar',
        type: 'checkbox',
        accelerator: 'CmdOrCtrl+Shift+B',
        checked: getSettings().showBookmarksBar,
        click: () => this.toggleBar(),
      },
      { label: 'Import bookmarks from Firefox…', click: () => this.importFromFirefox(w) },
      { label: 'Import bookmarks from HTML file…', click: () => this.importFromHtml(w) },
      { label: 'Export bookmarks to HTML file…', click: () => this.exportHtml(w) },
    ]
  }

  /** "Bookmarks" submenu for the ☰ menu: actions plus the full tree. */
  appMenu(w: BrowserWindowController): MenuItemConstructorOptions[] {
    const tab = w.activeTab
    const bookmarked = !!tab?.url && this.store.isBookmarked(tab.url)
    return [
      { label: bookmarked ? 'Edit bookmark for this page…' : 'Bookmark this page…', accelerator: 'CmdOrCtrl+D', click: () => this.bookmarkActiveTab(w) },
      { label: 'Bookmark all tabs…', click: () => this.bookmarkAllTabs(w) },
      { type: 'separator' },
      ...this.managementItems(w),
      { type: 'separator' },
      { label: 'Bookmarks bar', submenu: this.folderMenu(w, this.store.bar) },
      { label: 'Other bookmarks', submenu: this.folderMenu(w, this.store.other) },
    ]
  }

  toggleBar(): void {
    updateSettings((s) => (s.showBookmarksBar = !s.showBookmarksBar))
    this.browser.bookmarksLayoutChanged()
  }

  // ---- Star button ---------------------------------------------------------

  bookmarkActiveTab(w: BrowserWindowController): void {
    const tab = w.activeTab
    if (!tab?.url || !/^(https?|file|ftp):/.test(tab.url)) return
    const existing = this.store.findByUrl(tab.url)[0]
    if (existing) return this.edit(w, existing.id)
    const created = this.store.add(BAR, { type: 'bookmark', title: tab.title || tab.url, url: tab.url })
    void this.store.captureFavicon(tab.url, tab.favicon, tab.session)
    this.edit(w, created.id, { isNew: true })
  }

  private bookmarkAllTabs(w: BrowserWindowController): void {
    const tabs = w.tabs.filter((t) => /^(https?|file):/.test(t.url))
    if (tabs.length === 0) return
    const folder = this.store.add(BAR, {
      type: 'folder',
      title: `Tabs ${new Date().toLocaleDateString()}`,
      children: tabs.map((t) => ({ type: 'bookmark' as const, title: t.title || t.url, url: t.url })),
    })
    for (const t of tabs) void this.store.captureFavicon(t.url, t.favicon, t.session)
    this.edit(w, folder.id, { isNew: true })
  }

  // ---- Edit dialog -----------------------------------------------------------

  private editors = new Map<number, { id: string; isNew: boolean }>()

  edit(w: BrowserWindowController, id: string, opts: { isNew?: boolean } = {}): void {
    const node = this.store.find(id)?.node
    if (!node) return
    const isFolder = node.type === 'folder'
    const dlg = new BrowserWindow({
      parent: w.win,
      modal: true,
      width: 440,
      height: isFolder ? 190 : 250,
      resizable: false,
      minimizable: false,
      maximizable: false,
      show: false,
      title: opts.isNew ? (isFolder ? 'New folder' : 'Bookmark added') : isFolder ? 'Rename folder' : 'Edit bookmark',
      autoHideMenuBar: true,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#12162b' : '#ffffff',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'editor-preload.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    dlg.setMenuBarVisibility(false)
    const wcId = dlg.webContents.id
    this.editors.set(wcId, { id, isNew: !!opts.isNew })
    dlg.on('closed', () => this.editors.delete(wcId))
    denyWindowOpen(dlg.webContents)
    dlg.loadFile(path.join(__dirname, '..', 'renderer', 'bookmark-editor.html'))
    dlg.once('ready-to-show', () => dlg.show())
  }

  private registerEditorIpc(): void {
    ipcMain.handle('bookmark-editor:get', (event) => {
      const session = this.editors.get(event.sender.id)
      const found = session && this.store.find(session.id)
      if (!found) return null
      const { node, parent } = found
      return {
        isNew: session.isNew,
        folder: node.type === 'folder',
        title: node.title,
        url: node.url ?? '',
        parentId: parent?.id ?? BAR,
        // A folder can't be moved into itself, so its own subtree is left out.
        folders: this.store.folders().filter((f) => node.type !== 'folder' || !isInside(this.store, f.id, node)),
      }
    })
    ipcMain.handle('bookmark-editor:save', (event, patch: { title: string; url?: string; parentId: string }) => {
      const session = this.editors.get(event.sender.id)
      if (!session) return
      const found = this.store.find(session.id)
      if (found) {
        const url = patch.url?.trim()
        this.store.update(session.id, { title: patch.title.trim() || found.node.title, ...(url ? { url: normalizeUrl(url) } : {}) })
        if (patch.parentId && patch.parentId !== found.parent?.id) this.store.move(session.id, patch.parentId)
      }
      BrowserWindow.fromWebContents(event.sender)?.close()
    })
    ipcMain.handle('bookmark-editor:remove', (event) => {
      const session = this.editors.get(event.sender.id)
      if (session) this.store.remove(session.id)
      BrowserWindow.fromWebContents(event.sender)?.close()
    })
    ipcMain.handle('bookmark-editor:cancel', (event) => {
      BrowserWindow.fromWebContents(event.sender)?.close()
    })
  }

  // ---- Import / export ---------------------------------------------------------

  private async report(w: BrowserWindowController, source: string, result: ImportResult): Promise<void> {
    const parts = [`${result.bookmarks} bookmark${result.bookmarks === 1 ? '' : 's'}`]
    if (result.folders) parts.push(`${result.folders} folder${result.folders === 1 ? '' : 's'}`)
    await dialog.showMessageBox(w.win, {
      type: 'info',
      message: result.bookmarks ? `Imported ${parts.join(' in ')} from ${source}.` : `No new bookmarks to import from ${source}.`,
      detail: [
        result.duplicates ? `${result.duplicates} already-bookmarked page${result.duplicates === 1 ? ' was' : 's were'} skipped.` : '',
        result.bookmarks ? 'Toolbar bookmarks are on your bookmarks bar; the rest are under Other bookmarks › Imported from ' + source + '.' : '',
      ]
        .filter(Boolean)
        .join('\n'),
    })
    if (result.bookmarks && !getSettings().showBookmarksBar) this.toggleBar()
  }

  async importFromFirefox(w: BrowserWindowController): Promise<void> {
    const profiles = findFirefoxProfiles()
    if (profiles.length === 0) {
      const { response } = await dialog.showMessageBox(w.win, {
        type: 'info',
        buttons: ['Choose HTML file…', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        message: "Couldn't find Firefox on this computer.",
        detail:
          'If Firefox is on another computer, export from there: in Firefox press Ctrl+Shift+O (Cmd+Shift+O on Mac) → Import and Backup → Export Bookmarks to HTML…, then import that file here.',
      })
      if (response === 0) await this.importFromHtml(w)
      return
    }
    let profile = profiles[0]
    if (profiles.length > 1) {
      const { response } = await dialog.showMessageBox(w.win, {
        type: 'question',
        buttons: [...profiles.map((p) => (p.isDefault ? `${p.name} (default)` : p.name)), 'Cancel'],
        cancelId: profiles.length,
        defaultId: 0,
        message: 'Which Firefox profile do you want to import from?',
      })
      if (response === profiles.length) return
      profile = profiles[response]
    }
    try {
      const result = mergeImport(this.store, readFirefoxBookmarks(profile.dir), 'Firefox')
      await this.report(w, 'Firefox', result)
    } catch (err) {
      dialog.showErrorBox(
        'Import from Firefox failed',
        `${err instanceof Error ? err.message : String(err)}\n\nIf Firefox is open, close it and try again.`,
      )
    }
  }

  async importFromHtml(w: BrowserWindowController): Promise<void> {
    const { canceled, filePaths } = await dialog.showOpenDialog(w.win, {
      title: 'Import bookmarks',
      properties: ['openFile'],
      filters: [{ name: 'Bookmarks HTML', extensions: ['html', 'htm'] }],
    })
    if (canceled || !filePaths[0]) return
    try {
      const tree = parseBookmarksHtml(fs.readFileSync(filePaths[0], 'utf8'))
      await this.report(w, 'HTML file', mergeImport(this.store, tree, 'HTML file'))
    } catch (err) {
      dialog.showErrorBox('Import failed', err instanceof Error ? err.message : String(err))
    }
  }

  async exportHtml(w: BrowserWindowController): Promise<void> {
    const { canceled, filePath } = await dialog.showSaveDialog(w.win, {
      title: 'Export bookmarks',
      defaultPath: `bookmarks-${new Date().toISOString().slice(0, 10)}.html`,
      filters: [{ name: 'Bookmarks HTML', extensions: ['html'] }],
    })
    if (canceled || !filePath) return
    fs.writeFileSync(filePath, exportBookmarksHtml(this.store))
  }
}

function isInside(store: BookmarkStore, candidateId: string, folder: BookmarkNode): boolean {
  if (candidateId === folder.id) return true
  return (folder.children ?? []).some((c) => c.type === 'folder' && isInside(store, candidateId, c))
}

function normalizeUrl(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url
  return `https://${url}`
}

/** Native menus treat "&" as a mnemonic marker. */
function menuLabel(text: string): string {
  const t = text.length > 60 ? `${text.slice(0, 57)}…` : text
  return t.replace(/&/g, '&&')
}
