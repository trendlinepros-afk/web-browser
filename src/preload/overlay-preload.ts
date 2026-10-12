// Preload for the overlay that draws Zirtola's menus and settings panel.
import { contextBridge, ipcRenderer } from 'electron'
import type { PopupItem, PopupModifiers, SettingsModel } from '../shared/types'

contextBridge.exposeInMainWorld('overlay', {
  onShowMenu: (cb: (m: { items: PopupItem[]; x: number; y: number; align: 'left' | 'right' }) => void) =>
    ipcRenderer.on('overlay:show-menu', (_e, m) => cb(m)),
  onShowSettings: (cb: (m: SettingsModel) => void) => ipcRenderer.on('overlay:show-settings', (_e, m) => cb(m)),
  onUpdateSettings: (cb: (m: SettingsModel) => void) => ipcRenderer.on('overlay:update-settings', (_e, m) => cb(m)),
  onHide: (cb: () => void) => ipcRenderer.on('overlay:hide', () => cb()),
  invoke: (id: number, mods: PopupModifiers) => ipcRenderer.send('overlay:invoke', id, mods),
  close: () => ipcRenderer.send('overlay:close'),
  setSetting: (key: string, value: unknown) => ipcRenderer.send('overlay:setting', key, value),
  action: (name: string) => ipcRenderer.send('overlay:action', name),
})
