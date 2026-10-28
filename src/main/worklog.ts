import { app, BrowserWindow, powerMonitor } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { WorklogEntry, WorklogModel, WorklogSlotted } from '../shared/types'
import type { Browser } from './browser'
import type { Tab } from './tab'
import { getSettings } from './settings'

/**
 * My Time: notices which ConnectWise ticket you're working on and for how long, so the day's time
 * entries are drafted for you. Only the active tab of the focused window counts, only while you're at
 * the computer, and only on your ConnectWise site. You review, edit and approve the entries (My Time
 * panel); Claude then enters the approved ones in ConnectWise through the browser (mcp-server.ts).
 *
 * Stored per day in <userData>/worklog/YYYY-MM-DD.json, kept for 60 days.
 */

const TICK_MS = 15_000
/** Coming back to the same ticket within this long continues its entry instead of starting a new one. */
const MERGE_GAP_MS = 10 * 60_000
const KEEP_DAYS = 60

interface Detected {
  ticket: string
  summary: string
}

const ID_PARAMS = ['service_recid', 'srRecID', 'srrecid', 'recid', 'ticketId', 'ticket_id', 'ticket']

function ticketFromText(text: string): Detected | null {
  const m = /(?:Service\s+)?Ticket\s*#?\s*(\d{3,})\s*(?:[-–—:|]\s*(.+))?/i.exec(text) ?? /#\s*(\d{4,})\b\s*(?:[-–—:|]\s*(.+))?/.exec(text)
  if (!m) return null
  return { ticket: m[1], summary: clean(m[2] ?? '') }
}

const clean = (s: string) => s.replace(/\s+/g, ' ').replace(/\s*[-–—|]\s*ConnectWise.*$/i, '').trim().slice(0, 120)

