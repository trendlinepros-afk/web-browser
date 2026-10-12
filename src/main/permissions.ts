import { BrowserWindow, dialog, type Session, type WebContents } from 'electron'
import type { Browser } from './browser'

/** Granted silently: harmless or needed for normal browsing. */
const ALWAYS_ALLOW = new Set(['clipboard-sanitized-write', 'fullscreen', 'pointerLock', 'keyboardLock', 'speaker-selection'])

/** Prompt the user once per site for these. Anything not listed here or above is denied. */
const ASK: Record<string, string> = {
  media: 'use your camera and/or microphone',
  geolocation: 'know your location',
  notifications: 'show notifications',
  midi: 'use your MIDI devices',
  midiSysex: 'get full control of your MIDI devices',
  'clipboard-read': 'see text and images copied to the clipboard',
  'display-capture': 'see your screen',
  'idle-detection': 'know when you are actively using this device',
  'window-management': 'manage windows on all your displays',
  'storage-access': 'use cookies and site data in this context',
  'top-level-storage-access': 'use cookies and site data in this context',
}

/** Direct hardware access from web pages is off in Stage 1. */
const DEVICE_ACCESS = new Set(['hid', 'serial', 'usb', 'bluetooth'])

// Decisions are kept for the life of the app (persisted per-site settings arrive in Stage 2).
const decisions = new Map<string, boolean>()

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}

function describeMedia(details: Electron.PermissionRequest | Electron.MediaAccessPermissionRequest): string {
  const types = (details as Electron.MediaAccessPermissionRequest).mediaTypes ?? []
  if (types.includes('video') && types.includes('audio')) return 'use your camera and microphone'
  if (types.includes('video')) return 'use your camera'
  if (types.includes('audio')) return 'use your microphone'
  return ASK.media
}

/** Web permission names (navigator.permissions) for each Electron permission we prompt for. */
const WEB_NAMES: Record<string, string[]> = {
  media: ['camera', 'microphone'],
  geolocation: ['geolocation'],
  notifications: ['notifications'],
  midi: ['midi'],
  'clipboard-read': ['clipboard-read'],
  'idle-detection': ['idle-detection'],
  'window-management': ['window-management'],
  'storage-access': ['storage-access'],
}

/**
 * Permissions this site hasn't been asked about yet. Electron can only report "granted" or
 * "denied", but a browser reports "prompt" until you decide, and an all-denied profile is a
 * classic bot signature. The page preload reports these as "prompt"; asking still shows our dialog.
 */
export function undecidedPermissions(url: string): string[] {
  const origin = originOf(url)
  const out: string[] = []
  for (const [permission, names] of Object.entries(WEB_NAMES)) {
    if (!decisions.has(`${origin}|${permission}`)) out.push(...names)
  }
  return out
}

export function configureSession(ses: Session, browser: Browser): void {
  ses.setPermissionRequestHandler(async (wc: WebContents | null, permission, callback, details) => {
    const origin = originOf(details.requestingUrl ?? wc?.getURL() ?? '')
    if (origin.startsWith('chrome-extension://') || ALWAYS_ALLOW.has(permission)) return callback(true)
    if (!(permission in ASK)) return callback(false)

    const key = `${origin}|${permission}`
    const remembered = decisions.get(key)
    if (remembered !== undefined) return callback(remembered)

    const win = (wc && (browser.fromWebContents(wc)?.win ?? BrowserWindow.fromWebContents(wc))) || undefined
    const what = permission === 'media' ? describeMedia(details) : ASK[permission]
    const options: Electron.MessageBoxOptions = {
      type: 'question',
      buttons: ['Allow', 'Block'],
      defaultId: 1,
      cancelId: 1,
      title: 'Permission request',
      message: `${new URL(origin).host || origin} wants to ${what}.`,
    }
    const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
    const allowed = response === 0
    decisions.set(key, allowed)
    callback(allowed)
  })

  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    const origin = originOf(requestingOrigin)
    if (origin.startsWith('chrome-extension://') || ALWAYS_ALLOW.has(permission)) return true
    const remembered = decisions.get(`${origin}|${permission}`)
    if (remembered !== undefined) return remembered
    return !(permission in ASK) && !DEVICE_ACCESS.has(permission)
  })
}
