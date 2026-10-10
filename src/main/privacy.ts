import { app, ipcMain, type Session } from 'electron'
import path from 'node:path'
import type { AdBlocker } from './blocker'
import { getSettings } from './settings'

/**
 * Chromium features that only exist to serve Google's ad business ("Privacy Sandbox": interest-based
 * ads, on-device ad auctions, cross-site ad measurement). Chrome ships them on; we turn them off.
 */
const DISABLED_FEATURES = [
  // Casting / Media Router: unused, costs memory and background work.
  'MediaRouter',
  'DialMediaRouteProvider',
  // Privacy Sandbox ad APIs.
  'BrowsingTopics',
  'BrowsingTopicsXHR',
  'InterestGroupStorage',
  'AdInterestGroupAPI',
  'Fledge',
  'FencedFrames',
  'SharedStorageAPI',
  'PrivateAggregationApi',
  'AttributionReportingCrossAppWeb',
  'ConversionMeasurement',
  'PrivacySandboxAdsAPIsOverride',
]
const DISABLED_BLINK_FEATURES = ['BrowsingTopics', 'AttributionReporting', 'SharedStorageAPI', 'FencedFrames', 'AdInterestGroupAPI', 'Fledge']

/** Process-wide switches. Must run before the app is ready. */
export function applyCommandLineHardening(): void {
  app.commandLine.appendSwitch('disable-features', DISABLED_FEATURES.join(','))
  app.commandLine.appendSwitch('disable-blink-features', DISABLED_BLINK_FEATURES.join(','))
  // Tabs on the same site share one renderer process instead of one each (Chrome's default
  // spawns a process per tab). Different sites stay isolated from each other.
  app.commandLine.appendSwitch('process-per-site')
}

/** Brands reported to pages, matching what a stock Chromium build sends. */
export function uaBrands(): { brand: string; version: string }[] {
  const major = process.versions.chrome.split('.')[0]
  return [
    { brand: 'Chromium', version: major },
    { brand: 'Not.A/Brand', version: '99' },
  ]
}

function secChUa(): string {
  return uaBrands()
    .map((b) => `"${b.brand}";v="${b.version}"`)
    .join(', ')
}

function secChPlatform(): string {
  return process.platform === 'win32' ? '"Windows"' : process.platform === 'darwin' ? '"macOS"' : '"Linux"'
}

function isPotentiallyTrustworthy(url: string): boolean {
  return url.startsWith('https:') || url.startsWith('wss:') || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url)
}

let ipcRegistered = false

/**
 * Wires every network hook for a browsing session. Electron allows a single listener per
 * webRequest event per session, so this is the one place that owns them.
 */
export function configureNetwork(ses: Session, blocker: AdBlocker): void {
  if (!ipcRegistered) {
    ipcRegistered = true
    // Read synchronously by the page preload before any page script runs.
    ipcMain.on('privacy:config', (event) => {
      event.returnValue = {
        brands: uaBrands(),
        fullVersion: process.versions.chrome,
        gpc: getSettings().privacy.globalPrivacyControl,
      }
    })
  }

  ses.registerPreloadScript({ id: 'privacy', type: 'frame', filePath: path.join(__dirname, '..', 'preload', 'page-preload.js') })
  blocker.enableInSession(ses)

  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    callback(blocker.onBeforeRequest(details))
  })

  ses.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
    const headers = details.requestHeaders
    if (getSettings().privacy.globalPrivacyControl) headers['Sec-GPC'] = '1'
    // Client hints, like Chromium sends them (secure contexts only). Electron omits them,
    // which makes this browser stand out and confuses sites that check for Chromium.
    if (isPotentiallyTrustworthy(details.url) && !('sec-ch-ua' in headers) && !('Sec-CH-UA' in headers)) {
      headers['sec-ch-ua'] = secChUa()
      headers['sec-ch-ua-mobile'] = '?0'
      headers['sec-ch-ua-platform'] = secChPlatform()
    }
    callback({ requestHeaders: headers })
  })

  ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, callback) => {
    callback(blocker.onHeadersReceived(details))
  })
}
