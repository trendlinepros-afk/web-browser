// Preload for the browser UI (tab strip + toolbar). Exposes a small, explicit API; no Node access leaks to the page.
import { contextBridge, ipcRenderer } from 'electron'
import { injectBrowserAction } from 'electron-chrome-extensions/browser-action'
import type { BookmarkBarState, UiApi, WindowState } from '../shared/types'

// Registers the <browser-action-list> element used for extension toolbar buttons.
injectBrowserAction()

const send = (name: string, ...args: unknown[]) => ipcRenderer.send('ui:cmd', name, ...args)

const api: UiApi = {
  newTab: (url) => send('newTab', url),
  closeTab: (id) => send('closeTab', id),
  activateTab: (id) => send('activateTab', id),
  navigate: (id, input) => send('navigate', id, input),
  goBack: (id) => send('goBack', id),
  goHome: (id) => send('goHome', id),
  openChat: (x, y) => send('openChat', x, y),
  moveTab: (id, beforeId, groupId) => send('moveTab', id, beforeId, groupId),
  moveGroup: (groupId, beforeId) => send('moveGroup', groupId, beforeId),
  showGroupMenu: (groupId, x, y) => send('showGroupMenu', groupId, x, y),
  toggleGroupCollapsed: (groupId) => send('toggleGroupCollapsed', groupId),
  renameGroup: (groupId, title) => send('renameGroup', groupId, title),
  onRenameGroup: (cb) => {
    ipcRenderer.on('ui:rename-group', (_e, groupId: number) => cb(groupId))
  },
  goForward: (id) => send('goForward', id),
  reload: (id) => send('reload', id),
  stop: (id) => send('stop', id),
  toggleMute: (id) => send('toggleMute', id),
  showAppMenu: (x, y) => send('showAppMenu', x, y),
  showTabMenu: (id, x, y) => send('showTabMenu', id, x, y),
  showShieldMenu: (x, y) => send('showShieldMenu', x, y),
  bookmarkActiveTab: () => send('bookmarkActiveTab'),
  openBookmark: (id, disposition) => send('bookmark:open', id, disposition),
  showBookmarkFolder: (id, x, y) => send('bookmark:folder', id, x, y),
  showBookmarkContextMenu: (id, x, y) => send('bookmark:context', id, x, y),
  showBookmarkOverflow: (ids, x, y) => send('bookmark:overflow', ids, x, y),
  moveBookmark: (id, parentId, index) => send('bookmark:move', id, parentId, index),
  importFirefoxBookmarks: () => send('bookmark:import-firefox'),
  onBookmarks: (cb) => {
    ipcRenderer.on('ui:bookmarks', (_e, bar: BookmarkBarState) => cb(bar))
  },
  onState: (cb) => {
    ipcRenderer.on('ui:state', (_e, state: WindowState) => cb(state))
  },
  onFocusAddressBar: (cb) => {
    ipcRenderer.on('ui:focus-address-bar', () => cb())
  },
  ready: () => send('ready'),
}

contextBridge.exposeInMainWorld('browser', api)
