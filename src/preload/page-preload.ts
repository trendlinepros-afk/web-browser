// Runs in every web page frame (main frame and iframes) before its scripts. Sandboxed: no imports.
//
// Makes Zirtola look like the Chromium browser it is, so sites' bot checks (Google's "unusual
// traffic" page, Cloudflare, reCAPTCHA) don't misfire:
//  - window.chrome gets the standard app/csi/loadTimes members every Chrome page has
//  - permissions you haven't decided yet read as "prompt" (Electron can only say granted/denied)
// It also exposes the Global Privacy Control signal, and once per Chromium version reports the
// renderer's own userAgentData so request headers can match it exactly.
const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron')

interface PageConfig {
  gpc: boolean
  /** Same list as the Accept-Language header. */
  languages: string[]
  undecidedPermissions: string[]
  reportUaData: boolean
}

if (location.protocol === 'http:' || location.protocol === 'https:') {
  const config = ipcRenderer.sendSync('privacy:config', location.origin) as PageConfig

  if (config.reportUaData && window === window.top) {
    const uaData = (navigator as unknown as { userAgentData?: { getHighEntropyValues(h: string[]): Promise<Record<string, unknown>> } }).userAgentData
    uaData
      ?.getHighEntropyValues(['architecture', 'bitness', 'model', 'platformVersion', 'fullVersionList', 'wow64', 'formFactors'])
      .then((values) => ipcRenderer.send('privacy:ua-data', values))
      .catch(() => {})
  }

  contextBridge.executeInMainWorld({
    func: (cfg: PageConfig) => {
      // Native-looking functions: bot checks often inspect Function.prototype.toString().
      const nativeToString = Function.prototype.toString
      const disguised = new WeakSet<object>()
      const disguise = <T extends object>(fn: T, name?: string): T => {
        if (name) Object.defineProperty(fn, 'name', { value: name })
        disguised.add(fn)
        return fn
      }
      try {
        Function.prototype.toString = disguise(function toString(this: object) {
          if (disguised.has(this)) return `function ${(this as { name?: string }).name ?? ''}() { [native code] }`
          return nativeToString.call(this)
        })
      } catch {
        // Ignore.
      }

      try {
        if (cfg.gpc && !('globalPrivacyControl' in Navigator.prototype)) {
          Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', {
            get: disguise(function () {
              return true
            }, 'get globalPrivacyControl'),
            configurable: true,
            enumerable: true,
          })
        }
      } catch {
        // Ignore.
      }

      try {
        // Keep navigator.languages in step with the Accept-Language header.
        const languages = Object.freeze([...cfg.languages])
        if (languages.length && navigator.languages.join() !== languages.join()) {
          Object.defineProperty(Navigator.prototype, 'languages', {
            get: disguise(function () {
              return languages
            }, 'get languages'),
            configurable: true,
            enumerable: true,
          })
        }
      } catch {
        // Ignore.
      }

      try {
        const w = window as unknown as { chrome?: Record<string, unknown> }
        if (!w.chrome) w.chrome = {}
        const chrome = w.chrome
        const timing = performance.timing
        const nav = () => performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
        if (!('app' in chrome)) {
          chrome.app = {
            isInstalled: false,
            InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
            RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
            getDetails: disguise(function getDetails() {
              return null
            }),
            getIsInstalled: disguise(function getIsInstalled() {
              return false
            }),
            runningState: disguise(function runningState() {
              return 'cannot_run'
            }),
          }
        }
        if (!('csi' in chrome)) {
          chrome.csi = disguise(function csi() {
            return { onloadT: timing.loadEventEnd || Date.now(), pageT: performance.now(), startE: timing.navigationStart, tran: 15 }
          })
        }
        if (!('loadTimes' in chrome)) {
          chrome.loadTimes = disguise(function loadTimes() {
            const protocol = nav()?.nextHopProtocol || 'http/1.1'
            const multiplexed = protocol === 'h2' || protocol === 'h3'
            const paint = performance.getEntriesByName('first-paint')[0]
            return {
              commitLoadTime: timing.responseStart / 1000,
              connectionInfo: protocol,
              finishDocumentLoadTime: timing.domContentLoadedEventEnd / 1000,
              finishLoadTime: timing.loadEventEnd / 1000,
              firstPaintAfterLoadTime: 0,
              firstPaintTime: paint ? (timing.navigationStart + paint.startTime) / 1000 : 0,
              navigationType: 'Other',
              npnNegotiatedProtocol: multiplexed ? protocol : 'unknown',
              requestTime: timing.navigationStart / 1000,
              startLoadTime: timing.navigationStart / 1000,
              wasAlternateProtocolAvailable: false,
              wasFetchedViaSpdy: multiplexed,
              wasNpnNegotiated: multiplexed,
            }
          })
        }
      } catch {
        // Ignore.
      }

      try {
        const undecided = new Set(cfg.undecidedPermissions)
        if (undecided.has('notifications') && typeof Notification !== 'undefined') {
          const real = Object.getOwnPropertyDescriptor(Notification, 'permission')?.get
          Object.defineProperty(Notification, 'permission', {
            get: disguise(function () {
              const value = real ? real.call(Notification) : 'default'
              return value === 'denied' ? 'default' : value
            }, 'get permission'),
            configurable: true,
            enumerable: true,
          })
        }
        const perms = navigator.permissions
        if (perms) {
          const query = perms.query.bind(perms)
          const PermissionsProto = Object.getPrototypeOf(perms) as { query: Permissions['query'] }
          PermissionsProto.query = disguise(function (this: Permissions, descriptor: PermissionDescriptor) {
            return query(descriptor).then((status) => {
              if (status.state !== 'denied' || !undecided.has(descriptor?.name)) return status
              return new Proxy(status, {
                get(target, prop) {
                  if (prop === 'state') return 'prompt'
                  const value = Reflect.get(target, prop, target)
                  return typeof value === 'function' ? value.bind(target) : value
                },
              })
            })
          }, 'query') as Permissions['query']
        }
      } catch {
        // Ignore.
      }
    },
    args: [config],
  })
}
