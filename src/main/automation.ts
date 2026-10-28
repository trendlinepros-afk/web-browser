import type { WebContents } from 'electron'
import type { Tab } from './tab'
import { describeDialog, pendingDialog } from './dialogs'

/**
 * Page automation used by the MCP server. Page scripts run in an isolated JS world, so they
 * share the DOM with the page but can't be seen or tampered with by the page's own scripts.
 */
const WORLD_ID = 1717

async function run<T>(wc: WebContents, code: string): Promise<T> {
  // Chromium replaces thrown errors with a generic message, so carry the real one back as data.
  // Checked again inside the page, so a page that navigated away after the tab was checked (to a local
  // file or an extension page) is never read.
  const wrapped = `(() => { if (!/^(https?|about|data):$/.test(location.protocol)) return { ok: false, error: "Claude can only access web pages." }; try { return { ok: true, value: (${code}) } } catch (e) { return { ok: false, error: String(e && e.message || e) } } })()`
  type Result = { ok: true; value: T } | { ok: false; error: string }
  const open = pendingDialog(wc)
  if (open) throw new Error(describeDialog(open))
  // A page showing a dialog is frozen until it's answered: report the dialog instead of hanging.
  let done = false
  const exec = (wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code: wrapped }], true) as Promise<Result>).finally(() => (done = true))
  const dialog = (async (): Promise<Result> => {
    while (!done) {
      await delay(100)
      const d = !done && !wc.isDestroyed() ? pendingDialog(wc) : null
      if (d) return { ok: false, error: describeDialog(d) }
    }
    return exec
  })()
  const result = await Promise.race([exec, dialog])
  if (!result.ok) throw new Error(result.error)
  return result.value
}

/**
 * Shared in-page helpers: element refs that stay stable across snapshots of the same document, and
 * the page's same-site frames (business apps often put forms in iframes). Frames from other sites
 * can't be reached from here; snapshots list them so Claude can open them in a tab instead.
 */
const PRELUDE = `
const S = window.__wbAuto || (window.__wbAuto = { next: 1, byId: new Map(), byEl: new WeakMap() });
const refOf = (el) => {
  let id = S.byEl.get(el);
  if (!id) { id = S.next++; S.byEl.set(el, id); S.byId.set(id, new WeakRef(el)); }
  return id;
};
const childDoc = (f) => { try { const d = f.contentDocument; return d && d.documentElement ? d : null; } catch { return null; } };
const docs = () => {
  const out = [];
  const walk = (d, depth) => { out.push(d); if (depth > 5) return; for (const f of d.querySelectorAll('iframe,frame')) { const cd = childDoc(f); if (cd) walk(cd, depth + 1); } };
  walk(document, 0);
  return out;
};
/** Where a frame's document sits in the top window's viewport. */
const offsetOf = (doc) => {
  let x = 0, y = 0, w = doc.defaultView;
  while (w && w !== window) {
    const fe = w.frameElement;
    if (!fe) break;
    const r = fe.getBoundingClientRect();
    x += r.left + fe.clientLeft; y += r.top + fe.clientTop;
    w = w.parent;
  }
  return { x, y };
};
const rectOf = (el) => { const r = el.getBoundingClientRect(); const o = offsetOf(el.ownerDocument); return { left: r.left + o.x, top: r.top + o.y, width: r.width, height: r.height, right: r.right + o.x, bottom: r.bottom + o.y }; };
const query = (selector) => { for (const d of docs()) { const el = d.querySelector(selector); if (el) return el; } return null; };
const resolve = (ref, selector) => {
  if (ref != null) {
    const el = S.byId.get(Number(ref))?.deref();
    if (!el || !el.isConnected) throw new Error('Element ref ' + ref + ' is gone; take a new snapshot.');
    return el;
  }
  if (selector) {
    const el = query(selector);
    if (!el) throw new Error('No element matches selector: ' + selector);
    return el;
  }
  throw new Error('Pass either ref or selector.');
};
`

export interface SnapshotElement {
  ref: number
  role: string
  name: string
  value?: string
  checked?: boolean
  disabled?: boolean
  inView: boolean
}

export interface Snapshot {
  title: string
  url: string
  /** Frames from another site, which can only be used by opening them in their own tab. */
  otherFrames: string[]
  scrollY: number
  viewportHeight: number
  documentHeight: number
  headings: string[]
  elements: SnapshotElement[]
  truncated: number
}

