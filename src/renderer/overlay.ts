// Draws Zirtola's menus and settings panel above the page. Plain DOM; driven by the main process.
import type { ChatEntry, ChatState, PopupItem, PopupModifiers, PromptSpec, SettingsControl, SettingsModel, SettingsSection, WorklogEntry, WorklogModel, WorklogOp, WorklogSlotted } from '../shared/types'

interface OverlayApi {
  onShowMenu(cb: (m: { items: PopupItem[]; x: number; y: number; align: 'left' | 'right'; incognito?: boolean }) => void): void
  onShowSettings(cb: (m: SettingsModel) => void): void
  onUpdateSettings(cb: (m: SettingsModel) => void): void
  onHide(cb: () => void): void
  invoke(id: number, mods: PopupModifiers): void
  close(): void
  setSetting(key: string, value: unknown): void
  action(name: string): void
  onShowPrompt(cb: (p: PromptSpec & { incognito?: boolean }) => void): void
  answer(index: number): void
  onShowChat(cb: (m: { state: ChatState; x: number; y: number; incognito?: boolean }) => void): void
  onUpdateChat(cb: (s: ChatState) => void): void
  chat(op: 'send' | 'stop' | 'new' | 'login', text?: string): void
  onShowWorklog(cb: (m: WorklogModel & { incognito?: boolean }) => void): void
  onUpdateWorklog(cb: (m: WorklogModel) => void): void
  worklog(op: WorklogOp): void
}

const api = (window as unknown as { overlay: OverlayApi }).overlay
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const menusEl = $<HTMLDivElement>('menus')
const settingsEl = $<HTMLElement>('settings')
const chatEl = $<HTMLElement>('chat')
const worklogEl = $<HTMLElement>('worklog')
const scrim = $<HTMLDivElement>('scrim')

const params = new URLSearchParams(location.search)
/** The overlay is shared by all windows; each menu/panel says whether it's for a private window. */
const setIncognito = (on: unknown) => document.body.classList.toggle('incognito', on === true)
document.body.classList.add(`platform-${params.get('platform') ?? 'unknown'}`, `frame-${params.get('frame') ?? 'native'}`)

const CHECK = '<svg viewBox="0 0 24 24"><path d="M5 12.5 10 17.5 19 7"/></svg>'
const CHEVRON = '<svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>'
const CLOSE = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>'
$('settings-close').innerHTML = CLOSE

// ---- Menus --------------------------------------------------------------------

/** Open menu panels: [root, submenu, sub-submenu…]. */
let stack: { el: HTMLDivElement; items: PopupItem[]; active: number }[] = []
let hoverTimer: number | undefined

function mods(e: MouseEvent | KeyboardEvent): PopupModifiers {
  return { ctrl: e.ctrlKey, shift: e.shiftKey, meta: e.metaKey, alt: e.altKey }
}

function closeFrom(level: number): void {
  for (const panel of stack.splice(level)) panel.el.remove()
  stack[level - 1]?.el.querySelectorAll('.item.open').forEach((el) => el.classList.remove('open'))
}

function closeAll(): void {
  if (activePrompt) return answerPrompt(activePrompt.cancelId)
  closeFrom(0)
  settingsEl.hidden = true
  chatEl.hidden = true
  worklogEl.hidden = true
  document.body.classList.remove('settings-open')
  api.close()
}

function buildPanel(items: PopupItem[], level: number): HTMLDivElement {
  const panel = document.createElement('div')
  panel.className = 'menu'
  // Only reserve the icon/check column when something in this menu uses it.
  if (!items.some((i) => i.type === 'checkbox' || i.type === 'radio' || i.icon)) panel.classList.add('no-lead')
  panel.setAttribute('role', 'menu')
  items.forEach((item, index) => {
    if (item.type === 'separator') {
      panel.append(Object.assign(document.createElement('div'), { className: 'sep' }))
      return
    }
    const el = document.createElement('div')
    el.className = 'item'
    el.dataset.index = String(index)
    el.setAttribute('role', item.type === 'checkbox' ? 'menuitemcheckbox' : item.type === 'radio' ? 'menuitemradio' : 'menuitem')
    if (!item.enabled) el.classList.add('disabled')
    if (item.note) el.classList.add('note')
    if (item.danger) el.classList.add('danger')
    if (item.type === 'radio') el.classList.add('radio')
    if (item.checked) el.classList.add('checked')

    const lead = Object.assign(document.createElement('span'), { className: 'lead' })
    if (item.checked) lead.innerHTML = CHECK
    else if (item.icon) lead.append(Object.assign(document.createElement('img'), { src: item.icon, alt: '' }))
    const label = Object.assign(document.createElement('span'), { className: 'label', textContent: item.label })
    if (item.sublabel) label.append(Object.assign(document.createElement('span'), { className: 'sublabel', textContent: item.sublabel }))
    const trail = Object.assign(document.createElement('span'), { className: 'accel' })
    if (item.type === 'submenu') trail.innerHTML = `<span class="lead">${CHEVRON}</span>`
    else if (item.accelerator) trail.textContent = item.accelerator
    el.append(lead, label, trail)

    el.addEventListener('mouseenter', () => {
      setActive(level, index)
      window.clearTimeout(hoverTimer)
      hoverTimer = window.setTimeout(() => {
        if (item.type === 'submenu' && item.enabled) openSubmenu(level, index, el)
        else closeFrom(level + 1)
      }, 120)
    })
    el.addEventListener('click', (e) => activate(level, index, e))
    panel.append(el)
  })
  return panel
}

