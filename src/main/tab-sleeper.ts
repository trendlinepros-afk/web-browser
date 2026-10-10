import type { Browser } from './browser'
import type { Tab } from './tab'
import { getSettings } from './settings'

const CHECK_INTERVAL_MS = 15_000
/** Under memory pressure, only sleep tabs that have been hidden at least this long. */
const PRESSURE_MIN_HIDDEN_MS = 2 * 60_000

/**
 * Frees memory by putting hidden tabs to sleep (destroying their renderer process):
 *  1. Time-based: tabs hidden longer than `discardAfterMinutes`.
 *  2. Memory pressure: when free system RAM is below `memoryPressureFreeMB`, the
 *     least-recently-used tab is slept each check until pressure is gone.
 */
export class TabSleeper {
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly browser: Browser) {}

  start(): void {
    this.timer = setInterval(() => this.check(), CHECK_INTERVAL_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  check(): void {
    const settings = getSettings()
    const now = Date.now()
    const candidates = this.browser
      .allTabs()
      .filter((t) => t.canDiscard({ sleepPinned: settings.sleepPinnedTabs }))
      .sort((a, b) => a.lastActiveAt - b.lastActiveAt)

    if (settings.discardAfterMinutes > 0) {
      const cutoff = now - settings.discardAfterMinutes * 60_000
      for (const tab of candidates) {
        if (tab.lastActiveAt < cutoff) tab.discard()
      }
    }

    if (settings.memoryPressureFreeMB > 0 && freeMemoryMB() < settings.memoryPressureFreeMB) {
      const victim = candidates.find((t: Tab) => !t.sleeping && now - t.lastActiveAt > PRESSURE_MIN_HIDDEN_MS)
      victim?.discard()
    }
  }
}

function freeMemoryMB(): number {
  // Electron reports KB. "free" is the OS's available memory, including reclaimable cache on Linux/Windows.
  return process.getSystemMemoryInfo().free / 1024
}
