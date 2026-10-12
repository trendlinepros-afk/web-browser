// Draws Zirtola's menus and settings panel above the page. Plain DOM; driven by the main process.
import type { PopupItem, PopupModifiers, SettingsControl, SettingsModel } from '../shared/types'

interface OverlayApi {
  onShowMenu(cb: (m: { items: PopupItem[]; x: number; y: number; align: 'left' | 'right'; incognito?: boolean }) => void): void
  onShowSettings(cb: (m: SettingsModel) => void): void
  onUpdateSettings(cb: (m: SettingsModel) => void): void
  onHide(cb: () => void): void
  invoke(id: number, mods: PopupModifiers): void
  close(): void
  setSetting(key: string, value: unknown): void
  action(name: string): void
}

const api = (window as unknown as { overlay: OverlayApi }).overlay
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const menusEl = $<HTMLDivElement>('menus')
const settingsEl = $<HTMLElement>('settings')
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
  closeFrom(0)
  settingsEl.hidden = true
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
  closeFrom(0)
  settingsEl.hidden = true
  document.body.classList.remove('settings-open')
})

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
  } else {
    row.append(Object.assign(document.createElement('div'), { className: 'value', textContent: c.value }))
  }
  return row
}

function renderSettings(model: SettingsModel, keepScroll: boolean): void {
  const scroll = body.scrollTop
  nav.replaceChildren()
  body.replaceChildren()
  for (const section of model.sections) {
    const el = document.createElement('section')
    el.id = `s-${section.id}`
    el.append(Object.assign(document.createElement('h2'), { textContent: section.title }))
    const card = Object.assign(document.createElement('div'), { className: 'card' })
    for (const c of section.controls) card.append(control(c))
    el.append(card)
    body.append(el)
    const chip = Object.assign(document.createElement('button'), { type: 'button', textContent: section.title })
    chip.onclick = () => el.scrollIntoView({ block: 'start' })
    nav.append(chip)
  }
  if (keepScroll) body.scrollTop = scroll
  highlightNav()
}

function highlightNav(): void {
  const sections = [...body.querySelectorAll('section')]
  const top = body.getBoundingClientRect().top
  let current = 0
  sections.forEach((s, i) => {
    if (s.getBoundingClientRect().top - top < 80) current = i
  })
  ;[...nav.children].forEach((c, i) => c.classList.toggle('current', i === current))
}
body.addEventListener('scroll', highlightNav, { passive: true })

api.onShowSettings((model) => {
  setIncognito((model as SettingsModel & { incognito?: boolean }).incognito)
  closeFrom(0)
  renderSettings(model, false)
  settingsEl.hidden = false
  document.body.classList.add('settings-open')
  body.scrollTop = 0
  ;(settingsEl.querySelector('button, select') as HTMLElement | null)?.focus()
})
api.onUpdateSettings((model) => renderSettings(model, true))
$('settings-close').onclick = () => closeAll()