function place(panel: HTMLDivElement, x: number, y: number, align: 'left' | 'right', anchor?: DOMRect): void {
  menusEl.append(panel)
  const r = panel.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight
  let left = align === 'right' ? x - r.width : x
  let top = y
  if (anchor) {
    // Submenus open beside their parent item, flipping left if there's no room.
    left = anchor.right + 4
    top = anchor.top - 7
    if (left + r.width > vw - 8) left = anchor.left - r.width - 4
  }
  left = Math.max(8, Math.min(left, vw - r.width - 8))
  if (top + r.height > vh - 8) top = Math.max(8, anchor ? vh - r.height - 8 : y - r.height)
  panel.style.left = `${left}px`
  panel.style.top = `${top}px`
}

function openSubmenu(level: number, index: number, el: HTMLElement): void {
  const parent = stack[level]
  if (stack[level + 1] && el.classList.contains('open')) return
  closeFrom(level + 1)
  const item = parent.items[index]
  if (!item.children?.length) return
  el.classList.add('open')
  const panel = buildPanel(item.children, level + 1)
  stack.push({ el: panel, items: item.children, active: -1 })
  place(panel, 0, 0, 'left', el.getBoundingClientRect())
}

function setActive(level: number, index: number): void {
  const panel = stack[level]
  if (!panel) return
  panel.active = index
  panel.el.querySelectorAll('.item.active').forEach((el) => el.classList.remove('active'))
  panel.el.querySelector(`.item[data-index="${index}"]`)?.classList.add('active')
}

function activate(level: number, index: number, e: MouseEvent | KeyboardEvent): void {
  const item = stack[level]?.items[index]
  if (!item || !item.enabled || item.note) return
  if (item.type === 'submenu') {
    const el = stack[level].el.querySelector<HTMLElement>(`.item[data-index="${index}"]`)
    if (el) {
      openSubmenu(level, index, el)
      setActive(level + 1, firstEnabled(level + 1, 0, 1))
    }
    return
  }
  closeFrom(0)
  api.invoke(item.id, mods(e))
}

function firstEnabled(level: number, from: number, dir: 1 | -1): number {
  const items = stack[level]?.items ?? []
  for (let i = 0, idx = from; i < items.length; i++, idx = (idx + dir + items.length) % items.length) {
    const it = items[idx]
    if (it && it.type !== 'separator' && it.enabled && !it.note) return idx
  }
  return -1
}

api.onShowMenu(({ items, x, y, align, incognito }) => {
  setIncognito(incognito)
  closeFrom(0)
  settingsEl.hidden = true
  document.body.classList.remove('settings-open')
  const panel = buildPanel(items, 0)
  stack = [{ el: panel, items, active: -1 }]
  place(panel, x, y, align)
  panel.style.transformOrigin = align === 'right' ? 'top right' : 'top left'
})

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (stack.length > 1) closeFrom(stack.length - 1)
    else closeAll()
    return
  }
  if (!stack.length) return
  const level = stack.length - 1
  const panel = stack[level]
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    const dir = e.key === 'ArrowDown' ? 1 : -1
    const start = panel.active < 0 ? (dir === 1 ? 0 : panel.items.length - 1) : (panel.active + dir + panel.items.length) % panel.items.length
    setActive(level, firstEnabled(level, start, dir))
  } else if (e.key === 'ArrowRight' && panel.items[panel.active]?.type === 'submenu') {
    activate(level, panel.active, e)
  } else if (e.key === 'ArrowLeft' && level > 0) {
    closeFrom(level)
  } else if ((e.key === 'Enter' || e.key === ' ') && panel.active >= 0) {
    e.preventDefault()
    activate(level, panel.active, e)
  }
})

scrim.addEventListener('mousedown', () => closeAll())
scrim.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  closeAll()
})
window.addEventListener('blur', () => {
  if (stack.length) closeAll()
})
api.onHide(() => {
  promptEl.hidden = true
  activePrompt = null
  closeFrom(0)
  settingsEl.hidden = true
  chatEl.hidden = true
  worklogEl.hidden = true
  document.body.classList.remove('settings-open')
})

// ---- Prompts (permission requests, confirmations) --------------------------------