/** A local date as YYYY-MM-DD. */
export function dayOf(time: number): string {
  const d = new Date(time)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export class Worklog {
  private timer: NodeJS.Timeout | null = null
  private cache = new Map<string, WorklogEntry[]>()
  /** Last detection per page, so the page isn't read every tick. */
  private seen = new WeakMap<Electron.WebContents, { key: string; at: number; found: Detected | null }>()
  private remindedOn = ''
  /** Shows the end-of-day reminder (set by menu.ts). */
  remind: ((hours: number) => void) | null = null
  /** Something changed (an open My Time panel refreshes). */
  changed: (() => void) | null = null
  /**
   * The job you started from the My time panel ("Enter approved" or "Draft notes"), and until when.
   * Claude's tools that change entries only work during the matching job, so text on a web page
   * can't get Claude to mark entries entered or rewrite notes at some other time.
   */
  private job: { kind: 'enter' | 'draft-notes'; until: number } | null = null

  startJob(kind: 'enter' | 'draft-notes'): void {
    this.job = { kind, until: Date.now() + 45 * 60_000 }
  }

  inJob(kind: 'enter' | 'draft-notes'): boolean {
    return !!this.job && this.job.kind === kind && Date.now() < this.job.until
  }

  constructor(private readonly browser: Browser) {}

  /** Starts or stops tracking to match the setting. */
  sync(): void {
    const on = getSettings().worklog.enabled
    if (on && !this.timer) {
      this.timer = setInterval(() => void this.tick().catch(() => {}), TICK_MS)
      this.timer.unref()
      this.prune()
    } else if (!on && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  isPortal(url: string): boolean {
    let host = ''
    try {
      const u = new URL(url)
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
      host = u.hostname.toLowerCase()
    } catch {
      return false
    }
    const portal = portalHost()
    // Without an address set, only ConnectWise's own cloud domains count (not any host with "connectwise" in it).
    return portal ? host === portal || host.endsWith(`.${portal}`) : /(^|\.)(myconnectwise\.net|connectwisedev\.com)$/.test(host)
  }

  private async tick(): Promise<void> {
    const s = getSettings().worklog
    const now = Date.now()
    this.maybeRemind(now)
    if (powerMonitor.getSystemIdleTime() > s.idleMinutes * 60) return
    const win = BrowserWindow.getFocusedWindow()
    const w = win ? this.browser.windows.get(win.id) : undefined
    const tab = w && !w.incognito ? w.activeTab : null
    // Claude entering time in ConnectWise isn't you working on those tickets.
    if (!tab || tab.controlled || !this.isPortal(tab.url)) return
    const found = await this.detect(tab)
    if (found) this.record(found, now, TICK_MS)
  }

  /** Which ticket the tab shows: from its address, its title, or the ticket header on the page. */
  private async detect(tab: Tab): Promise<Detected | null> {
    try {
      const u = new URL(tab.url)
      for (const p of ID_PARAMS) {
        const v = u.searchParams.get(p)
        if (v && /^\d{3,}$/.test(v)) return { ticket: v, summary: ticketFromText(tab.title)?.summary ?? '' }
      }
    } catch {
      // not a URL
    }
    const fromTitle = ticketFromText(tab.title)
    if (fromTitle) return fromTitle
    const wc = tab.webContents
    if (!wc) return null
    const key = `${wc.getURL()}|${tab.title}`
    const prev = this.seen.get(wc)
    if (prev && prev.key === key && Date.now() - prev.at < 60_000) return prev.found
    // Read the ticket header (ConnectWise's single-page app often keeps one address and title).
    // Runs in an isolated world and only reads a few headings, on your ConnectWise site only.
    const text = (await wc
      .executeJavaScriptInIsolatedWorld(1718, [
        {
          code: `(() => {
            const docs = [document];
            for (const f of document.querySelectorAll('iframe')) { try { if (f.contentDocument) docs.push(f.contentDocument) } catch {} }
            const out = [];
            for (const d of docs) for (const el of [...d.querySelectorAll('h1,h2,h3,[class*="title" i],[class*="header" i],[class*="ticket" i]')].slice(0, 150)) {
              const t = (el.innerText || '').trim();
              if (t && t.length < 300 && /#\\s*\\d{3,}|ticket/i.test(t)) out.push(t);
              if (out.length > 20) break;
            }
            return out.join('\\n');
          })()`,
        },
      ])
      .catch(() => '')) as string
    let found: Detected | null = null
    for (const line of text.split('\n')) {
      found = ticketFromText(line)
      if (found) break
    }
    this.seen.set(wc, { key, at: Date.now(), found })
    return found
  }

  private record(found: Detected, now: number, ms: number): void {
    const day = dayOf(now)
    const entries = this.load(day)
    const last = entries.filter((e) => !e.manual).at(-1)
    if (last && last.ticket === found.ticket && last.status === 'draft' && now - last.end <= MERGE_GAP_MS) {
      last.end = now
      last.seconds += ms / 1000
      if (!last.summary && found.summary) last.summary = found.summary
    } else {
      entries.push({
        id: crypto.randomUUID(),
        ticket: found.ticket,
        summary: found.summary,
        start: now - ms,
        end: now,
        seconds: ms / 1000,
        notes: '',
        status: 'draft',
      })
    }
    this.save(day, entries)
  }

  private maybeRemind(now: number): void {
    const at = /^(\d{1,2}):(\d{2})$/.exec(getSettings().worklog.reminder.trim())
    if (!at || !this.remind) return
    const d = new Date(now)
    const day = dayOf(now)
    if (this.remindedOn === day || d.getHours() * 60 + d.getMinutes() < Number(at[1]) * 60 + Number(at[2])) return
    const waiting = slotted(this.load(day)).filter((e) => e.status === 'draft' || e.status === 'approved')
    if (!waiting.length) return
    this.remindedOn = day
    this.remind(waiting.reduce((h, e) => h + hoursOf(e), 0))
  }

  // ---- Storage ------------------------------------------------------------------

  private dir(): string {
    return path.join(app.getPath('userData'), 'worklog')
  }

  load(day: string): WorklogEntry[] {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Bad date')
    let entries = this.cache.get(day)
    if (!entries) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(this.dir(), `${day}.json`), 'utf8')) as { entries?: WorklogEntry[] }
        entries = Array.isArray(data.entries) ? data.entries : []
      } catch {
        entries = []
      }
      this.cache.set(day, entries)
    }
    return entries
  }

  private save(day: string, entries: WorklogEntry[]): void {
    this.cache.set(day, entries)
    fs.mkdirSync(this.dir(), { recursive: true })
    const file = path.join(this.dir(), `${day}.json`)
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ entries }, null, 1), { mode: 0o600 })
    fs.renameSync(`${file}.tmp`, file)
    this.changed?.()
  }

  private prune(): void {
    const cutoff = dayOf(Date.now() - KEEP_DAYS * 86_400_000)
    try {
      for (const f of fs.readdirSync(this.dir())) if (/^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(0, 10) < cutoff) fs.rmSync(path.join(this.dir(), f))
    } catch {
      // no folder yet
    }
  }

  // ---- Changes (from the My Time panel, or Claude through MCP) -------------------

  model(day: string): WorklogModel {
    const s = getSettings().worklog
    return {
      day,
      today: dayOf(Date.now()),
      enabled: s.enabled,
      roundMinutes: s.roundMinutes,
      entries: slotted(this.load(day)),
    }
  }

  add(day: string, ticket: string, start: number, end: number, notes = ''): WorklogEntry {
    const entry: WorklogEntry = { id: crypto.randomUUID(), ticket, summary: '', start, end, seconds: (end - start) / 1000, notes, status: 'draft', manual: true, timesSet: true }
    const entries = this.load(day)
    entries.push(entry)
    entries.sort((a, b) => a.start - b.start)
    this.save(day, entries)
    return entry
  }

  update(day: string, id: string, patch: Partial<Pick<WorklogEntry, 'ticket' | 'start' | 'end' | 'notes' | 'status'>>): WorklogEntry {
    const entries = this.load(day)
    const entry = entries.find((e) => e.id === id)
    if (!entry) throw new Error('No such time entry.')
    Object.assign(entry, patch)
    if (patch.start !== undefined || patch.end !== undefined) entry.timesSet = true
    if (entry.end <= entry.start) entry.end = entry.start + 60_000
    if (patch.notes !== undefined) entry.notesByClaude = false
    this.save(day, entries)
    return entry
  }

  /** Notes Claude suggests for a draft; marked as Claude's until you edit them. */
  suggestNotes(day: string, id: string, notes: string): void {
    const entry = this.update(day, id, { notes })
    entry.notesByClaude = true
    this.save(day, this.load(day))
  }

  remove(day: string, id: string): void {
    this.save(
      day,
      this.load(day).filter((e) => e.id !== id),
    )
  }

  /** Finds an entry by id on any recent day (Claude passes only the id). */
  find(id: string): { day: string; entry: WorklogEntry } | null {
    for (let i = 0; i < 14; i++) {
      const day = dayOf(Date.now() - i * 86_400_000)
      const entry = this.load(day).find((e) => e.id === id)
      if (entry) return { day, entry }
    }
    return null
  }
}

