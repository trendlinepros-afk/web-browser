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
/** Closes the tab or pop-up window showing this page, if a page opened it (set by browser.ts). */
let closeSelf: ((wc: Electron.WebContents) => void) | null = null
export function setCloseSelfHandler(handler: (wc: Electron.WebContents) => void): void {
  closeSelf = handler
}
const LOCAL_READS = new Set(['xhr', 'subFrame', 'object', 'webSocket', 'ping', 'cspReport', 'other'])

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
        undecidedPermissions: undecidedPermissions(event.sender.session, origin),
        reportUaData: needsLearning(),
      }
    })
    ipcMain.on('page:close-self', (event) => {
      if (event.senderFrame !== event.sender.mainFrame) return
      closeSelf?.(event.sender)
    })
    ipcMain.on('privacy:ua-data', (event, values: Record<string, unknown>) => {
      // Only from a web page's own top frame (the preload only sends from there).
      if (event.senderFrame !== event.sender.mainFrame || !/^https?:/.test(event.sender.getURL())) return
      if (needsLearning() && values && typeof values === 'object') learnFromRenderer(values)
    })
  }

  ses.setUserAgent(ses.getUserAgent(), acceptLanguages())
  ses.registerPreloadScript({ id: 'privacy', type: 'frame', filePath: path.join(__dirname, '..', 'preload', 'page-preload.js') })
  blocker.enableInSession(ses)

  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    // Electron lets file:// pages read other files with fetch/XHR or a same-origin iframe (Chrome
    // doesn't), so a downloaded .html file could read your documents and send them anywhere.
    // Opening a local file as a page, and its images, scripts and styles, still work.
    if (details.url.startsWith('file:') && LOCAL_READS.has(details.resourceType)) return callback({ cancel: true })
    callback(blocker.onBeforeRequest(details))
  })

  ses.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
    const hints: Record<string, string> = {}
    try {
      addClientHints(ses, details.url, { ...details.requestHeaders }, hints)
    } catch (err) {
      // Never let a hint bug hold up the request: it would leave every page loading forever.
      console.warn('Client hints failed:', err)
    }
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
