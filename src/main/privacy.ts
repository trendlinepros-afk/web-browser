import { app, ipcMain, type Session } from 'electron'
import path from 'node:path'
import type { AdBlocker } from './blocker'
import { getSettings } from './settings'
import { acceptLanguages, addClientHints, learnFromRenderer, needsLearning, recordAcceptCh } from './client-hints'
import { undecidedPermissions } from './permissions'

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

let ipcRegistered = false

/**
 * Wires every network hook for a browsing session. Electron allows a single listener per
 * webRequest event per session, so this is the one place that owns them.
 */
export function configureNetwork(ses: Session, blocker: AdBlocker): void {
  if (!ipcRegistered) {
    ipcRegistered = true
    // Read synchronously by the page preload in every frame, before any page script runs.
    ipcMain.on('privacy:config', (event, claimed: string) => {
      // The frame's real origin, not the one it claims: a compromised renderer can't ask about other sites.
      const origin = event.senderFrame?.origin ?? claimed
      event.returnValue = {
        gpc: getSettings().privacy.globalPrivacyControl,
        languages: acceptLanguages().split(','),
        undecidedPermissions: undecidedPermissions(origin),
        reportUaData: needsLearning(),
      }
    })
    ipcMain.on('privacy:ua-data', (_event, values: Record<string, unknown>) => {
      if (needsLearning() && values && typeof values === 'object') learnFromRenderer(values)
    })
  }

  ses.setUserAgent(ses.getUserAgent(), acceptLanguages())
  ses.registerPreloadScript({ id: 'privacy', type: 'frame', filePath: path.join(__dirname, '..', 'preload', 'page-preload.js') })
  blocker.enableInSession(ses)

  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    callback(blocker.onBeforeRequest(details))
  })

  ses.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
    const hints: Record<string, string> = {}
    addClientHints(ses, details.url, { ...details.requestHeaders }, hints)
    // Same order as Chrome: client hints come first, before Upgrade-Insecure-Requests / User-Agent.
    // Header order is part of how sites fingerprint browsers.
    const headers: Record<string, string> = { ...hints, ...details.requestHeaders }
    if (getSettings().privacy.globalPrivacyControl) headers['Sec-GPC'] = '1'
    callback({ requestHeaders: headers })
  })

  ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, callback) => {
    if (details.resourceType === 'mainFrame' || details.resourceType === 'subFrame') {
      recordAcceptCh(ses, details.url, details.responseHeaders)
    }
    callback(blocker.onHeadersReceived(details))
  })
}
