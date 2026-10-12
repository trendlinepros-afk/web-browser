import { ipcMain, Menu, MenuItem, nativeImage, WebContentsView, type MenuItemConstructorOptions, type WebContents } from 'electron'
import path from 'node:path'
import type { PopupItem, PopupModifiers, SettingsModel } from '../shared/types'
import type { BrowserWindowController } from './window'
import { integratedTitleBar, uiPlatform } from './theme'

export type PopupTemplate = (MenuItemConstructorOptions | MenuItem)[]

type Handler = (mods: PopupModifiers) => void


const ROLE_LABELS: Record<string, [string, string]> = {
  undo: ['Undo', 'Ctrl+Z'],
  redo: ['Redo', 'Ctrl+Y'],
  cut: ['Cut', 'Ctrl+X'],
  copy: ['Copy', 'Ctrl+C'],
  paste: ['Paste', 'Ctrl+V'],
  pasteandmatchstyle: ['Paste as plain text', 'Ctrl+Shift+V'],
  selectall: ['Select all', 'Ctrl+A'],
  delete: ['Delete', ''],
}

function displayAccelerator(acc: unknown): string | undefined {
  if (typeof acc !== 'string' || !acc) return undefined
  const mac = process.platform === 'darwin'
  return acc
    .replace(/CmdOrCtrl|CommandOrControl/g, mac ? '⌘' : 'Ctrl')
    .replace(/Plus$/, '+')
    .replace(/\+/g, mac ? '' : '+')
}

/**
 * Zirtola's own menus and panels. Native OS menus (and Chrome-style layouts) are replaced by a
 * transparent overlay view per window that draws them in Zirtola's style. Existing menu templates
 * (including MenuItems supplied by extensions) are converted, so callers keep the familiar API.
 * The overlay is created on first use and then kept, so later menus open instantly.
 */
export class PopupHost {
  /**
   * One overlay for the whole app, moved to whichever window opens a menu. Each window gets a
   * cheap PopupHost handle. (Closing an overlay's page while its window closes deadlocks Electron,
   * so a shared overlay that never needs closing is both safer and lighter.)
   */
  private static view: WebContentsView | null = null
  private static loaded: Promise<void> | null = null
  /** The host whose menu or panel is showing; receives the overlay's IPC. */
  private static current: PopupHost | null = null

  private handlers = new Map<number, Handler>()
  private nextId = 1
  private openKind: 'menu' | 'settings' | null = null
  private restoreFocus: WebContents | null = null
  onSetting: ((key: string, value: unknown) => void) | null = null
  onAction: ((name: string) => void) | null = null

  constructor(private readonly w: BrowserWindowController) {}

  static register(): void {
    const host = (e: Electron.IpcMainEvent) => (e.sender === PopupHost.view?.webContents ? PopupHost.current : null)
    ipcMain.on('overlay:invoke', (e, id: number, mods: PopupModifiers) => host(e)?.invoke(id, mods))
    ipcMain.on('overlay:close', (e) => host(e)?.close())
    ipcMain.on('overlay:setting', (e, key: string, value: unknown) => host(e)?.onSetting?.(key, value))
    ipcMain.on('overlay:action', (e, name: string) => host(e)?.onAction?.(name))
  }

  get isOpen(): boolean {
    return this.openKind !== null
  }