const promptEl = $<HTMLDivElement>('prompt')
let activePrompt: PromptSpec | null = null
const PERMISSION_ICONS: Record<NonNullable<PromptSpec['icon']>, string> = {
  location: '<svg viewBox="0 0 24 24"><path d="M12 20.5s-6.5-5.6-6.5-10.5a6.5 6.5 0 0 1 13 0c0 4.9-6.5 10.5-6.5 10.5"/><circle cx="12" cy="10" r="2.3"/></svg>',
  camera: '<svg viewBox="0 0 24 24"><rect x="3.5" y="7" width="12" height="10" rx="2.5"/><path d="m15.5 11 5-3v8l-5-3"/></svg>',
  mic: '<svg viewBox="0 0 24 24"><rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M6 11.5a6 6 0 0 0 12 0M12 17.5v3"/></svg>',
  bell: '<svg viewBox="0 0 24 24"><path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 1.5H5z"/><path d="M10 20.5h4"/></svg>',
  clipboard: '<svg viewBox="0 0 24 24"><rect x="6" y="5" width="12" height="15.5" rx="2.5"/><path d="M9.5 3.5h5v3h-5z"/></svg>',
  screen: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="11.5" rx="2"/><path d="M9 20h6M12 16.5V20"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><rect x="5.5" y="10.5" width="13" height="9" rx="2.5"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/></svg>',
}
const PROMPT_ICONS: Record<PromptSpec['kind'], string> = {
  permission: '<svg viewBox="0 0 24 24"><rect x="5.5" y="10.5" width="13" height="9" rx="2.5"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/></svg>',
  info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 7.8v.2"/></svg>',
  warning: '<svg viewBox="0 0 24 24"><path d="M12 4.5 20.5 19h-17z"/><path d="M12 10v4M12 16.8v.2"/></svg>',
}

function answerPrompt(index: number): void {
  if (!activePrompt) return
  activePrompt = null
  promptEl.hidden = true
  api.answer(index)
}

api.onShowPrompt((spec) => {
  setIncognito(spec.incognito)
  closeFrom(0)
  settingsEl.hidden = true
  document.body.classList.remove('settings-open')
  activePrompt = spec
  promptEl.querySelector('.prompt-icon')!.innerHTML = (spec.icon && PERMISSION_ICONS[spec.icon]) || PROMPT_ICONS[spec.kind] || PROMPT_ICONS.info
  promptEl.querySelector('.prompt-title')!.textContent = spec.title
  promptEl.querySelector('.prompt-message')!.textContent = spec.message
  const detail = promptEl.querySelector<HTMLElement>('.prompt-detail')!
  detail.textContent = spec.detail ?? ''
  detail.hidden = !spec.detail
  const buttons = promptEl.querySelector('.prompt-buttons')!
  buttons.replaceChildren()
  // Secondary choices first, the default (primary) one last, on the right.
  const order = spec.buttons.map((label, index) => ({ label, index })).sort((a, b) => Number(a.index === spec.defaultId) - Number(b.index === spec.defaultId))
  for (const { label, index } of order) {
    const btn = Object.assign(document.createElement('button'), { type: 'button', className: `btn${index === spec.defaultId ? ' primary' : ''}`, textContent: label })
    btn.onclick = () => answerPrompt(index)
    buttons.append(btn)
  }
  promptEl.hidden = false
  ;(buttons.lastElementChild as HTMLButtonElement | null)?.focus()
})

document.addEventListener(
  'keydown',
  (e) => {
    if (activePrompt && e.key === 'Escape') {
      e.stopImmediatePropagation()
      answerPrompt(activePrompt.cancelId)
    }
  },
  true,
)

// ---- Settings -------------------------------------------------------------------

const nav = $<HTMLElement>('settings-nav')
const body = $<HTMLDivElement>('settings-body')

function control(c: SettingsControl): HTMLElement {
  const row = Object.assign(document.createElement('div'), { className: 'row' })
  const text = Object.assign(document.createElement('div'), { className: 'text' })
  text.append(Object.assign(document.createElement('div'), { className: 'label', textContent: c.label }))
  if ('description' in c && c.description) text.append(Object.assign(document.createElement('div'), { className: 'desc', textContent: c.description }))
  row.append(text)

  if (c.kind === 'toggle') {
    const sw = Object.assign(document.createElement('button'), { className: 'switch', type: 'button' })
    sw.setAttribute('role', 'switch')
    sw.setAttribute('aria-checked', String(c.value))
    sw.setAttribute('aria-label', c.label)
    const toggle = () => {
      const next = sw.getAttribute('aria-checked') !== 'true'
      sw.setAttribute('aria-checked', String(next))
      api.setSetting(c.key, next)
    }
    sw.onclick = toggle
    row.onclick = (e) => {
      if (e.target !== sw) toggle()
    }
    row.style.cursor = 'default'
    row.append(sw)
  } else if (c.kind === 'select') {
    const sel = Object.assign(document.createElement('select'), { className: 'select' })
    sel.setAttribute('aria-label', c.label)
    for (const o of c.options) sel.append(Object.assign(document.createElement('option'), { value: o.value, textContent: o.label, selected: o.value === c.value }))
    sel.onchange = () => api.setSetting(c.key, sel.value)
    row.append(sel)
  } else if (c.kind === 'button') {
    // The description is the row's text; the label is the button's.
    const btn = Object.assign(document.createElement('button'), { className: `btn ${c.style ?? ''}`, type: 'button', textContent: c.label })
    btn.onclick = () => api.action(c.action)
    text.replaceChildren(Object.assign(document.createElement('div'), { className: 'label', textContent: c.description ?? '' }))
    row.append(btn)
  } else if (c.kind === 'text') {
    const input = c.multiline
      ? Object.assign(document.createElement('textarea'), { className: 'text-input multiline', value: c.value, placeholder: c.placeholder ?? '', spellcheck: false, rows: 5 })
      : Object.assign(document.createElement('input'), { className: 'text-input', type: c.secret ? 'password' : 'text', value: c.value, placeholder: c.placeholder ?? '', spellcheck: false })
    input.setAttribute('aria-label', c.label)
    const commit = () => {
      if (input.value.trim() !== c.value) api.setSetting(c.key, input.value)
    }
    input.onchange = commit
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && !c.multiline) input.blur()
    }
    row.append(input)
  } else {
    row.append(Object.assign(document.createElement('div'), { className: 'value', textContent: c.value }))
  }
  return row
}

