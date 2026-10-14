// Preload for the overlay that draws Zirtola's menus and settings panel.
import { contextBridge, ipcRenderer } from 'electron'
import type { ChatState, PopupItem, PopupModifiers, PromptSpec, SettingsModel } from '../shared/types'

contextBridge.exposeInMainWorld('overlay', {
  onShowMenu: (cb: (m: { items: PopupItem[]; x: number; y: number; align: 'left' | 'right' }) => void) =>
    ipcRenderer.on('overlay:show-menu', (_e, m) => cb(m)),
  onShowSettings: (cb: (m: SettingsModel) => void) => ipcRenderer.on('overlay:show-settings', (_e, m) => cb(m)),
  onUpdateSettings: (cb: (m: SettingsModel) => void) => ipcRenderer.on('overlay:update-settings', (_e, m) => cb(m)),
  onHide: (cb: () => void) => ipcRenderer.on('overlay:hide', () => cb()),
  onShowPrompt: (cb: (p: PromptSpec & { incognito?: boolean }) => void) => ipcRenderer.on('overlay:show-prompt', (_e, p) => cb(p)),
  answer: (index: number) => ipcRenderer.send('overlay:answer', index),
  invoke: (id: number, mods: PopupModifiers) => ipcRenderer.send('overlay:invoke', id, mods),
  close: () => ipcRenderer.send('overlay:close'),
  setSetting: (key: string, value: unknown) => ipcRenderer.send('overlay:setting', key, value),
  action: (name: string) => ipcRenderer.send('overlay:action', name),
  onShowChat: (cb: (m: { state: ChatState; x: number; y: number; incognito?: boolean }) => void) => ipcRenderer.on('overlay:show-chat', (_e, m) => cb(m)),
  onUpdateChat: (cb: (s: ChatState) => void) => ipcRenderer.on('overlay:update-chat', (_e, s) => cb(s)),
  chat: (op: 'send' | 'stop' | 'new' | 'login', text?: string) => ipcRenderer.send('overlay:chat', op, text),
})