export function snapshot(wc: WebContents, limit = 250): Promise<Snapshot> {
  return run<Snapshot>(
    wc,
    `(() => { ${PRELUDE}
  const SEL = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=combobox],[role=textbox],[role=searchbox],[contenteditable=""],[contenteditable=true],[onclick]';
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
  const vh = innerHeight, vw = innerWidth;
  const items = [];
  const otherFrames = [];
  const all = docs();
  for (const d of all) for (const f of d.querySelectorAll('iframe,frame')) {
    if (childDoc(f)) continue;
    const r = rectOf(f);
    if (r.width > 40 && r.height > 40 && /^https?:/.test(f.src)) otherFrames.push(f.src.slice(0, 200));
  }
  for (const el of all.flatMap((d) => [...d.querySelectorAll(SEL)])) {
    const r = rectOf(el);
    if (r.width < 1 || r.height < 1) continue;
    const cs = el.ownerDocument.defaultView.getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    let role = el.getAttribute('role') || ({ a: 'link', button: 'button', select: 'select', textarea: 'textarea', summary: 'button' })[tag] || (tag === 'input' ? 'input:' + (type || 'text') : tag);
    const labelled = el.getAttribute('aria-labelledby');
    const name = clean(
      el.getAttribute('aria-label') ||
      (labelled && labelled.split(' ').map((id) => el.ownerDocument.getElementById(id)?.innerText || '').join(' ')) ||
      (el.labels && el.labels[0] && el.labels[0].innerText) ||
      el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') ||
      (tag === 'input' && ['submit', 'button'].includes(type) ? el.value : '') ||
      el.innerText || el.getAttribute('name') || ''
    );
    const item = { ref: refOf(el), role, name, inView: r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw, y: r.top };
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      if (type === 'checkbox' || type === 'radio') item.checked = el.checked;
      else if (type === 'password') item.value = el.value ? '••••••' : '';
      else item.value = clean(el.value);
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') item.disabled = true;
    items.push(item);
  }
  items.sort((a, b) => (b.inView - a.inView) || (a.y - b.y));
  const elements = items.slice(0, ${limit}).map(({ y, ...rest }) => rest);
  const headings = all.flatMap((d) => [...d.querySelectorAll('h1,h2,h3')]).map((h) => clean(h.innerText)).filter(Boolean).slice(0, 20);
  return { title: document.title, url: location.href, otherFrames: otherFrames.slice(0, 10), scrollY: Math.round(scrollY), viewportHeight: vh,
    documentHeight: document.documentElement.scrollHeight, headings, elements, truncated: Math.max(0, items.length - ${limit}) };
})()`,
  )
}

export function formatSnapshot(s: Snapshot): string {
  const lines = [
    `Title: ${s.title}`,
    `URL: ${s.url}`,
    `Scroll: ${s.scrollY}/${Math.max(0, s.documentHeight - s.viewportHeight)}px`,
  ]
  if (s.headings.length) lines.push(`Headings: ${s.headings.join(' | ')}`)
  lines.push('', 'Interactive elements ([ref] role "name"; * = currently in view):')
  for (const e of s.elements) {
    let line = `${e.inView ? '*' : ' '}[${e.ref}] ${e.role} "${e.name}"`
    if (e.value !== undefined) line += ` value="${e.value}"`
    if (e.checked !== undefined) line += e.checked ? ' (checked)' : ' (unchecked)'
    if (e.disabled) line += ' (disabled)'
    lines.push(line)
  }
  if (s.truncated) lines.push(`… ${s.truncated} more elements not shown (scroll and snapshot again).`)
  if (s.otherFrames.length) {
    lines.push('', 'Embedded frames from other sites (not reachable here; open the address in a tab to use one):')
    for (const f of s.otherFrames) lines.push(`  ${f}`)
  }
  return lines.join('\n')
}

export function readText(wc: WebContents, offset: number, limit: number): Promise<{ text: string; total: number }> {
  return run(
    wc,
    `(() => { ${PRELUDE}
      const t = docs().map((d, i) => (i ? '\\n\\n[frame]\\n' : '') + (d.body?.innerText || '')).join('').replace(/\\n{3,}/g, '\\n\\n');
      return { text: t.slice(${offset}, ${offset + limit}), total: t.length }; })()`,
  )
}

interface Target {
  ref?: number
  selector?: string
}

function targetArgs(t: Target): string {
  return `${JSON.stringify(t.ref ?? null)}, ${JSON.stringify(t.selector ?? null)}`
}

/** True when the tab is on screen, so we can send real (trusted) input events to it. */
function isVisible(tab: Tab): boolean {
  const win = tab.window.win
  return tab.window.activeTab === tab && !win.isDestroyed() && win.isVisible() && !win.isMinimized()
}

export async function click(tab: Tab, wc: WebContents, t: Target): Promise<string> {
  const info = await run<{ x: number; y: number; label: string }>(
    wc,
    `(() => { ${PRELUDE}
      const el = resolve(${targetArgs(t)});
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const r = rectOf(el);
      const label = (el.innerText || el.getAttribute('aria-label') || el.tagName).replace(/\\s+/g, ' ').trim().slice(0, 60);
      ${isVisible(tab) ? '' : 'el.click();'}
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, label };
    })()`,
  )
  if (isVisible(tab)) {
    const zoom = wc.getZoomFactor()
    const x = Math.round(info.x * zoom)
    const y = Math.round(info.y * zoom)
    wc.sendInputEvent({ type: 'mouseMove', x, y })
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
  }
  await settle(wc)
  return `Clicked "${info.label}".`
}

