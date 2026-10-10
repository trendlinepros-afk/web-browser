// Browser UI: tab strip + toolbar. Plain DOM, no framework; state is pushed from the main process.
import type { BookmarkBarState, BookmarkItem, OpenDisposition, TabInfo, UiApi, WindowState } from '../shared/types'

declare global {
  interface Window {
    browser: UiApi
  }
}

const api = window.browser

const ICONS = {
  back: '<svg viewBox="0 0 24 24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20z"/></svg>',
  forward: '<svg viewBox="0 0 24 24"><path d="M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z"/></svg>',
  reload:
    '<svg viewBox="0 0 24 24"><path d="M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4z"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z"/></svg>',
  menu: '<svg viewBox="0 0 24 24"><path d="M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4m0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4m0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>',
  audio:
    '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05A4.47 4.47 0 0 0 16.5 12M14 3.23v2.06a7 7 0 0 1 0 13.42v2.06A9 9 0 0 0 14 3.23"/></svg>',
  shield: '<svg viewBox="0 0 24 24"><path d="M12 2 4 5v6.09c0 5.05 3.41 9.76 8 10.91 4.59-1.15 8-5.86 8-10.91V5zm0 2.18 6 2.25v4.66c0 4-2.55 7.7-6 8.83-3.45-1.13-6-4.82-6-8.83V6.43z"/><path d="M12 6.5 8 8v3.2c0 2.7 1.7 5.2 4 6.05z"/></svg>',
  star: '<svg viewBox="0 0 24 24"><path d="m22 9.24-7.19-.62L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.03zM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28z"/></svg>',
  starFilled: '<svg viewBox="0 0 24 24"><path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8z"/></svg>',
  globe:
    '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m-1 17.93A8 8 0 0 1 4 12c0-.62.08-1.21.21-1.79L9 15v1a2 2 0 0 0 2 2zm6.9-2.54A2 2 0 0 0 16 16h-1v-3a1 1 0 0 0-1-1H8v-2h2a1 1 0 0 0 1-1V7h2a2 2 0 0 0 2-2v-.41A8 8 0 0 1 20 12c0 2.08-.8 3.97-2.1 5.39"/></svg>',
  chevron: '<svg viewBox="0 0 24 24"><path d="M5.59 7.41 10.18 12l-4.59 4.59L7 18l6-6-6-6zM12.59 7.41 17.18 12l-4.59 4.59L14 18l6-6-6-6z"/></svg>',
  muted:
    '<svg viewBox="0 0 24 24"><path d="M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45q.05-.3.05-.63m2.5 0q0 1.41-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12a9 9 0 0 0-7-8.77v2.06A7 7 0 0 1 19 12M4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a9 9 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9zM12 4 9.91 6.09 12 8.18z"/></svg>',
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const tabsEl = $<HTMLDivElement>('tabs')
const address = $<HTMLInputElement>('address')
const addressForm = $<HTMLFormElement>('address-form')
const backBtn = $<HTMLButtonElement>('back')
const forwardBtn = $<HTMLButtonElement>('forward')
const reloadBtn = $<HTMLButtonElement>('reload')
const menuBtn = $<HTMLButtonElement>('menu')
const newTabBtn = $<HTMLButtonElement>('new-tab')
const mcpBadge = $<HTMLSpanElement>('mcp-badge')
const shieldBtn = $<HTMLButtonElement>('shield')
const starBtn = $<HTMLButtonElement>('star')
const bookmarksBar = $<HTMLDivElement>('bookmarks-bar')
const bmItems = $<HTMLDivElement>('bm-items')
const bmEmpty = $<HTMLSpanElement>('bm-empty')
const bmOverflow = $<HTMLButtonElement>('bm-overflow')
const bmOther = $<HTMLButtonElement>('bm-other')
bmOverflow.innerHTML = ICONS.chevron
bmOther.insertAdjacentHTML('afterbegin', ICONS.folder)
const extensionsEl = $<HTMLDivElement>('extensions')

backBtn.innerHTML = ICONS.back
forwardBtn.innerHTML = ICONS.forward
reloadBtn.innerHTML = ICONS.reload
menuBtn.innerHTML = ICONS.menu
newTabBtn.innerHTML = ICONS.plus

const incognito = new URLSearchParams(location.search).get('incognito') === '1'
document.body.classList.toggle('incognito', incognito)
$('incognito-badge').hidden = !incognito

let state: WindowState | null = null
/** True while the user is editing the address bar; we must not overwrite their typing. */
let editing = false

const active = (): TabInfo | undefined => state?.tabs.find((t) => t.id === state?.activeTabId)

// ---- Rendering ------------------------------------------------------------

const tabEls = new Map<number, HTMLDivElement>()

function renderTab(el: HTMLDivElement, tab: TabInfo, isActive: boolean): void {
  const key = [tab.title, tab.favicon, tab.loading, tab.sleeping, tab.audible, tab.muted, tab.pinned, tab.controlled, isActive].join('|')
  if (el.dataset.key === key) return
  el.dataset.key = key

  el.className = 'tab'
  el.classList.toggle('active', isActive)
  el.classList.toggle('sleeping', tab.sleeping)
  el.classList.toggle('pinned', tab.pinned)
  el.setAttribute('role', 'tab')
  el.setAttribute('aria-selected', String(isActive))
  el.title = tab.sleeping ? `${tab.title}\n(sleeping to save memory)` : tab.title

  el.replaceChildren()
  if (tab.loading) {
    el.append(Object.assign(document.createElement('div'), { className: 'spinner' }))
  } else if (tab.favicon) {
    const img = Object.assign(document.createElement('img'), { className: 'favicon', src: tab.favicon, alt: '' })
    img.onerror = () => img.replaceWith(Object.assign(document.createElement('div'), { className: 'favicon placeholder' }))
    el.append(img)
  } else {
    el.append(Object.assign(document.createElement('div'), { className: 'favicon placeholder' }))
  }

  el.append(Object.assign(document.createElement('span'), { className: 'title', textContent: tab.title || 'New Tab' }))

  if (tab.controlled) {
    el.append(Object.assign(document.createElement('span'), { className: 'claude-dot', title: 'Claude is controlling this tab' }))
  }
  if (tab.audible || tab.muted) {
    const audio = Object.assign(document.createElement('button'), {
      className: 'audio',
      innerHTML: tab.muted ? ICONS.muted : ICONS.audio,
      title: tab.muted ? 'Unmute tab' : 'Mute tab',
    })
    audio.onclick = (e) => {
      e.stopPropagation()
      api.toggleMute(tab.id)
    }
    el.append(audio)
  }

  const close = Object.assign(document.createElement('button'), { className: 'close', innerHTML: ICONS.close, title: 'Close tab' })
  close.onclick = (e) => {
    e.stopPropagation()
    api.closeTab(tab.id)
  }
  el.append(close)
}

function render(): void {
  if (!state) return
  const ids = new Set(state.tabs.map((t) => t.id))
  for (const [id, el] of tabEls) {
    if (!ids.has(id)) {
      el.remove()
      tabEls.delete(id)
    }
  }
  state.tabs.forEach((tab, index) => {
    let el = tabEls.get(tab.id)
    if (!el) {
      el = document.createElement('div')
      el.dataset.id = String(tab.id)
      tabEls.set(tab.id, el)
    }
    if (tabsEl.children[index] !== el) tabsEl.insertBefore(el, tabsEl.children[index] ?? null)
    renderTab(el, tab, tab.id === state!.activeTabId)
  })

  const tab = active()
  backBtn.disabled = !tab?.canGoBack
  forwardBtn.disabled = !tab?.canGoForward
  reloadBtn.innerHTML = tab?.loading ? ICONS.stop : ICONS.reload
  reloadBtn.title = tab?.loading ? 'Stop loading' : 'Reload (Ctrl+R)'
  if (!editing) address.value = displayURL(tab?.url ?? '')
  mcpBadge.hidden = !state.mcpEnabled
  renderShield(tab)
  const web = !!tab && /^(https?|file):/.test(tab.url)
  starBtn.hidden = !web
  const starred = !!tab?.bookmarked
  if (starBtn.classList.contains('on') !== starred || !starBtn.innerHTML) {
    starBtn.classList.toggle('on', starred)
    starBtn.innerHTML = starred ? ICONS.starFilled : ICONS.star
    starBtn.title = starred ? 'Edit bookmark (Ctrl+D)' : 'Bookmark this page (Ctrl+D)'
  }
  renderExtensions(state.extensionPartition)
}

let shieldKey = ''
function renderShield(tab: TabInfo | undefined): void {
  const web = !!tab && /^https?:/.test(tab.url)
  const key = `${web}|${tab?.blockingActive}|${tab?.blocked}`
  if (key === shieldKey) return
  shieldKey = key
  shieldBtn.hidden = !web
  if (!tab || !web) return
  shieldBtn.classList.toggle('off', !tab.blockingActive)
  shieldBtn.innerHTML = ICONS.shield + (tab.blockingActive && tab.blocked > 0 ? `<span class="count">${tab.blocked > 99 ? '99+' : tab.blocked}</span>` : '')
  shieldBtn.title = tab.blockingActive ? `${tab.blocked} ads & trackers blocked on this page` : 'Blocking is off for this site'
}

function displayURL(url: string): string {
  return url === 'about:blank' ? '' : url
}

let extensionPartition: string | null | undefined
function renderExtensions(partition: string | null): void {
  if (partition === extensionPartition) return
  extensionPartition = partition
  extensionsEl.replaceChildren()
  if (!partition) return
  const list = document.createElement('browser-action-list')
  list.setAttribute('partition', partition)
  list.setAttribute('alignment', 'bottom left')
  extensionsEl.append(list)
}

// ---- Events ---------------------------------------------------------------

tabsEl.addEventListener('mousedown', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLDivElement>('.tab')
  if (!el || (e.target as HTMLElement).closest('button')) return
  const id = Number(el.dataset.id)
  if (e.button === 0) api.activateTab(id)
})
tabsEl.addEventListener('auxclick', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLDivElement>('.tab')
  if (el && e.button === 1) api.closeTab(Number(el.dataset.id))
})
tabsEl.addEventListener('contextmenu', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLDivElement>('.tab')
  if (!el) return
  e.preventDefault()
  api.showTabMenu(Number(el.dataset.id))
})
$('tabstrip').addEventListener('dblclick', (e) => {
  if (e.target === e.currentTarget || e.target === tabsEl) api.newTab()
})

