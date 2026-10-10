import { app, dialog, shell, type BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import { APP_NAME } from './brand'
import { getSettings, updateSettings } from './settings'

/** Whether Zirtola currently opens https links (Windows: the user's choice in Default apps). */
export function isDefaultBrowser(): Promise<boolean> {
  if (process.platform !== 'win32') return Promise.resolve(app.isDefaultProtocolClient('https'))
  return new Promise((resolve) => {
    execFile(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', '/v', 'ProgId'],
      { windowsHide: true },
      (err, stdout) => resolve(!err && /ZirtolaURL/.test(stdout)),
    )
  })
}

/**
 * Windows 10/11 only let the user change the default browser in Settings, so we open Zirtola's
 * page there. macOS/Linux show their own confirmation when an app asks.
 */
export function makeDefaultBrowser(): void {
  if (process.platform === 'win32') {
    void shell.openExternal(`ms-settings:defaultapps?registeredAppUser=${encodeURIComponent(APP_NAME)}`)
    return
  }
  app.setAsDefaultProtocolClient('http')
  app.setAsDefaultProtocolClient('https')
}

/** Asks once, on the first run of an installed copy, whether to make Zirtola the default browser. */
export async function offerDefaultBrowserOnce(win: BrowserWindow): Promise<void> {
  if (!app.isPackaged || getSettings().askedDefaultBrowser) return
  updateSettings((s) => (s.askedDefaultBrowser = true))
  if (await isDefaultBrowser()) return
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Make default', 'Not now'],
    defaultId: 0,
    cancelId: 1,
    message: `Make ${APP_NAME} your default browser?`,
    detail:
      process.platform === 'win32'
        ? `Windows will open its Default apps settings. Click "Set default" next to ${APP_NAME}.`
        : 'Links from other apps will open here.',
  })
  if (response === 0) makeDefaultBrowser()
}
