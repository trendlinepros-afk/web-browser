import { app } from 'electron'
import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Finding and running the Claude Code CLI (`claude`) installed on this computer. Apps started from
 * the Start menu or Dock often don't get the terminal's PATH, so the usual install locations are
 * checked too, including the copy the Claude desktop app keeps for its Code tab.
 */

let cached: string | null | undefined

function newestIn(dir: string, exe: string): string | null {
  try {
    const found = fs
      .readdirSync(dir)
      .map((v) => path.join(dir, v, exe))
      .filter((p) => fs.existsSync(p))
      .map((p) => ({ p, t: fs.statSync(p).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    return found[0]?.p ?? null
  } catch {
    return null
  }
}

function onPath(): string | null {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['claude'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
    const lines = out.split(/\r?\n/).filter(Boolean)
    // On Windows prefer the real executable over npm's shell shims.
    return lines.find((l) => /\.exe$/i.test(l)) ?? lines.find((l) => /\.cmd$/i.test(l)) ?? lines[0] ?? null
  } catch {
    return null
  }
}

export function findClaude(): string | null {
  if (cached !== undefined && (cached === null || fs.existsSync(cached))) return cached
  const home = os.homedir()
  const appData = app.getPath('appData')
  const win = process.platform === 'win32'
  const candidates = win
    ? [
        path.join(home, '.local', 'bin', 'claude.exe'),
        path.join(appData, 'npm', 'claude.cmd'),
        newestIn(path.join(appData, 'Claude', 'claude-code'), 'claude.exe'),
      ]
    : [
        path.join(home, '.local', 'bin', 'claude'),
        '/opt/homebrew/bin/claude',
        '/usr/local/bin/claude',
        path.join(home, '.npm-global', 'bin', 'claude'),
        newestIn(path.join(appData, 'Claude', 'claude-code'), 'claude'),
      ]
  cached = onPath() ?? candidates.find((p): p is string => !!p && fs.existsSync(p)) ?? null
  return cached
}

/** Spawns `claude` with these arguments. npm's claude.cmd shim on Windows needs cmd.exe. */
export function spawnClaude(args: string[], opts: SpawnOptions = {}): ChildProcess {
  const bin = findClaude()
  if (!bin) throw new Error('Claude Code is not installed.')
  if (process.platform === 'win32' && /\.cmd$/i.test(bin)) {
    const line = [bin, ...args].map((a) => `"${a.replace(/"/g, '""')}"`).join(' ')
    return spawn('cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...opts, windowsVerbatimArguments: true, windowsHide: true })
  }
  return spawn(bin, args, { ...opts, windowsHide: true })
}

/** Runs `claude` to completion; rejects with its error output on failure. */
export function runClaude(args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawnClaude(args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      return reject(err)
    }
    let out = ''
    let errText = ''
    child.stdout?.on('data', (d) => (out += d))
    child.stderr?.on('data', (d) => (errText += d))
    const timer = setTimeout(() => killTree(child), timeoutMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error(errText.trim().split('\n')[0] || `claude exited with code ${code}`))
    })
  })
}

/** Stops a claude process and anything it started (cmd.exe shims don't pass on a kill). */
export function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || !child.pid) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  } else {
    child.kill()
  }
}
