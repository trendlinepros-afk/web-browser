import { app, type Session } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

/**
 * User-Agent Client Hints. Chromium's renderer already reports the right values to page scripts
 * (navigator.userAgentData), but Electron never sends the matching Sec-CH-UA request headers, and
 * ignores sites' requests for more detail (Accept-CH). Sites that compare the two, like Google and
 * Cloudflare, read that mismatch as a bot. This module sends exactly what Chromium would.
 */

interface BrandVersion {
  brand: string
  version: string
}

export interface UaMetadata {
  chromeVersion: string
  brands: BrandVersion[]
  fullVersionList: BrandVersion[]
  platform: string
  platformVersion: string | null
  architecture: string
  bitness: string
  model: string
  wow64: boolean
  formFactors: string[]
}

const HIGH_ENTROPY = ['architecture', 'bitness', 'model', 'platformVersion', 'fullVersionList', 'wow64', 'formFactors'] as const

/**
 * Chromium's GREASE brand list (components/embedder_support/user_agent_utils.cc) for a build
 * without a product brand: a deliberately odd "Not…A…Brand" entry plus "Chromium", ordered and
 * spelled by the major version.
 */
function greasedBrands(major: number, chromiumVersion: string, full: boolean): BrandVersion[] {
  const chars = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_']
  const versions = ['8', '99', '24']
  const greaseVersion = versions[major % versions.length]
  const grease = {
    brand: `Not${chars[major % chars.length]}A${chars[(major + 1) % chars.length]}Brand`,
    version: full ? `${greaseVersion}.0.0.0` : greaseVersion,
  }
  const list: BrandVersion[] = []
  list[major % 2] = grease
  list[(major + 1) % 2] = { brand: 'Chromium', version: chromiumVersion }
  return list
}

function platformName(): string {
  return process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux'
}

function computedMetadata(): UaMetadata {
  const full = process.versions.chrome
  const major = Number(full.split('.')[0])
  return {
    chromeVersion: full,
    brands: greasedBrands(major, String(major), false),
    fullVersionList: greasedBrands(major, full, true),
    platform: platformName(),
    // Only the renderer knows the exact OS version string Chromium reports; learned below.
    platformVersion: null,
    architecture: process.arch === 'arm64' ? 'arm' : 'x86',
    bitness: process.arch === 'ia32' ? '32' : '64',
    model: '',
    wow64: false,
    formFactors: ['Desktop'],
  }
}

let metadata: UaMetadata | null = null

function cacheFile(): string {
  return path.join(app.getPath('userData'), 'ua-metadata.json')
}

export function uaMetadata(): UaMetadata {
  if (metadata) return metadata
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile(), 'utf8')) as UaMetadata
    if (cached.chromeVersion === process.versions.chrome) return (metadata = cached)
  } catch {
    // Not learned yet for this Chromium version.
  }
  return (metadata = computedMetadata())
}

/** Whether pages should report the renderer's real values (once per Chromium version). */
export function needsLearning(): boolean {
  return uaMetadata().platformVersion === null
}

/** The page preload reports navigator.userAgentData's real values; they become the source of truth. */
export function learnFromRenderer(values: Record<string, unknown>): void {
  const current = uaMetadata()
  const brands = values.brands as BrandVersion[] | undefined
  const fullVersionList = values.fullVersionList as BrandVersion[] | undefined
  metadata = {
    ...current,
    ...(Array.isArray(brands) && brands.length ? { brands } : {}),
    ...(Array.isArray(fullVersionList) && fullVersionList.length ? { fullVersionList } : {}),
    platform: typeof values.platform === 'string' ? values.platform : current.platform,
    platformVersion: typeof values.platformVersion === 'string' ? values.platformVersion : current.platformVersion,
    architecture: typeof values.architecture === 'string' ? values.architecture : current.architecture,
    bitness: typeof values.bitness === 'string' ? values.bitness : current.bitness,
    model: typeof values.model === 'string' ? values.model : current.model,
    wow64: typeof values.wow64 === 'boolean' ? values.wow64 : current.wow64,
    formFactors: Array.isArray(values.formFactors) ? (values.formFactors as string[]) : current.formFactors,
  }
  try {
    fs.writeFileSync(cacheFile(), JSON.stringify(metadata))
  } catch {
    // Best effort.
  }
}