  private static ensure(): Promise<void> {
    if (PopupHost.loaded) return PopupHost.loaded
    const view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'overlay-preload.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    })
    view.setBackgroundColor('#00000000')
    view.setVisible(false)
    PopupHost.view = view
    PopupHost.loaded = view.webContents
      .loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'), {
        query: { platform: uiPlatform, frame: integratedTitleBar ? 'integrated' : 'native' },
      })
      .then(() => undefined)
    return PopupHost.loaded
  }

  private async open(kind: 'menu' | 'settings', channel: string, payload: object): Promise<void> {
    await PopupHost.ensure()
    const view = PopupHost.view!
    const win = this.w.win
    if (win.isDestroyed()) return
    if (PopupHost.current && PopupHost.current !== this) PopupHost.current.close()
    PopupHost.current = this
    const [width, height] = win.getContentSize()
    // Adding moves the overlay into this window (if needed) and above every tab view.
    win.contentView.addChildView(view)
    view.setBounds({ x: 0, y: 0, width, height })
    view.setVisible(true)
    this.openKind = kind
    this.restoreFocus = this.w.activeTab?.webContents ?? null
    view.webContents.focus()
    view.webContents.send(channel, { ...payload, incognito: this.w.incognito })
  }

  /** Shows a menu at (x, y) in window coordinates. `target` receives edit roles (copy, paste…). */
  menu(template: PopupTemplate, x: number, y: number, opts: { target?: WebContents; align?: 'left' | 'right' } = {}): void {
    this.handlers.clear()
    const items = this.convert(template, opts.target)
    void this.open('menu', 'overlay:show-menu', { items, x: Math.round(x), y: Math.round(y), align: opts.align ?? 'left' })
  }

  settings(model: SettingsModel): void {
    void this.open('settings', 'overlay:show-settings', model)
  }

  /** Pushes fresh values into an open settings panel. */
  updateSettings(model: SettingsModel): void {
    if (this.openKind === 'settings' && PopupHost.current === this) PopupHost.view?.webContents.send('overlay:update-settings', model)
  }

  close(): void {
    if (!this.openKind) return
    this.openKind = null
    if (PopupHost.current === this) {
      PopupHost.view?.setVisible(false)
      PopupHost.view?.webContents.send('overlay:hide')
    }
    const focus = this.restoreFocus
    this.restoreFocus = null
    if (focus && !focus.isDestroyed()) focus.focus()
  }

  layout(): void {
    if (!this.openKind || PopupHost.current !== this || !PopupHost.view) return
    const [width, height] = this.w.win.getContentSize()
    PopupHost.view.setBounds({ x: 0, y: 0, width, height })
  }

  /** The window is closing: hand the shared overlay back (it is reused by the next window that needs it). */
  destroy(): void {
    this.close()
    const view = PopupHost.view
    if (view && !this.w.win.isDestroyed() && this.w.win.contentView.children.includes(view)) this.w.win.contentView.removeChildView(view)
    if (PopupHost.current === this) PopupHost.current = null
    this.handlers.clear()
  }

  private invoke(id: number, mods: PopupModifiers): void {
    const handler = this.handlers.get(id)
    this.close()
    // Run after the overlay is gone so dialogs and focus changes land on the right window.
    if (handler) setImmediate(() => handler(mods))
  }

  // ---- Template conversion ---------------------------------------------------

  private convert(template: PopupTemplate, target?: WebContents): PopupItem[] {
    const out: PopupItem[] = []
    for (const raw of template) {
      const item = raw instanceof MenuItem ? fromMenuItem(raw) : raw
      if (item.visible === false) continue
      if (item.type === 'separator') {
        if (out.length && out[out.length - 1].type !== 'separator') out.push({ id: 0, type: 'separator', label: '', enabled: false })
        continue
      }

      const role = item.role ? String(item.role).toLowerCase() : null
      const roleInfo = role ? ROLE_LABELS[role] : undefined
      const label = item.label ?? roleInfo?.[0] ?? ''
      const id = this.nextId++
      const submenu = item.submenu instanceof Menu ? item.submenu.items : (item.submenu as PopupTemplate | undefined)
      const enabled = item.enabled !== false
      const popupItem: PopupItem = {
        id,
        type: submenu ? 'submenu' : item.type === 'checkbox' || item.type === 'radio' ? item.type : 'normal',
        label: label.replace(/&&/g, '&'),
        sublabel: item.sublabel,
        accelerator: displayAccelerator(item.accelerator) ?? roleInfo?.[1] ?? undefined,
        checked: item.checked,
        enabled,
        icon: iconDataUrl(item.icon),
        danger: /^(delete|remove|close other|close tabs)/i.test(label),
        note: !enabled && !item.click && !role && !submenu,
      }
      if (submenu) popupItem.children = this.convert(submenu, target)

      const click = item.click
      if (role && target) {
        const action = { undo: 'undo', redo: 'redo', cut: 'cut', copy: 'copy', paste: 'paste', pasteandmatchstyle: 'pasteAndMatchStyle', selectall: 'selectAll', delete: 'delete' }[role] as
          | keyof Pick<WebContents, 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'pasteAndMatchStyle' | 'selectAll' | 'delete'>
          | undefined
        if (action) this.handlers.set(id, () => target[action]())
      } else if (click) {
        const checked = item.checked
        const type = item.type
        this.handlers.set(id, (mods) => {
          const fakeItem = { checked: type === 'radio' ? true : type === 'checkbox' ? !checked : checked }
          const event = { ctrlKey: mods.ctrl, shiftKey: mods.shift, metaKey: mods.meta, altKey: mods.alt, triggeredByAccelerator: false }
          ;(click as (item: unknown, win: unknown, event: unknown) => void)(fakeItem, this.w.win, event)
        })
      }
      out.push(popupItem)
    }
    while (out.length && out[out.length - 1].type === 'separator') out.pop()
    return out
  }
}

/** MenuItems (e.g. from the extensions layer) carry their own click wrapper; adapt them to template form. */
function fromMenuItem(item: MenuItem): MenuItemConstructorOptions {
  return {
    label: item.label,
    sublabel: item.sublabel,
    type: item.type,
    role: item.role,
    checked: item.checked,
    enabled: item.enabled,
    visible: item.visible,
    icon: item.icon,
    accelerator: item.accelerator,
    submenu: item.submenu?.items,
    click: item.type === 'submenu' ? undefined : (_i, win, event) => item.click(event, win as Electron.BaseWindow, undefined),
  } as MenuItemConstructorOptions
}

function iconDataUrl(icon: unknown): string | undefined {
  if (!icon) return undefined
  try {
    const img = typeof icon === 'string' ? nativeImage.createFromPath(icon) : (icon as Electron.NativeImage)
    return img.isEmpty() ? undefined : img.resize({ width: 32, height: 32 }).toDataURL()
  } catch {
    return undefined
  }
}
