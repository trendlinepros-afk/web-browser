import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

export interface Settings {
  searchEngine: string
  /** Where the home button goes. Empty (or about:blank) means a blank new-tab page. */
  homepage: string
  showHomeButton: boolean
  /** Hidden tabs are put to sleep after this many minutes. 0 disables time-based sleeping. */
  discardAfterMinutes: number
  /** Sleep least-recently-used tabs when free system memory drops below this (MB). 0 disables. */
  memoryPressureFreeMB: number
  sleepPinnedTabs: boolean
  restoreSession: boolean
  checkForUpdatesOnStartup: boolean
  showBookmarksBar: boolean
  theme: 'system' | 'dark' | 'light'
  /** The first-run "make default browser" question has been asked. */
  askedDefaultBrowser: boolean
  blocking: {
    /** Block ads, trackers and known malware/scam domains. */
    enabled: boolean
    /** Also hide cookie-consent banners. */
    cookieBanners: boolean
    /** Sites (registrable domains, e.g. "example.com") where blocking is turned off. */
    allowlist: string[]
  }
  privacy: {
    /** Send the Global Privacy Control signal (Sec-GPC: 1), a legal "do not sell/share" request in some regions. */
    globalPrivacyControl: boolean
  }
  mcp: {
    enabled: boolean
    port: number
    token: string
    allowEvaluate: boolean
    allowIncognito: boolean
  }
}

const DEFAULTS: Settings = {
  searchEngine: 'https://www.google.com/search?q=%s',
  homepage: '',
  showHomeButton: true,
  discardAfterMinutes: 15,
  memoryPressureFreeMB: 800,
  sleepPinnedTabs: false,
  restoreSession: true,
  checkForUpdatesOnStartup: true,
  showBookmarksBar: true,
  theme: 'system',
  askedDefaultBrowser: false,
  blocking: {
    enabled: true,
    cookieBanners: true,
    allowlist: [],
  },
  privacy: {
    globalPrivacyControl: true,
  },
  mcp: {
    enabled: false,
    port: 47823,
    token: '',
    allowEvaluate: false,
    allowIncognito: false,
  },
}

let cached: Settings | null = null
let writeTimer: NodeJS.Timeout | null = null

/** Where settings live; the MCP bridge (mcp-bridge.ts) reads the port and token from here. */
export function settingsFile(): string {
  return file()
}

function file(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

export function getSettings(): Settings {
  if (cached) return cached
  let stored: Partial<Settings> = {}
  try {
    stored = JSON.parse(fs.readFileSync(file(), 'utf8'))
  } catch {
    // First run or unreadable file: fall back to defaults.
  }
  cached = {
    ...DEFAULTS,
    ...stored,
    blocking: { ...DEFAULTS.blocking, ...(stored.blocking ?? {}) },
    privacy: { ...DEFAULTS.privacy, ...(stored.privacy ?? {}) },
    mcp: { ...DEFAULTS.mcp, ...(stored.mcp ?? {}) },
  }
  return cached
}

export function updateSettings(patch: (s: Settings) => void): Settings {
  const s = getSettings()
  patch(s)
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = setTimeout(flushSettings, 250)
  return s
}

export function flushSettings(): void {
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = null
  if (!cached) return
  fs.mkdirSync(path.dirname(file()), { recursive: true })
  fs.writeFileSync(file(), JSON.stringify(cached, null, 2))
}
