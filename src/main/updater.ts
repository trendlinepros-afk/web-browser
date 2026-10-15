import { app, BrowserWindow, dialog } from 'electron'
import type { AppUpdater } from 'electron-updater'
import type { PromptSpec } from '../shared/types'
import { APP_NAME } from './brand'

/**
 * Updates come from GitHub Releases of this (public) repo. See electron-builder.yml `publish`.
 *
 * - Interactive check ("Check for updates…"): tells you the result either way, asks before downloading.
 * - Background check (on startup, then every few hours): silent unless there is a new version, then
 *   asks once per version "Update now / Later". Update now downloads and restarts; Later downloads
 *   in the background and installs on the next quit.
 */
let busy = false
let downloadedVersion: string | null = null
/** A version the background check already told the user about, so it isn't announced again. */
let announcedVersion: string | null = null

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
  // Already downloaded: it installs on quit; only a check the user asked for brings the question back.
  if (downloadedVersion) return interactive ? offerRestart(downloadedVersion) : undefined
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

    if (!interactive) {
      if (announcedVersion === info.version) return
      announcedVersion = info.version
      const choice = await message({
        type: 'info',
        buttons: ['Update now', 'Later'],
        defaultId: 0,
        cancelId: 1,
        title: 'Update available',
        message: `${APP_NAME} ${info.version} is available (you have ${app.getVersion()}).`,
        detail: 'Update now downloads it and restarts the browser; your tabs are restored. Later installs it the next time you close the browser.',
      })
      if (choice !== 0) return void download(autoUpdater, info.version).catch((err) => console.warn('Background update download failed:', err))
      interactive = true // from here on, failures are shown
      await download(autoUpdater, info.version)
      setImmediate(() => autoUpdater.quitAndInstall())
      return
    }

    {
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

    await download(autoUpdater, info.version)
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

/** Downloads the update, showing progress on the taskbar button. */
async function download(autoUpdater: AppUpdater, version: string): Promise<void> {
  const onProgress = (p: { percent: number }) => setProgress(p.percent / 100)
  autoUpdater.on('download-progress', onProgress)
  try {
    await autoUpdater.downloadUpdate()
  } finally {
    autoUpdater.off('download-progress', onProgress)
    setProgress(-1)
  }
  downloadedVersion = version
}

/** Checks on startup and then every few hours while the browser stays open. */
export function startBackgroundUpdateChecks(enabled: () => boolean): void {
  const run = () => {
    if (enabled()) checkForUpdates({ interactive: false }).catch(() => {})
  }
  setTimeout(run, 10_000)
  setInterval(run, 4 * 60 * 60 * 1000).unref()
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim()
}
