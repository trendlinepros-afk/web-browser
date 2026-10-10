// Runs in every web page's main frame before its scripts (sandboxed preload; no imports allowed).
// Makes navigator.userAgentData match the Chromium user agent we send, and exposes the Global
// Privacy Control signal to scripts when it is enabled.
const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron')

interface PrivacyConfig {
  brands: { brand: string; version: string }[]
  fullVersion: string
  gpc: boolean
}

if (location.protocol === 'http:' || location.protocol === 'https:') {
  const config = ipcRenderer.sendSync('privacy:config') as PrivacyConfig
  contextBridge.executeInMainWorld({
    func: (cfg: PrivacyConfig) => {
      try {
        if (cfg.gpc && !('globalPrivacyControl' in Navigator.prototype)) {
          Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true, configurable: true, enumerable: true })
        }
        const UAData = (globalThis as unknown as { NavigatorUAData?: { prototype: Record<string, unknown> } }).NavigatorUAData
        if (UAData) {
          const proto = UAData.prototype
          const brands = () => cfg.brands.map((b) => ({ ...b }))
          Object.defineProperty(proto, 'brands', { get: brands, configurable: true, enumerable: true })
          const original = proto.getHighEntropyValues as (hints: string[]) => Promise<Record<string, unknown>>
          proto.getHighEntropyValues = function (this: unknown, hints: string[]) {
            return original.call(this, hints).then((values) => ({
              ...values,
              brands: brands(),
              ...(hints.includes('fullVersionList')
                ? { fullVersionList: cfg.brands.map((b) => ({ brand: b.brand, version: b.brand === 'Chromium' ? cfg.fullVersion : `${b.version}.0.0.0` })) }
                : {}),
            }))
          }
        }
      } catch {
        // Never break a page over this.
      }
    },
    args: [config],
  })
}