export async function type(wc: WebContents, t: Target, text: string, clear: boolean): Promise<void> {
  await run(
    wc,
    `(() => { ${PRELUDE}
      const el = resolve(${targetArgs(t)});
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      el.focus();
      if (${clear}) {
        if ('select' in el && typeof el.select === 'function') el.select();
        else { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
      }
      return true;
    })()`,
  )
  wc.insertText(text)
  // Fallback for pages where focus didn't land (e.g. tab hidden): set the value directly.
  await run(
    wc,
    `(() => { ${PRELUDE}
      const el = resolve(${targetArgs(t)});
      const want = ${JSON.stringify(text)};
      if (!('value' in el) || String(el.value).includes(want)) return;
      const proto = Object.getPrototypeOf(el);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      const next = ${clear} ? want : el.value + want;
      setter ? setter.call(el, next) : (el.value = next);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`,
  )
}

/**
 * Picks an option in a <select> by its visible text (or value). Custom dropdowns (a text box with a
 * list that pops up) are used with click/type instead.
 */
export async function selectOption(wc: WebContents, t: Target, option: string): Promise<string> {
  return run<string>(
    wc,
    `(() => { ${PRELUDE}
      const el = resolve(${targetArgs(t)});
      if (el.tagName !== 'SELECT') throw new Error('That element is not a <select> list; click it and pick the option instead.');
      const want = ${JSON.stringify(option)}.trim().toLowerCase();
      const opts = [...el.options];
      const match = opts.find((o) => o.text.trim().toLowerCase() === want) || opts.find((o) => o.value.toLowerCase() === want) || opts.find((o) => o.text.trim().toLowerCase().includes(want));
      if (!match) throw new Error('No option matches "' + ${JSON.stringify(option)} + '". Options: ' + opts.map((o) => o.text.trim()).filter(Boolean).slice(0, 40).join(' | '));
      el.focus();
      el.value = match.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'Selected "' + match.text.trim() + '".';
    })()`,
  )
}

const CHAR_FOR_KEY: Record<string, string> = { Enter: '\r', Space: ' ', Tab: '\t' }

export async function pressKey(wc: WebContents, key: string, modifiers: string[] = []): Promise<void> {
  const mods = modifiers as Electron.InputEvent['modifiers']
  wc.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: mods })
  const ch = CHAR_FOR_KEY[key] ?? (key.length === 1 ? key : null)
  if (ch && !modifiers.some((m) => ['control', 'meta', 'alt'].includes(m))) {
    wc.sendInputEvent({ type: 'char', keyCode: ch, modifiers: mods })
  }
  wc.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: mods })
  await settle(wc)
}

export async function scroll(wc: WebContents, dy: number, t?: Target): Promise<string> {
  return run<string>(
    wc,
    `(() => { ${PRELUDE}
      const target = ${t && (t.ref != null || t.selector) ? `resolve(${targetArgs(t)})` : 'null'};
      if (target) { target.scrollIntoView({ block: 'center', behavior: 'instant' }); return 'Scrolled element into view.'; }
      scrollBy({ top: ${dy}, behavior: 'instant' });
      return 'Scrolled to ' + Math.round(scrollY) + '/' + Math.max(0, document.documentElement.scrollHeight - innerHeight) + 'px.';
    })()`,
  )
}

export async function waitFor(
  wc: WebContents,
  opts: { selector?: string; text?: string; timeoutMs: number },
): Promise<boolean> {
  const deadline = Date.now() + opts.timeoutMs
  while (Date.now() < deadline) {
    if (wc.isDestroyed()) return false
    if (!opts.selector && !opts.text) {
      if (!wc.isLoading()) return true
    } else {
      const found = await run<boolean>(
        wc,
        `(() => { ${PRELUDE}
          ${opts.selector ? `if (!query(${JSON.stringify(opts.selector)})) return false;` : ''}
          ${opts.text ? `if (!docs().some((d) => (d.body?.innerText || '').includes(${JSON.stringify(opts.text)}))) return false;` : ''}
          return true; })()`,
      ).catch(() => false)
      if (found) return true
    }
    await delay(150)
  }
  return false
}

export async function evaluate(wc: WebContents, code: string): Promise<unknown> {
  return wc.executeJavaScript(code, true)
}

/** Lets a click/keypress kick off navigation, then waits (bounded) for loading to finish. */
export async function settle(wc: WebContents, timeoutMs = 10_000): Promise<void> {
  await delay(250)
  const deadline = Date.now() + timeoutMs
  while (!wc.isDestroyed() && wc.isLoading() && !pendingDialog(wc) && Date.now() < deadline) await delay(100)
}

export async function navigateAndWait(wc: WebContents, url: string, timeoutMs = 20_000): Promise<void> {
  const done = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    wc.once('did-stop-loading', () => {
      clearTimeout(timer)
      resolve()
    })
  })
  wc.loadURL(url).catch(() => {})
  await done
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
