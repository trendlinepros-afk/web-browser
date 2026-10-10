// Types shared between the main process, the UI preload and the UI renderer.

export interface TabInfo {
  id: number
  title: string
  url: string
  favicon: string | null
  loading: boolean
  sleeping: boolean
  audible: boolean
  muted: boolean
  pinned: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** True while Claude (via MCP) has recently driven this tab. */
  controlled: boolean
  /** Ads/trackers blocked on the current page. */
  blocked: number
  /** Whether ad/tracker blocking applies to this page (off for allowlisted sites). */
  blockingActive: boolean
  /** The page is bookmarked (filled star). */
  bookmarked: boolean
}

export interface BookmarkItem {
  id: string
  title: string
  url: string | null
  favicon: string | null
  folder: boolean
}

export interface BookmarkBarState {
  visible: boolean
  items: BookmarkItem[]
  /** Number of entries under "Other bookmarks" (its button shows when > 0). */
  otherCount: number
}

export type OpenDisposition = 'current' | 'foreground-tab' | 'background-tab'

export interface WindowState {
  windowId: number
  incognito: boolean
  /** Session partition the extension toolbar should read from; null when extensions are off. */
  extensionPartition: string | null
  activeTabId: number | null
  tabs: TabInfo[]
  mcpEnabled: boolean
  /** System accent color (#rrggbb) on Windows/macOS, else null. */
  accent: string | null
}

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'not-available'; version: string }
  | { state: 'available'; version: string }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string }
  | { state: 'unsupported'; message: string }

/** API exposed to the browser UI via contextBridge as `window.browser`. */
export interface UiApi {
  newTab(url?: string): void
  closeTab(tabId: number): void
  activateTab(tabId: number): void
  navigate(tabId: number, input: string): void
  goBack(tabId: number): void
  goForward(tabId: number): void
  reload(tabId: number): void
  stop(tabId: number): void
  toggleMute(tabId: number): void
  showAppMenu(x: number, y: number): void
  showTabMenu(tabId: number): void
  showShieldMenu(x: number, y: number): void
  /** Star button / Ctrl+D: bookmark the active page, or edit its bookmark. */
  bookmarkActiveTab(): void
  openBookmark(id: string, disposition: OpenDisposition): void
  /** Drop-down for a folder on the bar (or "other" for Other bookmarks). */
  showBookmarkFolder(id: string, x: number, y: number): void
  showBookmarkContextMenu(id: string | null, x: number, y: number): void
  /** The » button: bar items that didn't fit. */
  showBookmarkOverflow(ids: string[], x: number, y: number): void
  moveBookmark(id: string, parentId: string, index: number): void
  importFirefoxBookmarks(): void
  onBookmarks(cb: (bar: BookmarkBarState) => void): void
  onState(cb: (state: WindowState) => void): void
  onFocusAddressBar(cb: () => void): void
  ready(): void
}
