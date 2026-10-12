import { nativeTheme, systemPreferences, type BrowserWindowConstructorOptions } from 'electron'

/** Height of the tab strip, which doubles as the title bar. Must match --strip-h in styles.css. */
export const TITLE_BAR_HEIGHT = 40

/** Platform the UI is laid out for (overridable for testing a Windows layout elsewhere). */
export const uiPlatform: NodeJS.Platform = (process.env.ZIRTOLA_UI_PLATFORM as NodeJS.Platform) || process.platform

/** Tabs live in the title bar on Windows and macOS; Linux keeps the window manager's own frame. */
export const integratedTitleBar = uiPlatform === 'win32' || uiPlatform === 'darwin'

function stripColors(incognito: boolean): { color: string; symbolColor: string } {
  // Must match --bg in renderer/theme.css.
  if (incognito) return { color: '#0e0918', symbolColor: '#efe8fb' }
  return nativeTheme.shouldUseDarkColors ? { color: '#0a0d1a', symbolColor: '#e9ebf8' } : { color: '#eceff8', symbolColor: '#161a2e' }
}

/** Frame options: on Windows the native minimize/maximize/close buttons (with Snap Layouts) sit over the tab strip. */
export function frameOptions(incognito: boolean): BrowserWindowConstructorOptions {
  if (uiPlatform === 'win32') {
    return { titleBarStyle: 'hidden', titleBarOverlay: { ...stripColors(incognito), height: TITLE_BAR_HEIGHT } }
  }
  if (uiPlatform === 'darwin') {
    return { titleBarStyle: 'hidden', trafficLightPosition: { x: 14, y: 12 } }
  }
  return {}
}

export function titleBarOverlay(incognito: boolean): Electron.TitleBarOverlayOptions | null {
  return uiPlatform === 'win32' ? { ...stripColors(incognito), height: TITLE_BAR_HEIGHT } : null
}

/** The user's Windows/macOS accent color as #rrggbb, or null to use Zirtola's default blue. */
export function accentColor(): string | null {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return null
  try {
    const hex = systemPreferences.getAccentColor()
    return /^[0-9a-f]{6}/i.test(hex) ? `#${hex.slice(0, 6)}` : null
  } catch {
    return null
  }
}

/** Calls back when light/dark mode or the system accent color changes. */
export function onThemeChanged(cb: () => void): void {
  nativeTheme.on('updated', cb)
  if (process.platform === 'win32') systemPreferences.on('accent-color-changed', cb)
}
