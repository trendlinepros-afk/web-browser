// Preload for the bookmark edit dialog.
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('editor', {
  get: () => ipcRenderer.invoke('bookmark-editor:get'),
  save: (patch: { title: string; url?: string; parentId: string }) => ipcRenderer.invoke('bookmark-editor:save', patch),
  remove: () => ipcRenderer.invoke('bookmark-editor:remove'),
  cancel: () => ipcRenderer.invoke('bookmark-editor:cancel'),
})