export const HIGH_ENTROPY_HINTS = HIGH_ENTROPY

// ---- Headers ------------------------------------------------------------------

const quote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
const list = (bv: BrandVersion[]) => bv.map((b) => `${quote(b.brand)};v=${quote(b.version)}`).join(', ')

/** Origins that asked for extra hints via Accept-CH, per session (incognito keeps its own). */
const requested = new WeakMap<Session, Map<string, Set<string>>>()

function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

function isSecure(url: string): boolean {
  return url.startsWith('https:') || url.startsWith('wss:') || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url)
}

/** Remember which hints an origin asked for (Accept-CH / Critical-CH response headers). */
export function recordAcceptCh(ses: Session, url: string, headers: Record<string, string[]> | undefined): void {
  if (!headers || !isSecure(url)) return
  const origin = originOf(url)
  if (!origin) return
  for (const [name, values] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (lower !== 'accept-ch' && lower !== 'critical-ch') continue
    let perSession = requested.get(ses)
    if (!perSession) requested.set(ses, (perSession = new Map()))
    const set = perSession.get(origin) ?? new Set<string>()
    for (const v of values.join(',').split(',')) {
      const hint = v.trim().toLowerCase()
      if (hint) set.add(hint)
    }
    perSession.set(origin, set)
  }
}

/**
 * Puts the Sec-CH-UA headers Chromium would send for this request into `out`, in Chrome's order
 * (low-entropy hints first). `existing` are the request's current headers.
 */
export function addClientHints(ses: Session, url: string, existing: Record<string, string>, out: Record<string, string>): void {
  if (!isSecure(url)) return
  if (Object.keys(existing).some((h) => h.toLowerCase() === 'sec-ch-ua')) return
  const headers = out
  const m = uaMetadata()
  headers['sec-ch-ua'] = list(m.brands)
  headers['sec-ch-ua-mobile'] = '?0'
  headers['sec-ch-ua-platform'] = quote(m.platform)

  const origin = originOf(url)
  const asked = origin ? requested.get(ses)?.get(origin) : undefined
  if (!asked) return
  if (asked.has('sec-ch-ua-full-version-list')) headers['sec-ch-ua-full-version-list'] = list(m.fullVersionList)
  if (asked.has('sec-ch-ua-full-version')) headers['sec-ch-ua-full-version'] = quote(m.chromeVersion)
  if (asked.has('sec-ch-ua-platform-version') && m.platformVersion !== null) headers['sec-ch-ua-platform-version'] = quote(m.platformVersion)
  if (asked.has('sec-ch-ua-arch')) headers['sec-ch-ua-arch'] = quote(m.architecture)
  if (asked.has('sec-ch-ua-bitness')) headers['sec-ch-ua-bitness'] = quote(m.bitness)
  if (asked.has('sec-ch-ua-model')) headers['sec-ch-ua-model'] = quote(m.model)
  if (asked.has('sec-ch-ua-wow64')) headers['sec-ch-ua-wow64'] = m.wow64 ? '?1' : '?0'
  if (asked.has('sec-ch-ua-form-factors')) headers['sec-ch-ua-form-factors'] = m.formFactors.map(quote).join(', ')
}

/** Accept-Language like Chrome builds it: the system languages, each followed by its base language. */
export function acceptLanguages(): string {
  const out: string[] = []
  const add = (l: string) => {
    if (l && !out.includes(l)) out.push(l)
  }
  for (const lang of app.getPreferredSystemLanguages().length ? app.getPreferredSystemLanguages() : ['en-US']) {
    add(lang)
    add(lang.split('-')[0])
  }
  return out.join(',')
}