const SECTION_ICONS: Record<string, string> = {
  appearance: '<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.8 1.8-1.7 0-1.3-1.1-1.6-1.1-2.8 0-1 .8-1.7 1.8-1.7h2.1a3.9 3.9 0 0 0 3.9-3.9c0-3.9-3.8-6.9-8.5-6.9"/><circle cx="7.8" cy="11" r="1"/><circle cx="10.5" cy="7.3" r="1"/><circle cx="15" cy="7.8" r="1"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5"/>',
  speed: '<path d="M4.5 16a7.5 7.5 0 1 1 15 0"/><path d="m12 16 3.5-5"/><circle cx="12" cy="16" r="1.2"/>',
  privacy: '<path d="M12 3.5 18.5 6v5.3c0 4.2-2.8 7.8-6.5 9.2-3.7-1.4-6.5-5-6.5-9.2V6z"/><path d="m9.2 12 2 2 3.8-3.9"/>',
  clear: '<path d="M5 7h14M10 7V5h4v2M7 7l.8 12.5h8.4L17 7"/>',
  startup: '<path d="M4.5 11 12 4.5l7.5 6.5"/><path d="M6.5 9.5v9h4v-5h3v5h4v-9"/>',
  bookmarks: '<path d="M7 4.5h10v15l-5-3.5-5 3.5z"/>',
  extensions: '<path d="M9.5 4.5h3v2a1.5 1.5 0 0 0 3 0v-2h3v5h-2a1.5 1.5 0 0 0 0 3h2v5h-5v-2a1.5 1.5 0 0 0-3 0v2h-5v-5h2a1.5 1.5 0 0 0 0-3h-2v-5z"/>',
  worklog: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  torrents: '<path d="M7 4.5v7a5 5 0 0 0 10 0v-7"/><path d="M7 4.5h3v7a2 2 0 0 0 4 0v-7h3"/><path d="M7 8h3M14 8h3"/>',
  claude: '<path d="M12 3.5v3M12 17.5v3M3.5 12h3M17.5 12h3M6 6l2.1 2.1M15.9 15.9 18 18M18 6l-2.1 2.1M8.1 15.9 6 18"/>',
  updates: '<path d="M12 4.5v10M7.5 10l4.5 4.5 4.5-4.5"/><path d="M5 19.5h14"/>',
}

/** The section on screen; kept while the panel is open and across refreshes. */
let currentSection = ''
let lastModel: SettingsModel | null = null

const query = $<HTMLInputElement>('settings-query')

/** Words a control can be found by: its label, description, value and option names. */
function searchText(section: SettingsSection, c: SettingsControl): string {
  const parts = [section.title, c.label, 'description' in c ? c.description : '', c.kind === 'info' ? c.value : '']
  if (c.kind === 'select') parts.push(...c.options.map((o) => o.label))
  return parts.join(' ').toLowerCase()
}

function renderSearch(model: SettingsModel, text: string): void {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean)
  let count = 0
  body.replaceChildren()
  for (const section of model.sections) {
    const matches = section.controls.filter((c) => {
      const hay = searchText(section, c)
      return words.every((w) => hay.includes(w))
    })
    if (!matches.length) continue
    count += matches.length
    const heading = Object.assign(document.createElement('button'), { type: 'button', className: 'result-section', textContent: section.title })
    heading.title = `Open ${section.title}`
    heading.onclick = () => {
      query.value = ''
      currentSection = section.id
      renderSettings(model, false)
    }
    const card = Object.assign(document.createElement('div'), { className: 'card' })
    for (const c of matches) card.append(control(c))
    body.append(heading, card)
  }
  $('settings-title').textContent = 'Search'
  $('settings-subtitle').textContent = count ? `${count} setting${count === 1 ? '' : 's'} match “${text.trim()}”` : `Nothing matches “${text.trim()}”`
  if (!count) body.append(Object.assign(document.createElement('div'), { className: 'no-results', textContent: 'Try another word, like “sleep”, “cookies” or “homepage”.' }))
}

