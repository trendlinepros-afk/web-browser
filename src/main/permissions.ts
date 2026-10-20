import { BrowserWindow, dialog, type Session, type WebContents } from 'electron'
import type { Browser } from './browser'
import type { PromptSpec } from '../shared/types'

/**
 * Granted silently: harmless or needed for normal browsing. Storage access is granted like Chrome
 * does while third-party cookies are allowed; embedded logins and reCAPTCHA break (and look like
 * bots) without it.
 */
const ALWAYS_ALLOW = new Set([
  'clipboard-sanitized-write',
  'fullscreen',
  'pointerLock',
  'keyboardLock',
  'speaker-selection',
  'storage-access',
  'top-level-storage-access',
])

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
}

/**
 * Extensions get what they need without prompts, except these, which they must ask for like any
 * site (an extension shouldn't quietly turn on your camera or read your location).
 */
const ASK_EXTENSIONS_TOO = new Set(['media', 'geolocation', 'display-capture', 'clipboard-read', 'idle-detection', 'window-management', 'midiSysex'])

const isExtension = (origin: string) => origin.startsWith('chrome-extension://')

/** Direct hardware access from web pages is off in Stage 1. */
const DEVICE_ACCESS = new Set(['hid', 'serial', 'usb', 'bluetooth'])

// Decisions are kept for the life of the app (persisted per-site settings arrive in Stage 2).
const decisions = new Map<string, boolean>()

function originOf(url: string): string {
  try {
    const u = new URL(url)
    // URL gives "null" as the origin of chrome-extension:// and file:// pages; keep them apart.
    return u.origin !== 'null' ? u.origin : `${u.protocol}//${u.host}`
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

function iconFor(permission: string, details: Electron.PermissionRequest | Electron.MediaAccessPermissionRequest): PromptSpec['icon'] {
  if (permission === 'media') return ((details as Electron.MediaAccessPermissionRequest).mediaTypes ?? []).includes('video') ? 'camera' : 'mic'
  return ({ geolocation: 'location', notifications: 'bell', 'clipboard-read': 'clipboard', 'display-capture': 'screen' } as Record<string, PromptSpec['icon']>)[permission] ?? 'lock'
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
    if (permission === 'openExternal') {
      // Links to other apps. Magnet links can go to Deluge (torrents.ts); the rest stay blocked.
      const url = (details as Electron.OpenExternalPermissionRequest).externalURL ?? ''
      const w = wc ? (browser.findTabByWebContents(wc)?.window ?? browser.fromWebContents(wc)) : undefined
      if (browser.torrents.handleExternal(url, w ?? browser.lastFocused ?? undefined, details.isMainFrame)) return callback(false)
      return callback(isExtension(origin))
    }
    if (ALWAYS_ALLOW.has(permission) || (isExtension(origin) && !ASK_EXTENSIONS_TOO.has(permission))) return callback(true)
    if (!(permission in ASK)) return callback(false)

    const key = `${origin}|${permission}`
    const remembered = decisions.get(key)
    if (remembered !== undefined) return callback(remembered)

    const what = permission === 'media' ? describeMedia(details) : ASK[permission]
    const host = isExtension(origin)
      ? (ses.extensions.getExtension(new URL(origin).host)?.name ?? 'An extension')
      : origin.startsWith('file:')
        ? 'A file on this computer'
        : new URL(origin).host || origin
    // Requests from extension pages don't always say which tab they came from: ask in the current window.
    const controller = (wc ? browser.fromWebContents(wc) ?? browser.findTabByWebContents(wc)?.window : undefined) ?? browser.lastFocused ?? undefined
    let response: number
    if (controller) {
      // Zirtola's own prompt, under the address bar of the tab's window.
      response = await controller.popup.prompt({
        kind: 'permission',
        icon: iconFor(permission, details),
        title: host,
        message: `wants to ${what}`,
        buttons: ['Allow', 'Block'],
        defaultId: 0,
        cancelId: 2,
      })
    } else {
      const win = wc ? BrowserWindow.fromWebContents(wc) ?? undefined : undefined
      const options: Electron.MessageBoxOptions = { type: 'question', buttons: ['Allow', 'Block'], defaultId: 1, cancelId: 1, message: `${host} wants to ${what}.` }
      response = (win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)).response
    }
    // Dismissing the prompt (Esc / clicking away) blocks this time without remembering.
    const allowed = response === 0
    if (response === 0 || response === 1) decisions.set(key, allowed)
    callback(allowed)
  })

  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    const origin = originOf(requestingOrigin)
    if (ALWAYS_ALLOW.has(permission) || (isExtension(origin) && !ASK_EXTENSIONS_TOO.has(permission))) return true
    const remembered = decisions.get(`${origin}|${permission}`)
    if (remembered !== undefined) return remembered
    return !(permission in ASK) && !DEVICE_ACCESS.has(permission)
  })
}
