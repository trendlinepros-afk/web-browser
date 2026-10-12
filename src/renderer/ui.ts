// Browser UI: tab strip + toolbar. Plain DOM, no framework; state is pushed from the main process.
import type { BookmarkBarState, BookmarkItem, OpenDisposition, TabInfo, UiApi, WindowState } from '../shared/types'

declare global {
  interface Window {
    browser: UiApi
  }
}

const api = window.browser

/** Zirtola's own outline icon set (stroke drawn via CSS). */
const svg = (d: string) => `<svg viewBox="0 0 24 24">${d}</svg>`
const ICONS = {
  back: svg('<path d="M14.5 5.5 8 12l6.5 6.5"/>'),
  forward: svg('<path d="M9.5 5.5 16 12l-6.5 6.5"/>'),
  reload: svg('<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3L19.5 9"/><path d="M19.5 4.5V9H15"/>'),
  home: svg('<path d="M4.5 11 12 4.5l7.5 6.5"/><path d="M6.5 9.5v9h4v-5h3v5h4v-9"/>'),
  stop: svg('<path d="M7 7l10 10M17 7 7 17"/>'),
  plus: svg('<path d="M12 5.5v13M5.5 12h13"/>'),
  menu: svg('<path d="M4 7.5h9M17 7.5h3M4 16.5h3M11 16.5h9"/><circle cx="15" cy="7.5" r="2"/><circle cx="9" cy="16.5" r="2"/>'),
  close: svg('<path d="M7 7l10 10M17 7 7 17"/>'),
  audio: svg('<path d="M4.5 9.5v5h3.5l4.5 4v-13L8 9.5z"/><path d="M16 9.5a3.5 3.5 0 0 1 0 5M18.5 7a7 7 0 0 1 0 10"/>'),
  muted: svg('<path d="M4.5 9.5v5h3.5l4.5 4v-13L8 9.5z"/><path d="m16.5 10 4 4M20.5 10l-4 4"/>'),
  shield: svg('<path d="M12 3.5 18.5 6v5.3c0 4.2-2.8 7.8-6.5 9.2-3.7-1.4-6.5-5-6.5-9.2V6z"/><path d="m9.2 12 2 2 3.8-3.9"/>'),
  shieldOff: svg('<path d="M12 3.5 18.5 6v5.3c0 4.2-2.8 7.8-6.5 9.2-3.7-1.4-6.5-5-6.5-9.2V6z"/><path d="M9.5 9.5l5 5M14.5 9.5l-5 5"/>'),
  star: svg('<path d="m12 4 2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 16.3l-4.8 2.6.9-5.4-3.9-3.8 5.4-.8z"/>'),
  folder: svg('<path d="M4 7.5a2 2 0 0 1 2-2h3.6l2 2H18a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/>'),
  globe: svg('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.4 3.4 5.3 3.4 8.5s-1 6.1-3.4 8.5c-2.4-2.4-3.4-5.3-3.4-8.5s1-6.1 3.4-8.5"/>'),
  chevron: svg('<path d="m7 7 5 5-5 5M13 7l5 5-5 5"/>'),
  lock: svg('<rect x="5.5" y="10.5" width="13" height="9" rx="2.5"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>'),
  warn: svg('<path d="M12 4.5 20.5 19h-17z"/><path d="M12 10v4M12 16.8v.2"/>'),
  search: svg('<circle cx="11" cy="11" r="6"/><path d="m19.5 19.5-4-4"/>'),
  page: svg('<path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10.5a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5"/><path d="M14 3.5V8h4"/>'),
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const tabsEl = $<HTMLDivElement>('tabs')
const address = $<HTMLInputElement>('address')
const addressForm = $<HTMLFormElement>('address-form')
const backBtn = $<HTMLButtonElement>('back')
const forwardBtn = $<HTMLButtonElement>('forward')
const reloadBtn = $<HTMLButtonElement>('reload')
const homeBtn = $<HTMLButtonElement>('home')
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
const siteIcon = $<HTMLSpanElement>('site-icon')
const addressDisplay = $<HTMLDivElement>('address-display')

backBtn.innerHTML = ICONS.back
forwardBtn.innerHTML = ICONS.forward
reloadBtn.innerHTML = ICONS.reload
homeBtn.innerHTML = ICONS.home
menuBtn.innerHTML = ICONS.menu
newTabBtn.innerHTML = ICONS.plus

const params = new URLSearchParams(location.search)
const incognito = params.get('incognito') === '1'
if (incognito) address.placeholder = 'Private: nothing you do here is saved'
document.body.classList.add(`platform-${params.get('platform') ?? 'unknown'}`, `frame-${params.get('frame') ?? 'native'}`)
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
  homeBtn.hidden = !state.showHomeButton
  forwardBtn.disabled = !tab?.canGoForward
  reloadBtn.innerHTML = tab?.loading ? ICONS.stop : ICONS.reload
  reloadBtn.title = tab?.loading ? 'Stop loading' : 'Reload (Ctrl+R)'
  if (!editing) address.value = displayURL(tab?.url ?? '')
  renderAddressDisplay(tab?.url ?? '')
  mcpBadge.hidden = !state.mcpEnabled
  if (state.accent) document.body.style.setProperty('--sys-accent', state.accent)
  document.body.classList.toggle('has-accent', !!state.accent)
  renderShield(tab)
  const web = !!tab && /^(https?|file):/.test(tab.url)
  starBtn.hidden = !web
  const starred = !!tab?.bookmarked
  if (starBtn.classList.contains('on') !== starred || !starBtn.innerHTML) {
    starBtn.classList.toggle('on', starred)
    starBtn.innerHTML = ICONS.star
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
  shieldBtn.classList.toggle('on', tab.blockingActive && tab.blocked > 0)
  shieldBtn.innerHTML = (tab.blockingActive ? ICONS.shield : ICONS.shieldOff) + (tab.blockingActive && tab.blocked > 0 ? `<span class="count">${tab.blocked > 99 ? '99+' : tab.blocked}</span>` : '')
  shieldBtn.title = tab.blockingActive ? `${tab.blocked} ads & trackers blocked on this page` : 'Blocking is off for this site'
}

/** Shows the site's host prominently (and the rest faintly) while the address isn't being edited. */
let displayedFor = '\0'
function renderAddressDisplay(url: string): void {
  const key = `${url}|${editing}`
  if (key === displayedFor) return
  displayedFor = key
  let host = ''
  let rest = ''
  let kind: 'secure' | 'insecure' | 'local' | 'none' = 'none'
  try {
    const u = new URL(url)
    if (u.protocol === 'https:' || u.protocol === 'http:') {
      host = u.host.replace(/^www\./, '')
      rest = (u.pathname === '/' ? '' : u.pathname) + u.search + u.hash
      kind = u.protocol === 'https:' ? 'secure' : /^(localhost|127\.)/.test(u.hostname) ? 'local' : 'insecure'
    } else if (u.protocol === 'file:') {
      host = decodeURIComponent(u.pathname.split('/').pop() || u.pathname)
      kind = 'local'
    }
  } catch {
    // Not a URL (about:blank etc.)
  }
  const show = !editing && !!host
  addressForm.classList.toggle('show-display', show)
  addressDisplay.replaceChildren()
  if (show) {
    addressDisplay.append(
      Object.assign(document.createElement('span'), { className: 'host', textContent: host }),
      Object.assign(document.createElement('span'), { className: 'rest', textContent: rest }),
    )
  }
  siteIcon.className = editing || !url || url === 'about:blank' ? '' : kind
  siteIcon.innerHTML = editing || !host ? ICONS.search : kind === 'secure' ? ICONS.lock : kind === 'insecure' ? ICONS.warn : ICONS.page
  siteIcon.title = kind === 'secure' ? 'Secure connection' : kind === 'insecure' ? 'Not secure: this site doesn\'t use HTTPS' : ''
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
  api.showTabMenu(Number(el.dataset.id), e.clientX, e.clientY)
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
homeBtn.onclick = () => state?.activeTabId && api.goHome(state.activeTabId)
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
  renderAddressDisplay(active()?.url ?? '')
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