function renderSettings(model: SettingsModel, keepScroll: boolean): void {
  lastModel = model
  const scroll = body.scrollTop
  const searching = query.value.trim() !== ''
  if (!model.sections.some((s) => s.id === currentSection)) currentSection = model.sections[0]?.id ?? ''
  nav.replaceChildren()
  for (const section of model.sections) {
    const item = Object.assign(document.createElement('button'), { type: 'button', className: 'nav-item' })
    item.innerHTML = `<svg viewBox="0 0 24 24">${SECTION_ICONS[section.id] ?? ''}</svg>`
    item.append(Object.assign(document.createElement('span'), { textContent: section.title }))
    item.title = section.title
    item.classList.toggle('current', !searching && section.id === currentSection)
    if (!searching && section.id === currentSection) item.setAttribute('aria-current', 'page')
    item.onclick = () => {
      if (currentSection === section.id && !query.value) return
      query.value = ''
      currentSection = section.id
      renderSettings(lastModel!, false)
    }
    nav.append(item)
  }
  if (searching) {
    renderSearch(model, query.value)
    body.scrollTop = keepScroll ? scroll : 0
    return
  }
  const section = model.sections.find((s) => s.id === currentSection)
  $('settings-title').textContent = section?.title ?? ''
  $('settings-subtitle').textContent = section?.subtitle ?? ''
  body.replaceChildren()
  if (section) {
    const card = Object.assign(document.createElement('div'), { className: 'card' })
    for (const c of section.controls) card.append(control(c))
    body.append(card)
  }
  body.scrollTop = keepScroll ? scroll : 0
}

api.onShowSettings((model) => {
  setIncognito((model as SettingsModel & { incognito?: boolean }).incognito)
  closeFrom(0)
  if (model.focus) currentSection = model.focus
  query.value = ''
  renderSettings(model, false)
  settingsEl.hidden = false
  document.body.classList.add('settings-open')
  query.focus()
})
api.onUpdateSettings((model) => renderSettings(model, true))
$('settings-close').onclick = () => closeAll()

// Up/down moves between settings sections.
nav.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  e.preventDefault()
  const items = [...nav.querySelectorAll<HTMLButtonElement>('.nav-item')]
  const i = items.findIndex((b) => b.classList.contains('current'))
  const next = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]
  next.click()
  nav.querySelectorAll<HTMLButtonElement>('.nav-item')[items.indexOf(next)]?.focus()
})

query.addEventListener('input', () => lastModel && renderSettings(lastModel, false))
query.addEventListener('keydown', (e) => {
  // Esc clears the search first; a second Esc closes Settings.
  if (e.key === 'Escape' && query.value) {
    e.stopPropagation()
    query.value = ''
    if (lastModel) renderSettings(lastModel, false)
  }
})
// Ctrl+F (Cmd+F) jumps to the search box.
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && !settingsEl.hidden) {
    e.preventDefault()
    query.focus()
    query.select()
  }
})

// ---- Claude chat ----------------------------------------------------------------

const chatLog = $<HTMLDivElement>('chat-log')
const chatForm = $<HTMLFormElement>('chat-form')
const chatInput = $<HTMLTextAreaElement>('chat-input')
const chatSend = $<HTMLButtonElement>('chat-send')
const SEND = '<svg viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"/></svg>'
const STOP = '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>'
const TOOL = '<svg viewBox="0 0 24 24"><path d="M5 12h3l2-5 4 10 2-5h3"/></svg>'
$('chat-new').innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>'
$('chat-close').innerHTML = CLOSE
const SUGGESTIONS = ['Summarize this page', 'What are the key points here?', 'Find the cheapest option on this page', 'Open my email']
let chatBusy = false

/** A little Markdown, built from DOM nodes (never innerHTML): paragraphs, lists, **bold**, `code`. */
function renderMarkdown(text: string): DocumentFragment {
  const frag = document.createDocumentFragment()
  const inline = (line: string, into: HTMLElement) => {
    for (const part of line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)) {
      if (!part) continue
      if (part.startsWith('**') && part.endsWith('**') && part.length > 4) into.append(Object.assign(document.createElement('strong'), { textContent: part.slice(2, -2) }))
      else if (part.startsWith('`') && part.endsWith('`') && part.length > 2) into.append(Object.assign(document.createElement('code'), { textContent: part.slice(1, -1) }))
      else into.append(part)
    }
  }
  const isItem = (l: string) => /^\s*([-*•]|\d+[.)])\s+/.test(l)
  for (const block of text.trim().split(/\n{2,}/)) {
    // Runs of list lines become a list; other lines become a paragraph.
    const lines = block.split('\n')
    for (let i = 0; i < lines.length; ) {
      if (isItem(lines[i])) {
        const list = document.createElement(/^\s*\d/.test(lines[i]) ? 'ol' : 'ul')
        for (; i < lines.length && isItem(lines[i]); i++) {
          const li = document.createElement('li')
          inline(lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, ''), li)
          list.append(li)
        }
        frag.append(list)
      } else {
        const p = document.createElement('p')
        for (let first = true; i < lines.length && !isItem(lines[i]); i++, first = false) {
          if (!first) p.append(document.createElement('br'))
          inline(lines[i].replace(/^#+\s+/, ''), p)
        }
        frag.append(p)
      }
    }
  }
  return frag
}

