// Runs in extension service workers (MV3 background scripts) before the extension's own code.
// Fills in chrome.* APIs that Electron exposes but doesn't implement, backed by Zirtola's main
// process:
//  - chrome.alarms: Electron's alarms never fire. Ours are scheduled in the main process, which
//    wakes the worker when one is due (Chrome suspends idle workers after ~30s).
//  - chrome.identity: launchWebAuthFlow / getRedirectURL for extension sign-in (SSO) flows.
//  - chrome.omnibox: missing entirely, so extensions that declare an address-bar keyword (LastPass's
//    "lp") crashed on startup. Zirtola's address bar delivers "<keyword> <text>" to them.
// Must be registered before electron-chrome-extensions' preload, which freezes `chrome`.
const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron')

// The preload realm has no `location`; ask the worker itself. Website service workers in the
// same session are left alone.
const isExtensionWorker =
  process.type === 'service-worker' &&
  contextBridge.executeInMainWorld({ func: () => globalThis.location?.protocol === 'chrome-extension:' }) === true

if (isExtensionWorker) {
  contextBridge.exposeInMainWorld('__zirtolaExt', {
    alarms: (op: string, ...args: unknown[]) => ipcRenderer.invoke('zirtola-ext', 'alarms', op, ...args),
    identity: (op: string, ...args: unknown[]) => ipcRenderer.invoke('zirtola-ext', 'identity', op, ...args),
  })

  contextBridge.executeInMainWorld({
    func: () => {
      type Bridge = {
        alarms: (op: string, ...args: unknown[]) => Promise<unknown>
        identity: (op: string, ...args: unknown[]) => Promise<unknown>
      }
      const g = globalThis as unknown as {
        __zirtolaExt?: Bridge
        chrome?: Record<string, unknown>
        __zirtolaFireAlarm?: (a: unknown) => void
        __zirtolaFireOmnibox?: (name: string, args: unknown[]) => void
      }
      const bridge = g.__zirtolaExt
      delete g.__zirtolaExt
      const chrome = g.chrome
      if (!bridge || !chrome) return

      // Diagnostics: once the extension's own script has started, record which chrome.* APIs it
      // actually got (electron-chrome-extensions' preload adds windows, tabs, action, …).
      setTimeout(() => {
        const c = g.chrome ?? {}
        const names = ['runtime', 'tabs', 'windows', 'action', 'contextMenus', 'storage', 'alarms', 'omnibox', 'webRequest', 'offscreen']
        console.info(
          `[zirtola] APIs: ${names.map((n) => `${n}=${c[n] ? Object.keys(c[n] as object).length : 'MISSING'}`).join(' ')}; frozen=${Object.isFrozen(c)}`,
        )
      }, 0)

      // Chrome APIs return a promise, or call a trailing callback when given one.
      const withCallback = (args: unknown[], promise: Promise<unknown>) => {
        const cb = typeof args[args.length - 1] === 'function' ? (args[args.length - 1] as (v: unknown) => void) : null
        if (!cb) return promise
        promise.then(cb, (err) => {
          console.error(err)
          cb(undefined)
        })
        return undefined
      }
      const makeEvent = <T extends (...a: never[]) => unknown>() => {
        const listeners = new Set<T>()
        return {
          listeners,
          event: {
            addListener: (f: T) => void listeners.add(f),
            removeListener: (f: T) => void listeners.delete(f),
            hasListener: (f: T) => listeners.has(f),
            hasListeners: () => listeners.size > 0,
          },
        }
      }

      const onAlarm = makeEvent<(alarm: unknown) => void>()
      const alarms = {
        create(...args: unknown[]) {
          const name = typeof args[0] === 'string' ? args[0] : ''
          const info = (typeof args[0] === 'string' ? args[1] : args[0]) ?? {}
          return withCallback(args, bridge.alarms('create', name, info))
        },
        get(...args: unknown[]) {
          return withCallback(args, bridge.alarms('get', typeof args[0] === 'string' ? args[0] : ''))
        },
        getAll(...args: unknown[]) {
          return withCallback(args, bridge.alarms('getAll'))
        },
        clear(...args: unknown[]) {
          return withCallback(args, bridge.alarms('clear', typeof args[0] === 'string' ? args[0] : ''))
        },
        clearAll(...args: unknown[]) {
          return withCallback(args, bridge.alarms('clearAll'))
        },
        onAlarm: onAlarm.event,
      }
      g.__zirtolaFireAlarm = (alarm: unknown) => {
        for (const f of onAlarm.listeners) {
          try {
            f(alarm)
          } catch (err) {
            console.error(err)
          }
        }
      }

      const identity = {
        getRedirectURL(path = '') {
          return `https://${(chrome.runtime as { id: string }).id}.chromiumapp.org/${String(path).replace(/^\//, '')}`
        },
        launchWebAuthFlow(...args: unknown[]) {
          return withCallback(args, bridge.identity('launchWebAuthFlow', args[0]))
        },
        getAuthToken(...args: unknown[]) {
          return withCallback(args, Promise.reject(new Error('getAuthToken is not supported in Zirtola; use launchWebAuthFlow.')))
        },
        clearAllCachedAuthTokens(...args: unknown[]) {
          return withCallback(args, Promise.resolve())
        },
        getProfileUserInfo(...args: unknown[]) {
          return withCallback(args, Promise.resolve({ email: '', id: '' }))
        },
        onSignInChanged: makeEvent<() => void>().event,
      }

      // Zirtola has no side panel yet. Extensions that configure one at startup get a harmless
      // stand-in instead of crashing on `chrome.sidePanel` being undefined.
      const sidePanel = {
        setOptions: (...args: unknown[]) => withCallback(args, Promise.resolve()),
        getOptions: (...args: unknown[]) => withCallback(args, Promise.resolve({ enabled: false })),
        setPanelBehavior: (...args: unknown[]) => withCallback(args, Promise.resolve()),
        getPanelBehavior: (...args: unknown[]) => withCallback(args, Promise.resolve({ openPanelOnActionClick: false })),
        open: (...args: unknown[]) => withCallback(args, Promise.reject(new Error('Side panels are not supported in Zirtola.'))),
        onOpened: makeEvent<() => void>().event,
        onClosed: makeEvent<() => void>().event,
      }

      const omniboxEvents = {
        onInputStarted: makeEvent<(...a: unknown[]) => void>(),
        onInputChanged: makeEvent<(...a: unknown[]) => void>(),
        onInputEntered: makeEvent<(...a: unknown[]) => void>(),
        onInputCancelled: makeEvent<(...a: unknown[]) => void>(),
        onDeleteSuggestion: makeEvent<(...a: unknown[]) => void>(),
      }
      const omnibox = {
        setDefaultSuggestion: (...args: unknown[]) => withCallback(args.slice(1), Promise.resolve()),
        ...Object.fromEntries(Object.entries(omniboxEvents).map(([k, v]) => [k, v.event])),
      }
      g.__zirtolaFireOmnibox = (name: string, args: unknown[]) => {
        const listeners = omniboxEvents[name as keyof typeof omniboxEvents]?.listeners ?? []
        for (const f of listeners) {
          try {
            ;(f as (...a: unknown[]) => void)(...args)
          } catch (err) {
            console.error(err)
          }
        }
      }

      try {
        Object.defineProperty(chrome, 'alarms', { value: alarms, configurable: true, enumerable: true })
        if (!('omnibox' in chrome)) Object.defineProperty(chrome, 'omnibox', { value: omnibox, configurable: true, enumerable: true })
        Object.defineProperty(chrome, 'identity', { value: identity, configurable: true, enumerable: true })
        if (!('sidePanel' in chrome)) Object.defineProperty(chrome, 'sidePanel', { value: sidePanel, configurable: true, enumerable: true })
      } catch (err) {
        console.error('Zirtola extension APIs failed to install', err)
      }
    },
  })

  ipcRenderer.on('zirtola-omnibox', (_e, name: string, args: unknown[]) => {
    contextBridge.executeInMainWorld({
      func: (n: string, a: unknown[]) => (globalThis as unknown as { __zirtolaFireOmnibox?: (n: string, a: unknown[]) => void }).__zirtolaFireOmnibox?.(n, a),
      args: [name, args],
    })
  })

  ipcRenderer.on('zirtola-alarm', (_e, alarm: unknown) => {
    contextBridge.executeInMainWorld({
      func: (a: unknown) => (globalThis as unknown as { __zirtolaFireAlarm?: (a: unknown) => void }).__zirtolaFireAlarm?.(a),
      args: [alarm],
    })
  })
}