newTabBtn.onclick = () => api.newTab()
backBtn.onclick = () => state?.activeTabId && api.goBack(state.activeTabId)
forwardBtn.onclick = () => state?.activeTabId && api.goForward(state.activeTabId)
reloadBtn.onclick = () => {
  const tab = active()
  if (!tab) return
  if (tab.loading) api.stop(tab.id)
  else api.reload(tab.id)
}
shieldBtn.onclick = () => {
  const r = shieldBtn.getBoundingClientRect()
  api.showShieldMenu(r.left, r.bottom)
}
menuBtn.onclick = () => {
  const r = menuBtn.getBoundingClientRect()
  api.showAppMenu(r.right - 4, r.bottom)
}

address.addEventListener('focus', () => {
  editing = true
  address.select()
})
address.addEventListener('blur', () => {
  editing = false
  render()
})
address.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    address.value = displayURL(active()?.url ?? '')
    address.select()
  }
})
addressForm.addEventListener('submit', (e) => {
  e.preventDefault()
  const tab = active()
  if (!tab) return
  editing = false
  api.navigate(tab.id, address.value)
  address.blur()
})

// ---- Bookmarks bar ----------------------------------------------------------

let bar: BookmarkBarState | null = null

function bookmarkButton(item: BookmarkItem): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.className = 'bm'
  btn.type = 'button'
  btn.dataset.id = item.id
  btn.draggable = true
  btn.title = item.folder ? item.title : `${item.title}\n${item.url ?? ''}`
  if (item.folder) {
    btn.dataset.folder = '1'
    btn.innerHTML = ICONS.folder
  } else if (item.favicon) {
    const img = Object.assign(document.createElement('img'), { src: item.favicon, alt: '' })
    img.onerror = () => img.replaceWith(Object.assign(document.createElement('span'), { innerHTML: ICONS.globe }).firstChild!)
    btn.append(img)
  } else {
    btn.innerHTML = ICONS.globe
  }
  btn.append(Object.assign(document.createElement('span'), { className: 'title', textContent: item.title }))
  return btn
}