function chatEntry(e: ChatEntry): HTMLElement {
  const el = Object.assign(document.createElement('div'), { className: `msg ${e.role}` })
  if (e.role === 'assistant') el.append(renderMarkdown(e.text))
  else if (e.role === 'tool') {
    el.innerHTML = TOOL
    el.append(Object.assign(document.createElement('span'), { textContent: e.text }))
  } else el.textContent = e.text
  if (e.action === 'login') {
    const btn = Object.assign(document.createElement('button'), { type: 'button', className: 'btn primary', textContent: 'Sign in to Claude' })
    btn.onclick = () => api.chat('login')
    el.append(btn)
  }
  return el
}

function renderChat(state: ChatState): void {
  const nearBottom = chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 60
  chatBusy = state.busy
  chatLog.replaceChildren()
  if (state.unavailable) {
    chatLog.append(Object.assign(document.createElement('div'), { className: 'chat-empty', textContent: state.unavailable }))
  } else if (!state.entries.length) {
    const empty = Object.assign(document.createElement('div'), { className: 'chat-empty' })
    empty.append(
      Object.assign(document.createElement('p'), { textContent: 'Ask Claude about this page, or to do something for you in the browser.' }),
    )
    const chips = Object.assign(document.createElement('div'), { className: 'chips' })
    for (const s of SUGGESTIONS) {
      const chip = Object.assign(document.createElement('button'), { type: 'button', className: 'chip', textContent: s })
      chip.onclick = () => api.chat('send', s)
      chips.append(chip)
    }
    empty.append(chips)
    chatLog.append(empty)
  }
  for (const e of state.entries) chatLog.append(chatEntry(e))
  if (state.busy) {
    const working = Object.assign(document.createElement('div'), { className: 'msg working' })
    working.append(document.createElement('i'), document.createElement('i'), document.createElement('i'))
    chatLog.append(working)
  }
  chatForm.hidden = !!state.unavailable
  chatSend.innerHTML = state.busy ? STOP : SEND
  chatSend.classList.toggle('stop', state.busy)
  chatSend.setAttribute('aria-label', state.busy ? 'Stop' : 'Send')
  if (nearBottom || state.busy) chatLog.scrollTop = chatLog.scrollHeight
}

function fitInput(): void {
  chatInput.style.height = 'auto'
  chatInput.style.height = `${Math.min(chatInput.scrollHeight, 140)}px`
}

api.onShowChat(({ state, x, y, incognito }) => {
  setIncognito(incognito)
  closeFrom(0)
  settingsEl.hidden = true
  document.body.classList.remove('settings-open')
  chatEl.style.right = `${Math.max(8, window.innerWidth - x)}px`
  chatEl.style.top = `${y + 8}px`
  chatEl.hidden = false
  renderChat(state)
  chatLog.scrollTop = chatLog.scrollHeight
  chatInput.focus()
})
api.onUpdateChat((state) => {
  if (!chatEl.hidden) renderChat(state)
})

chatForm.addEventListener('submit', (e) => {
  e.preventDefault()
  if (chatBusy) return api.chat('stop')
  const text = chatInput.value.trim()
  if (!text) return
  api.chat('send', text)
  chatInput.value = ''
  fitInput()
})
chatInput.addEventListener('input', fitInput)
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    if (!chatBusy) chatForm.requestSubmit()
  }
})
$('chat-new').onclick = () => {
  api.chat('new')
  chatInput.focus()
}
$('chat-close').onclick = () => closeAll()

// ---- My time (ConnectWise time entries) -------------------------------------------

const wlList = $<HTMLDivElement>('wl-list')
const GEAR = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/></svg>'
const LEFT = '<svg viewBox="0 0 24 24"><path d="m15 6-6 6 6 6"/></svg>'
const TRASH = '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 11v6M14 11v6M7 7l1 12h8l1-12M9 7V4h6v3"/></svg>'
let wlModel: WorklogModel | null = null
/** An update that arrived while you were typing; drawn when you leave the field. */
let wlPending: WorklogModel | null = null

