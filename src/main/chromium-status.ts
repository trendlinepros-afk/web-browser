import { net } from 'electron'
import type { ChromiumStatus, PromptSpec } from '../shared/types'
import { getSettings } from './settings'

/**
 * The "Chromium" tag in the tab strip: which Chromium this build runs, and whether a newer one exists.
 *
 * Zirtola gets Chromium through Electron, so "newer" means a newer Electron release (npm's `latest`):
 * a patch in the same major ships on its own (.github/workflows/electron-security.yml), a new major
 * needs a tested Zirtola update. Google Chrome's own stable version is shown for reference; Electron
 * adopts each Chromium after it reaches Chrome.
 */

const CHROME_PLATFORM: Record<string, string> = { win32: 'win64', darwin: 'mac', linux: 'linux' }

let status: ChromiumStatus = {
  version: process.versions.chrome,
  electron: process.versions.electron,
  state: 'unknown',
}
let onChange: () => void = () => {}
let checking: Promise<void> | null = null

export function chromiumStatus(): ChromiumStatus {
  return status
}

/** Compares dotted version numbers; >0 when a is newer. Pre-release suffixes are ignored. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('-')[0].split('.').map(Number)
  const pb = b.split('-')[0].split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}

async function getJson<T>(url: string): Promise<T> {
  const res = await net.fetch(url, { signal: AbortSignal.timeout(15_000), cache: 'no-store' })
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  return (await res.json()) as T
}

async function latestChrome(): Promise<string | undefined> {
  const platform = CHROME_PLATFORM[process.platform] ?? 'win64'
  const body = await getJson<{ versions?: { version: string }[] }>(
    `https://versionhistory.googleapis.com/v1/chrome/platforms/${platform}/channels/stable/versions?pageSize=1`,
  )
  return body.versions?.[0]?.version
}

async function latestElectron(): Promise<string> {
  return (await getJson<{ version: string }>('https://registry.npmjs.org/electron/latest')).version
}

/** Looks up the newest versions. Never throws; on failure the tag just shows the version. */
export function checkChromium(): Promise<void> {
  checking ??= (async () => {
    status = { ...status, state: 'checking' }
    onChange()
    const [electron, chrome] = await Promise.allSettled([latestElectron(), latestChrome()])
    const next: ChromiumStatus = {
      version: process.versions.chrome,
      electron: process.versions.electron,
      state: 'unknown',
      checkedAt: Date.now(),
    }
    if (chrome.status === 'fulfilled') next.chromeStable = chrome.value
    if (electron.status === 'fulfilled') {
      next.electronLatest = electron.value
      const newer = compareVersions(electron.value, process.versions.electron) > 0
      const sameMajor = electron.value.split('.')[0] === process.versions.electron.split('.')[0]
      next.state = !newer ? 'latest' : sameMajor ? 'patch' : 'major'
    }
    status = next
    onChange()
  })().finally(() => (checking = null))
  return checking
}

/** Checks a little after startup, then twice a day, when automatic update checks are on. */
export function startChromiumStatus(changed: () => void): void {
  onChange = changed
  const run = () => {
    if (getSettings().checkForUpdatesOnStartup) void checkChromium()
  }
  setTimeout(run, 15_000)
  setInterval(run, 12 * 60 * 60 * 1000).unref()
}

/** The tag's click: what it means in plain words, and a way to update. */
export async function showChromiumInfo(
  prompt: (spec: PromptSpec) => Promise<number>,
  checkForUpdates: () => Promise<void>,
): Promise<void> {
  if (status.state === 'unknown' && !status.checkedAt) await checkChromium()
  const s = status
  const lines: Record<ChromiumStatus['state'], string> = {
    latest: 'This is the newest Chromium available for Zirtola.',
    patch: `A Chromium security patch is out (Electron ${s.electronLatest}). Zirtola picks it up on its own, usually within a day, and it arrives through Check for updates.`,
    major: `A newer Chromium is out (Electron ${s.electronLatest}). Big Chromium upgrades are tested before they ship, so ask Claude to "update Chromium" when you want it.`,
    unknown: "Couldn't check for newer versions (offline?).",
    checking: 'Checking for newer versions…',
  }
  const detail = [
    `Engine: Electron ${s.electron}.`,
    s.chromeStable && `Google Chrome stable is ${s.chromeStable}; Electron adopts each Chromium after it reaches Chrome.`,
    s.checkedAt && `Checked ${new Date(s.checkedAt).toLocaleString()}.`,
  ]
    .filter(Boolean)
    .join(' ')
  const choice = await prompt({
    kind: s.state === 'patch' || s.state === 'major' ? 'warning' : 'info',
    title: `Chromium ${s.version}`,
    message: lines[s.state],
    detail,
    buttons: ['Check for updates', 'Close'],
    defaultId: 0,
    cancelId: 1,
  })
  if (choice === 0) {
    void checkChromium()
    await checkForUpdates()
  }
}