function renderBookmarks(): void {
  if (!bar) return
  bookmarksBar.hidden = !bar.visible
  if (!bar.visible) return
  bmItems.replaceChildren(...bar.items.map(bookmarkButton))
  bmItems.hidden = bar.items.length === 0
  bmEmpty.hidden = bar.items.length > 0
  bmOther.hidden = bar.otherCount === 0
  bmOther.dataset.id = 'other'
  layoutBookmarks()
}

/** Hides items that don't fit and shows the » button for them. */
function layoutBookmarks(): void {
  if (!bar?.visible) return
  const buttons = [...bmItems.children] as HTMLButtonElement[]
  bmOverflow.hidden = true
  for (const b of buttons) b.classList.remove('hidden-overflow')
  const fits = (b: HTMLElement) => b.getBoundingClientRect().right <= bmItems.getBoundingClientRect().right + 0.5
  let overflow = false
  for (const b of buttons) {
    if (!overflow && !fits(b)) overflow = true
    b.classList.toggle('hidden-overflow', overflow)
  }
  if (overflow) {
    // Showing the » button narrows the row: hide more items if they no longer fit.
    bmOverflow.hidden = false
    const visible = buttons.filter((b) => !b.classList.contains('hidden-overflow'))
    while (visible.length && !fits(visible[visible.length - 1])) visible.pop()!.classList.add('hidden-overflow')
  }
}

