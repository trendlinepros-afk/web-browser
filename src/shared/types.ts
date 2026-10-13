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
  /** The tab group this tab belongs to, if any. A group's tabs are always next to each other. */
  groupId: number | null
}

export const GROUP_COLORS = ['violet', 'blue', 'cyan', 'green', 'yellow', 'orange', 'pink', 'red', 'grey'] as const
export type GroupColor = (typeof GROUP_COLORS)[number]

export interface TabGroupInfo {
  id: number
  title: string
  color: GroupColor
  /** Collapsed groups show only their label in the tab strip. */
  collapsed: boolean
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
  showHomeButton: boolean
  groups: TabGroupInfo[]
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
  goHome(tabId: number): void
  /** Drag and drop in the tab strip: put the tab before another (null: at the end), in a group or none. */
  moveTab(tabId: number, beforeTabId: number | null, groupId: number | null): void
  moveGroup(groupId: number, beforeTabId: number | null): void
  showGroupMenu(groupId: number, x: number, y: number): void
  toggleGroupCollapsed(groupId: number): void
  renameGroup(groupId: number, title: string): void
  /** Main asks the UI to start editing a group's name (e.g. right after creating it). */
  onRenameGroup(cb: (groupId: number) => void): void
  goForward(tabId: number): void
  reload(tabId: number): void
  stop(tabId: number): void
  toggleMute(tabId: number): void
  showAppMenu(x: number, y: number): void
  showTabMenu(tabId: number, x: number, y: number): void
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

// ---- Zirtola popups (custom menus and the settings panel) ----------------------

export interface PopupItem {
  id: number
  type: 'normal' | 'separator' | 'checkbox' | 'radio' | 'submenu'
  label: string
  sublabel?: string
  accelerator?: string
  checked?: boolean
  enabled: boolean
  /** data: URL */
  icon?: string
  /** Destructive action (shown in red). */
  danger?: boolean
  /** Informational line, not clickable. */
  note?: boolean
  children?: PopupItem[]
}

/** A question shown in Zirtola's style (permission requests, confirmations). */
export interface PromptSpec {
  kind: 'permission' | 'info' | 'warning'
  /** Specific icon for permission prompts. */
  icon?: 'location' | 'camera' | 'mic' | 'bell' | 'clipboard' | 'screen' | 'lock'
  title: string
  message: string
  detail?: string
  buttons: string[]
  defaultId: number
  /** Returned when dismissed (Esc / click outside). */
  cancelId: number
}

export interface PopupModifiers {
  ctrl: boolean
  shift: boolean
  meta: boolean
  alt: boolean
}

export type SettingsControl =
  | { kind: 'toggle'; key: string; label: string; description?: string; value: boolean }
  | { kind: 'select'; key: string; label: string; description?: string; value: string; options: { value: string; label: string }[] }
  | { kind: 'button'; action: string; label: string; description?: string; style?: 'primary' | 'danger' }
  | { kind: 'info'; label: string; value: string }
  | { kind: 'text'; key: string; label: string; description?: string; value: string; placeholder?: string }

export interface SettingsSection {
  id: string
  title: string
  /** One line under the section's heading. */
  subtitle?: string
  controls: SettingsControl[]
}

export interface SettingsModel {
  version: string
  sections: SettingsSection[]
  /** Section to scroll to when opening. */
  focus?: string
}
