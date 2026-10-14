// Lets Claude Desktop / Claude Code talk to Zirtola's MCP server without Node.js or a token to copy.
// They start it as `Zirtola.exe <this file> <settings.json>` with ELECTRON_RUN_AS_NODE=1, so
// Zirtola's own executable runs it as plain Node. It relays MCP messages between stdio (what those
// apps speak to local servers) and Zirtola's HTTP endpoint, reading the port and token from
// Zirtola's settings on every request, so resetting the token never breaks the connection.
// Must not import electron: it doesn't run inside the browser.
import fs from 'node:fs'
import readline from 'node:readline'

const settingsPath = process.argv[2] ?? ''

interface JsonRpc {
  jsonrpc: '2.0'
  id?: string | number
  method?: string
}

function endpoint(): { url: string; token: string; enabled: boolean } {
  const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as { mcp?: { port?: number; token?: string; enabled?: boolean } }
  return { url: `http://127.0.0.1:${s.mcp?.port ?? 47823}/mcp`, token: s.mcp?.token ?? '', enabled: !!s.mcp?.enabled }
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function fail(request: JsonRpc, message: string): void {
  if (request.id !== undefined) send({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message } })
}

const NOT_RUNNING = 'Zirtola is not running, or "Let Claude control Zirtola" is turned off. Open Zirtola, turn it on in Settings → Claude, and try again.'

async function forward(line: string): Promise<void> {
  let request: JsonRpc
  try {
    request = JSON.parse(line) as JsonRpc
  } catch {
    return
  }
  let target: ReturnType<typeof endpoint>
  try {
    target = endpoint()
  } catch {
    return fail(request, `Can't read Zirtola's settings (${settingsPath}). Click "Connect" in Zirtola's Settings → Claude again.`)
  }
  if (!target.enabled) return fail(request, NOT_RUNNING)

  let response: Response
  try {
    response = await fetch(target.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${target.token}`,
      },
      body: line,
    })
  } catch {
    return fail(request, NOT_RUNNING)
  }
  if (response.status === 202) return
  const body = await response.text()
  if (!response.ok && !body.trim().startsWith('{')) return fail(request, `Zirtola answered ${response.status}: ${body.slice(0, 200)}`)

  if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    // Server-sent events: each event's data lines are one JSON-RPC message.
    for (const event of body.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n')
      if (data) send(JSON.parse(data))
    }
  } else if (body.trim()) {
    const parsed = JSON.parse(body) as unknown
    for (const message of Array.isArray(parsed) ? parsed : [parsed]) send(message)
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim()) forward(line).catch((err) => process.stderr.write(`zirtola bridge: ${err instanceof Error ? err.message : String(err)}\n`))
})