const pad = (n: number) => String(n).padStart(2, '0')
function dayStart(day: string): number {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d).getTime()
}
function shiftDay(day: string, by: number): string {
  const d = new Date(dayStart(day) + by * 86_400_000 + 3_600_000 * 12)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
function roundTo(t: number, minutes: number): number {
  const step = Math.max(1, minutes) * 60_000
  return Math.round(t / step) * step
}
const hhmm = (t: number) => {
  const d = new Date(t)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
/** "HH:MM" on the panel's day → epoch ms. */
function atTime(day: string, value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value)
  if (!m) return null
  const [y, mo, d] = day.split('-').map(Number)
  return new Date(y, mo - 1, d, Number(m[1]), Number(m[2])).getTime()
}
function dayLabel(m: WorklogModel): string {
  if (m.day === m.today) return 'Today'
  if (m.day === shiftDay(m.today, -1)) return 'Yesterday'
  return new Date(dayStart(m.day)).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}
const STATUS_TEXT: Record<WorklogEntry['status'], string> = { draft: 'Draft', approved: 'Approved', entered: 'In ConnectWise', skipped: 'Skipped' }

function update(id: string, patch: Extract<WorklogOp, { op: 'update' }>['patch']): void {
  api.worklog({ op: 'update', id, patch })
}

function wlRow(e: WorklogSlotted, m: WorklogModel): HTMLElement {
  const row = document.createElement('div')
  row.className = `wl-row ${e.status}`
  const locked = e.status === 'entered'
  const times = { start: e.slotStart, end: e.slotEnd }
  const hours = (times.end - times.start) / 3_600_000

  const ok = Object.assign(document.createElement('input'), { type: 'checkbox', className: 'wl-ok', checked: e.status === 'approved' || e.status === 'entered', disabled: locked, title: 'Approve: Claude may enter this one' })
  ok.onchange = () => update(e.id, { status: ok.checked ? 'approved' : 'draft' })

  const ticket = Object.assign(document.createElement('input'), { className: 'wl-ticket', value: e.ticket, disabled: locked, title: 'Ticket number', inputMode: 'numeric' })
  ticket.setAttribute('aria-label', 'Ticket number')
  ticket.onchange = () => {
    const v = ticket.value.replace(/\D/g, '')
    if (v) update(e.id, { ticket: v })
    else ticket.value = e.ticket
  }
  const summary = Object.assign(document.createElement('div'), { className: 'wl-summary', textContent: e.summary || (e.manual ? 'Added by hand' : '') })
  summary.title = e.summary

  const timeInput = (value: number, which: 'start' | 'end') => {
    const input = Object.assign(document.createElement('input'), { type: 'time', className: 'wl-time', value: hhmm(value), disabled: locked, step: 60 })
    input.setAttribute('aria-label', which === 'start' ? 'Start' : 'End')
    input.onchange = () => {
      const t = atTime(m.day, input.value)
      if (t === null) return
      const other = which === 'start' ? times.end : times.start
      if (which === 'start' ? t >= other : t <= other) {
        input.value = hhmm(value)
        return
      }
      update(e.id, which === 'start' ? { start: t, end: times.end } : { start: times.start, end: t })
    }
    return input
  }
  const dash = Object.assign(document.createElement('span'), { className: 'wl-dash', textContent: '–' })
  const length = Object.assign(document.createElement('span'), { className: 'wl-hours', textContent: `${hours.toFixed(2)} h` })
  const chip = Object.assign(document.createElement('span'), { className: 'wl-chip', textContent: STATUS_TEXT[e.status] })
  if (!e.manual && e.seconds < 120 && e.status === 'draft') {
    chip.textContent = 'Under 2 min'
    chip.classList.add('short')
  }
  if (e.notesByClaude && e.status === 'draft') {
    chip.textContent = 'Check Claude\'s notes'
    chip.classList.add('claude')
    chip.title = 'Claude suggested these notes. Read them (edit if needed) before approving.'
  }
  const del = Object.assign(document.createElement('button'), { className: 'icon wl-del', type: 'button', title: 'Delete', innerHTML: TRASH, disabled: locked })
  del.setAttribute('aria-label', 'Delete entry')
  del.onclick = () => api.worklog({ op: 'remove', id: e.id })

  const notes = Object.assign(document.createElement('textarea'), { className: 'wl-notes', value: e.notes, disabled: locked, rows: 1, placeholder: 'What you did (goes into ConnectWise as the time entry notes)' })
  notes.setAttribute('aria-label', 'Notes')
  let timer: number | undefined
  const fit = () => {
    notes.style.height = 'auto'
    notes.style.height = `${Math.min(notes.scrollHeight, 140)}px`
  }
  notes.oninput = () => {
    fit()
    clearTimeout(timer)
    timer = window.setTimeout(() => update(e.id, { notes: notes.value }), 600)
  }
  notes.onchange = () => {
    clearTimeout(timer)
    update(e.id, { notes: notes.value })
  }
  requestAnimationFrame(fit)

  const top = document.createElement('div')
  top.className = 'wl-top'
  top.append(ok, ticket, summary, timeInput(times.start, 'start'), dash, timeInput(times.end, 'end'), length, chip, del)
  row.append(top, notes)
  return row
}

function addRow(m: WorklogModel): HTMLElement {
  const row = document.createElement('div')
  row.className = 'wl-row adding'
  const ticket = Object.assign(document.createElement('input'), { className: 'wl-ticket', placeholder: 'Ticket #', inputMode: 'numeric' })
  const now = roundTo(m.day === m.today ? Date.now() : dayStart(m.day) + 9 * 3_600_000, m.roundMinutes)
  const start = Object.assign(document.createElement('input'), { type: 'time', className: 'wl-time', value: hhmm(now - 30 * 60_000) })
  const end = Object.assign(document.createElement('input'), { type: 'time', className: 'wl-time', value: hhmm(now) })
  const save = Object.assign(document.createElement('button'), { className: 'btn primary', type: 'button', textContent: 'Add' })
  const cancel = Object.assign(document.createElement('button'), { className: 'btn', type: 'button', textContent: 'Cancel' })
  const error = Object.assign(document.createElement('span'), { className: 'wl-error' })
  save.onclick = () => {
    const t = ticket.value.replace(/\D/g, '')
    const a = atTime(m.day, start.value)
    const b = atTime(m.day, end.value)
    if (!t) return void (error.textContent = 'Enter the ticket number.')
    if (a === null || b === null || b <= a) return void (error.textContent = 'The end must be after the start.')
    api.worklog({ op: 'add', ticket: t, start: a, end: b })
    row.remove()
  }
  cancel.onclick = () => row.remove()
  const top = document.createElement('div')
  top.className = 'wl-top'
  top.append(ticket, start, Object.assign(document.createElement('span'), { className: 'wl-dash', textContent: '–' }), end, save, cancel, error)
  row.append(top)
  setTimeout(() => ticket.focus())
  return row
}

function renderWorklog(m: WorklogModel): void {
  const active = document.activeElement
  if (active && worklogEl.contains(active) && active.matches('input,textarea') && wlModel && wlModel.day === m.day) {
    wlPending = m
    return
  }
  wlPending = null
  wlModel = m
  $('wl-day').textContent = dayLabel(m)
  ;($<HTMLButtonElement>('wl-next')).disabled = m.day >= m.today
  const live = m.entries.filter((e) => e.status !== 'skipped')
  const total = live.reduce((h, e) => h + (e.slotEnd - e.slotStart) / 3_600_000, 0)
  const approved = m.entries.filter((e) => e.status === 'approved').length
  $('wl-total').textContent = live.length ? `${total.toFixed(2)} h · ${approved} approved` : ''
  $('wl-off').hidden = m.enabled
  ;($<HTMLButtonElement>('wl-enter')).disabled = approved === 0
  ;($<HTMLButtonElement>('wl-draft')).disabled = !m.entries.some((e) => e.status === 'draft' && !e.notes.trim())
  const adding = wlList.querySelector('.wl-row.adding')
  wlList.replaceChildren(...m.entries.map((e) => wlRow(e, m)))
  if (!m.entries.length) {
    wlList.append(
      Object.assign(document.createElement('p'), {
        className: 'wl-empty',
        textContent: m.enabled ? 'Nothing tracked on this day yet. Open a ConnectWise ticket and work on it: the time shows up here.' : 'No time on this day.',
      }),
    )
  }
  if (adding) wlList.append(adding)
}

worklogEl.addEventListener('focusout', () => {
  setTimeout(() => {
    if (wlPending && !(document.activeElement && worklogEl.contains(document.activeElement) && document.activeElement.matches('input,textarea'))) renderWorklog(wlPending)
  })
})

api.onShowWorklog((m) => {
  setIncognito(m.incognito)
  closeFrom(0)
  settingsEl.hidden = true
  chatEl.hidden = true
  document.body.classList.remove('settings-open')
  worklogEl.hidden = false
  document.body.classList.add('settings-open')
  wlModel = null
  wlList.replaceChildren()
  renderWorklog(m)
  $<HTMLButtonElement>('wl-close').focus()
})
api.onUpdateWorklog((m) => {
  if (!worklogEl.hidden) renderWorklog(m)
})
$('wl-close').innerHTML = CLOSE
$('wl-close').onclick = () => closeAll()
$('wl-settings').innerHTML = GEAR
$('wl-settings').onclick = () => api.worklog({ op: 'settings' })
$('wl-setup').onclick = () => api.worklog({ op: 'settings' })
$('wl-prev').innerHTML = LEFT
$('wl-next').innerHTML = CHEVRON
$('wl-prev').onclick = () => wlModel && api.worklog({ op: 'day', day: shiftDay(wlModel.day, -1) })
$('wl-next').onclick = () => wlModel && wlModel.day < wlModel.today && api.worklog({ op: 'day', day: shiftDay(wlModel.day, 1) })
$('wl-add').onclick = () => {
  if (!wlModel || wlList.querySelector('.wl-row.adding')) return
  wlList.querySelector('.wl-empty')?.remove()
  wlList.append(addRow(wlModel))
}
$('wl-draft').onclick = () => api.worklog({ op: 'draft-notes' })
$('wl-enter').onclick = () => api.worklog({ op: 'enter' })
