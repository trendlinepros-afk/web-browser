import { app, BrowserWindow, dialog } from 'electron'
import type { AppUpdater } from 'electron-updater'
import type { PromptSpec } from '../shared/types'
import { APP_NAME } from './brand'

/**
 * Updates come from GitHub Releases of this (public) repo. See electron-builder.yml `publish`.
 *
 * - Interactive check ("Check for updates…"): tells you the result either way, asks before downloading.
 * - Background check (on startup): downloads silently, then offers "Restart now / Later".
 *   Choosing Later installs on the next quit.
 */
let busy = false
let downloadedVersion: string | null = null

let updater: AppUpdater | null = null
/** The "Restart now / Later" question while it's on screen, so it's never asked twice at once. */
let restartOffer: Promise<void> | null = null

/** Shows a Zirtola-styled prompt in the current browser window (set up by main.ts). */
let promptHost: (() => ((spec: PromptSpec) => Promise<number>) | null) | null = null
export function setUpdatePromptHost(host: () => ((spec: PromptSpec) => Promise<number>) | null): void {
  promptHost = host
}

/** Loaded on first use so the updater stays out of startup. */
function getUpdater(): AppUpdater {
  if (!updater) {
    updater = (require('electron-updater') as typeof import('electron-updater')).autoUpdater
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = true
  }
  return updater
}

function parent(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
}

async function message(opts: Electron.MessageBoxOptions): Promise<number> {
  const prompt = promptHost?.()
  if (prompt) {
    const buttons = opts.buttons ?? ['OK']
    return prompt({
      kind: opts.type === 'error' || opts.type === 'warning' ? 'warning' : 'info',
      title: opts.message,
      message: opts.detail ?? '',
      buttons,
      defaultId: opts.defaultId ?? 0,
      cancelId: opts.cancelId ?? buttons.length - 1,
    })
  }
  const win = parent()
  const result = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
  return result.response
}

function setProgress(fraction: number): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.setProgressBar(fraction)
}

function offerRestart(version: string): Promise<void> {
  restartOffer ??= askToRestart(version).finally(() => (restartOffer = null))
  return restartOffer
}

async function askToRestart(version: string): Promise<void> {
  const choice = await message({
    type: 'info',
    buttons: ['Restart now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    title: 'Update ready',
    message: `Version ${version} is ready to install.`,
    detail: 'Restart the browser to finish updating. Your tabs will be restored.',
  })
  if (choice === 0) {
    setImmediate(() => getUpdater().quitAndInstall())
  }
}

export async function checkForUpdates({ interactive }: { interactive: boolean }): Promise<void> {
  if (!app.isPackaged) {
    if (interactive) {
      await message({
        type: 'info',
        message: 'Updates are only available in installed builds.',
        detail: `You're running a development build (v${app.getVersion()}). Use \`git pull && npm start\` to update it.`,
      })
    }
    return
  }
  if (downloadedVersion) return offerRestart(downloadedVersion)
  if (busy) {
    if (interactive) await message({ type: 'info', message: 'An update check is already in progress.' })
    return
  }

  busy = true
  const autoUpdater = getUpdater()
  try {
    const result = await autoUpdater.checkForUpdates()
    const info = result?.updateInfo
    const available = !!info && !!result?.isUpdateAvailable

    if (!available) {
      if (interactive) {
        await message({
          type: 'info',
          title: 'No updates',
          message: "You're up to date.",
          detail: `${APP_NAME} ${app.getVersion()} is the latest version.`,
        })
      }
      return
    }

    if (interactive) {
      const choice = await message({
        type: 'info',
        buttons: ['Download', 'Not now'],
        defaultId: 0,
        cancelId: 1,
        title: 'Update available',
        message: `Version ${info.version} is available (you have ${app.getVersion()}).`,
        detail: typeof info.releaseNotes === 'string' ? stripHtml(info.releaseNotes).slice(0, 800) : undefined,
      })
      if (choice !== 0) return
    }

    const onProgress = (p: { percent: number }) => setProgress(p.percent / 100)
    autoUpdater.on('download-progress', onProgress)
    try {
      await autoUpdater.downloadUpdate()
    } finally {
      autoUpdater.off('download-progress', onProgress)
      setProgress(-1)
    }
    downloadedVersion = info.version
    await offerRestart(info.version)
  } catch (err) {
    if (interactive) {
      await message({
        type: 'error',
        title: 'Update failed',
        message: "Couldn't check for updates.",
        detail: err instanceof Error ? err.message : String(err),
      })
    } else {
      console.warn('Background update check failed:', err)
    }
  } finally {
    busy = false
  }
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim()
}