new ResizeObserver(() => layoutBookmarks()).observe(bmItems)

function dispositionFor(e: MouseEvent): OpenDisposition {
  if (e.button === 1 || e.ctrlKey || e.metaKey) return e.shiftKey ? 'foreground-tab' : 'background-tab'
  return 'current'
}

function openMenuBelow(btn: HTMLElement, id: string): void {
  const r = btn.getBoundingClientRect()
  btn.classList.add('open')
  api.showBookmarkFolder(id, r.left, r.bottom)
  // Native menus block until closed; clear the highlight on the next interaction.
  setTimeout(() => btn.classList.remove('open'), 0)
}

bmItems.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.bm')
  if (!btn?.dataset.id) return
  if (btn.dataset.folder) openMenuBelow(btn, btn.dataset.id)
  else api.openBookmark(btn.dataset.id, dispositionFor(e))
})
bmItems.addEventListener('auxclick', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.bm')
  if (btn?.dataset.id && e.button === 1 && !btn.dataset.folder) api.openBookmark(btn.dataset.id, 'background-tab')
})
bookmarksBar.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.bm')
  api.showBookmarkContextMenu(btn?.dataset.id ?? null, e.clientX, e.clientY)
})
bmOther.onclick = () => openMenuBelow(bmOther, 'other')
$('bm-import').onclick = () => api.importFirefoxBookmarks()
bmOverflow.onclick = () => {
  const ids = ([...bmItems.querySelectorAll<HTMLButtonElement>('.bm.hidden-overflow')] as HTMLButtonElement[]).map((b) => b.dataset.id!)
  const r = bmOverflow.getBoundingClientRect()
  api.showBookmarkOverflow(ids, r.left, r.bottom)
}

// Drag to reorder, or onto a folder to move into it.
let dragId: string | null = null
const clearDrop = () => bmItems.querySelectorAll('.drop-before,.drop-after,.drop-into').forEach((el) => el.classList.remove('drop-before', 'drop-after', 'drop-into'))

function dropTarget(e: DragEvent): { btn: HTMLButtonElement; zone: 'before' | 'after' | 'into' } | null {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.bm')
  if (!btn || btn.dataset.id === dragId) return null
  const r = btn.getBoundingClientRect()
  const x = (e.clientX - r.left) / r.width
  if (btn.dataset.folder && x > 0.25 && x < 0.75) return { btn, zone: 'into' }
  return { btn, zone: x < 0.5 ? 'before' : 'after' }
}

bmItems.addEventListener('dragstart', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.bm')
  if (!btn?.dataset.id) return
  dragId = btn.dataset.id
  e.dataTransfer!.effectAllowed = 'move'
  e.dataTransfer!.setData('text/plain', btn.title)
})
bmItems.addEventListener('dragover', (e) => {
  if (!dragId) return
  const target = dropTarget(e)
  clearDrop()
  if (!target) return
  e.preventDefault()
  target.btn.classList.add(`drop-${target.zone}`)
})
bmItems.addEventListener('dragleave', clearDrop)
bmItems.addEventListener('dragend', () => {
  dragId = null
  clearDrop()
})
bmItems.addEventListener('drop', (e) => {
  const target = dropTarget(e)
  clearDrop()
  if (!dragId || !target) return
  e.preventDefault()
  if (target.zone === 'into') {
    api.moveBookmark(dragId, target.btn.dataset.id!, Number.MAX_SAFE_INTEGER)
  } else {
    const index = [...bmItems.children].indexOf(target.btn) + (target.zone === 'after' ? 1 : 0)
    api.moveBookmark(dragId, 'bar', index)
  }
  dragId = null
})

starBtn.onclick = () => api.bookmarkActiveTab()

api.onBookmarks((b) => {
  bar = b
  renderBookmarks()
})

api.onFocusAddressBar(() => {
  address.focus()
  address.select()
})

api.onState((s) => {
  state = s
  render()
})

api.ready()