export function portalHost(): string {
  const raw = getSettings().worklog.portal.trim()
  if (!raw) return ''
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * Each entry's time slot as it goes into ConnectWise: start rounded to the nearest step and the
 * length rounded to whole steps (at least one), placed after the previous entry's slot so entries
 * never overlap (two short tickets in the same quarter hour become back-to-back slots). Times you
 * set yourself are used exactly. Skipped entries take no slot.
 */
export function slotted(entries: WorklogEntry[]): WorklogSlotted[] {
  const step = Math.max(1, getSettings().worklog.roundMinutes) * 60_000
  let previousEnd = 0
  return [...entries]
    .sort((a, b) => a.start - b.start)
    .map((e) => {
      if (e.timesSet) {
        if (e.status !== 'skipped') previousEnd = Math.max(previousEnd, e.end)
        return { ...e, slotStart: e.start, slotEnd: e.end }
      }
      let slotStart = Math.round(e.start / step) * step
      if (e.status !== 'skipped' && slotStart < previousEnd) slotStart = previousEnd
      const slotEnd = slotStart + Math.max(1, Math.round((e.end - e.start) / step)) * step
      if (e.status !== 'skipped') previousEnd = slotEnd
      return { ...e, slotStart, slotEnd }
    })
}

export function hoursOf(e: WorklogSlotted): number {
  return (e.slotEnd - e.slotStart) / 3_600_000
}

export function clock(time: number): string {
  return new Date(time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}
