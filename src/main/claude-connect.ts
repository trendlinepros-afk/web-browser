import { app } from 'electron'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { flushSettings, getSettings, settingsFile } from './settings'

/**
 * One-click setup so Claude can use Zirtola: registers Zirtola as an MCP server in Claude Desktop
 * and Claude Code. Both start it as Zirtola.exe running mcp-bridge.js, so there's no Node.js to
 * install and no token to paste.
 */

export type ConnectResult = 'connected' | 'not-installed' | { error: string }

const SERVER_NAME = 'zirtola'

function serverEntry(): { command: string; args: string[]; env: Record<string, string> } {
  return {
    command: process.execPath,
    args: [path.join(__dirname, 'mcp-bridge.js'), settingsFile()],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  }
}

/** Claude Desktop reads claude_desktop_config.json from its folder under AppData (or Application Support). */
function connectDesktop(): ConnectResult {
  const dir = path.join(app.getPath('appData'), 'Claude')
  if (!fs.existsSync(dir)) return 'not-installed'
  const file = path.join(dir, 'claude_desktop_config.json')
  let config: { mcpServers?: Record<string, unknown> } & Record<string, unknown> = {}
  try {
    if (fs.existsSync(file)) config = JSON.parse(fs.readFileSync(file, 'utf8') || '{}')
  } catch {
    return { error: `${file} isn't valid JSON, so Zirtola left it alone.` }
  }
  const servers = { ...(config.mcpServers ?? {}) }
  // Drop entries set up by hand earlier (mcp-remote to Zirtola's port); Connect replaces them.
  const port = `127.0.0.1:${getSettings().mcp.port}/mcp`
  for (const [name, entry] of Object.entries(servers)) {
    if (name !== SERVER_NAME && JSON.stringify(entry).includes(port)) delete servers[name]
  }
  config.mcpServers = { ...servers, [SERVER_NAME]: serverEntry() }
  try {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(config, null, 2))
    fs.renameSync(`${file}.tmp`, file)
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
  return 'connected'
}

function runClaude(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('claude', args, { timeout: 30_000, windowsHide: true }, (err) => {
      if (!err) return resolve()
      // An npm-installed Claude Code is claude.cmd on Windows, which needs a shell.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' && process.platform === 'win32') {
        const quoted = args.map((a) => `"${a}"`).join(' ')
        execFile('cmd.exe', ['/d', '/s', '/c', `"claude ${quoted}"`], { timeout: 30_000, windowsHide: true, windowsVerbatimArguments: true }, (err2) =>
          err2 ? reject(err2) : resolve(),
        )
        return
      }
      reject(err)
    })
  })
}

/** Claude Code: `claude mcp add` at user scope, so it works from any folder. */
async function connectCode(): Promise<ConnectResult> {
  const { command, args, env } = serverEntry()
  try {
    await runClaude(['--version'])
  } catch {
    return 'not-installed'
  }
  await runClaude(['mcp', 'remove', SERVER_NAME, '--scope', 'user']).catch(() => {})
  try {
    const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`])
    await runClaude(['mcp', 'add', SERVER_NAME, '--scope', 'user', ...envArgs, '--', command, ...args])
    return 'connected'
  } catch (err) {
    return { error: err instanceof Error ? err.message.split('\n')[0] : String(err) }
  }
}

export async function connectClaude(): Promise<{ desktop: ConnectResult; code: ConnectResult }> {
  // The bridge reads the port and token from disk.
  flushSettings()
  const [desktop, code] = [connectDesktop(), await connectCode()]
  return { desktop, code }
}
