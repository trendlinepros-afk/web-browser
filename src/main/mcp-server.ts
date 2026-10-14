import http from 'node:http'
import crypto from 'node:crypto'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { app } from 'electron'
import type { z } from 'zod'
import type { Browser } from './browser'
import type { Tab } from './tab'
import { getSettings, updateSettings } from './settings'
import { toNavigableURL } from './url'
import * as auto from './automation'

type ToolResult = { content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]; isError?: boolean }

const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] })

/**
 * Built-in MCP server so Claude can drive the browser.
 * Streamable HTTP (stateless) at http://127.0.0.1:<port>/mcp, bearer-token protected, localhost only.
 */
export class BrowserMcpServer {
  private server: http.Server | null = null

  constructor(private readonly browser: Browser) {}

  get running(): boolean {
    return this.server !== null
  }

  static ensureToken(): string {
    const s = getSettings()
    if (!s.mcp.token) updateSettings((x) => (x.mcp.token = crypto.randomBytes(24).toString('base64url')))
    return getSettings().mcp.token
  }

  /**
   * claude_desktop_config.json for Claude Desktop, which only launches local (stdio) servers, so
   * mcp-remote bridges to ours. The token goes through `env`: on Windows, npx can split an argument
   * containing a space ("Authorization: Bearer …").
   */
  static desktopConfig(): string {
    const { port } = getSettings().mcp
    const config = {
      mcpServers: {
        zirtola: {
          command: 'npx',
          args: ['-y', 'mcp-remote', `http://127.0.0.1:${port}/mcp`, '--header', 'Authorization:${AUTH_HEADER}'],
          env: { AUTH_HEADER: `Bearer ${BrowserMcpServer.ensureToken()}` },
        },
      },
    }
    return JSON.stringify(config, null, 2)
  }

  static connectCommand(): string {
    const { port } = getSettings().mcp
    return `claude mcp add --transport http browser http://127.0.0.1:${port}/mcp --header "Authorization: Bearer ${BrowserMcpServer.ensureToken()}"`
  }

  async start(): Promise<void> {
    if (this.server) return
    const { port } = getSettings().mcp
    const token = BrowserMcpServer.ensureToken()
    const server = http.createServer((req, res) => this.handle(req, res, token, port))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => resolve())
    })
    this.server = server
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (server) await new Promise<void>((r) => server.close(() => r()))
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse, token: string, port: number): Promise<void> {
    const deny = (status: number, msg: string) => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: msg }))
    }
    // DNS-rebinding and drive-by protection: only local hosts, no browser-originated requests.
    const host = req.headers.host ?? ''
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return deny(403, 'Forbidden host')
    if (req.headers.origin) return deny(403, 'Browser-originated requests are not allowed')
    const auth = Buffer.from(req.headers.authorization ?? '')
    const expected = Buffer.from(`Bearer ${token}`)
    if (auth.length !== expected.length || !crypto.timingSafeEqual(auth, expected)) return deny(401, 'Unauthorized')
    if (!req.url?.startsWith('/mcp')) return deny(404, 'Not found')
    if (req.method !== 'POST') return deny(405, 'Method not allowed (stateless server: POST only)')

    let body: unknown
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      return deny(400, 'Invalid JSON')
    }

    // The SDK is only loaded once Claude actually connects, keeping it out of normal startup.
    const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js') as typeof import('@modelcontextprotocol/sdk/server/streamableHttp.js')
    const mcp = this.createServer()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      transport.close().catch(() => {})
      mcp.close().catch(() => {})
    })
    try {
      await mcp.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch (err) {
      if (!res.headersSent) deny(500, err instanceof Error ? err.message : String(err))
    }
  }

  // ---- Tools --------------------------------------------------------------

  private visibleTabs(): Tab[] {
    const allowIncognito = getSettings().mcp.allowIncognito
    return this.browser.allTabs().filter((t) => allowIncognito || !t.incognito)
  }

  private tab(id?: number): Tab {
    if (id === undefined) {
      const w = this.browser.lastFocused
      const active = w && (getSettings().mcp.allowIncognito || !w.incognito) ? w.activeTab : null
      const tab = active ?? this.browser.targetWindow().activeTab
      if (!tab) throw new Error('No active tab.')
      return this.touch(tab)
    }
    const tab = this.visibleTabs().find((t) => t.id === id)
    if (!tab) throw new Error(`No tab with id ${id}. Use list_tabs.`)
    return this.touch(tab)
  }

  private touch(tab: Tab): Tab {
    const wasControlled = tab.controlled
    tab.lastControlledAt = Date.now()
    if (!wasControlled) tab.window.pushState()
    return tab
  }

  private createServer(): McpServer {
    const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js') as typeof import('@modelcontextprotocol/sdk/server/mcp.js')
    const { z } = require('zod') as typeof import('zod')
    const mcp = new McpServer({ name: 'zirtola', version: app.getVersion() })
    const tabId = z.number().int().optional().describe('Tab id from list_tabs. Defaults to the active tab.')
    const ref = z.number().int().optional().describe('Element ref from snapshot.')
    const selector = z.string().optional().describe('CSS selector (used when no ref is given).')

    const tool = <S extends z.ZodRawShape>(
      name: string,
      description: string,
      shape: S,
      fn: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResult>,
    ) => {
      mcp.registerTool(name, { description, inputSchema: shape }, (async (args: z.infer<z.ZodObject<S>>) => {
        try {
          return await fn(args)
        } catch (err) {
          return { ...text(`Error: ${err instanceof Error ? err.message : String(err)}`), isError: true }
        }
      }) as never)
    }

    tool('list_tabs', 'List open tabs across all windows.', {}, async () => {
      const lines = this.visibleTabs().map((t) => {
        const flags = [
          t.window.activeTab === t ? 'active' : '',
          t.sleeping ? 'sleeping' : '',
          t.incognito ? 'incognito' : '',
          t.pinned ? 'pinned' : '',
        ].filter(Boolean)
        return `[${t.id}] ${t.title || '(untitled)'} — ${t.url || 'about:blank'}${flags.length ? ` (${flags.join(', ')})` : ''} window=${t.window.id}`
      })
      return text(lines.join('\n') || 'No tabs open.')
    })

    tool(
      'open_tab',
      'Open a new tab and wait for it to load. Returns its tab id.',
      { url: z.string().describe('URL or search terms.'), background: z.boolean().optional() },
      async ({ url, background }) => {
        const target = toNavigableURL(url, getSettings().searchEngine) ?? 'about:blank'
        const tab = this.touch(this.browser.targetWindow().createTab({ background }))
        await auto.navigateAndWait(tab.wake(), target)
        return text(`Opened tab ${tab.id}: ${tab.title} — ${tab.url}`)
      },
    )

    tool('close_tab', 'Close a tab.', { tab_id: z.number().int() }, async ({ tab_id }) => {
      const tab = this.tab(tab_id)
      tab.window.closeTab(tab)
      return text(`Closed tab ${tab_id}.`)
    })

    tool('activate_tab', 'Switch to (show) a tab.', { tab_id: z.number().int() }, async ({ tab_id }) => {
      const tab = this.tab(tab_id)
      tab.window.activateTab(tab)
      tab.window.win.focus()
      return text(`Activated tab ${tab_id}.`)
    })

    tool(
      'navigate',
      'Navigate a tab to a URL (or search terms), or go back/forward/reload. Waits for load.',
      {
        tab_id: tabId,
        url: z.string().optional(),
        action: z.enum(['back', 'forward', 'reload']).optional(),
      },
      async ({ tab_id, url, action }) => {
        const tab = this.tab(tab_id)
        const wc = tab.wake()
        if (url) {
          const target = toNavigableURL(url, getSettings().searchEngine)
          if (!target) throw new Error('Empty URL.')
          await auto.navigateAndWait(wc, target)
        } else if (action === 'back') {
          wc.navigationHistory.goBack()
          await auto.settle(wc)
        } else if (action === 'forward') {
          wc.navigationHistory.goForward()
          await auto.settle(wc)
        } else if (action === 'reload') {
          wc.reload()
          await auto.settle(wc)
        } else {
          throw new Error('Pass url or action.')
        }
        return text(`Tab ${tab.id}: ${wc.getTitle()} — ${wc.getURL()}`)
      },
    )

    tool(
      'snapshot',
      'Describe the page: title, URL, headings and the interactive elements with refs to use in click/type.',
      { tab_id: tabId },
      async ({ tab_id }) => {
        const tab = this.tab(tab_id)
        return text(auto.formatSnapshot(await auto.snapshot(tab.wake())))
      },
    )

    tool(
      'read_page',
      'Read the visible text of the page (paginated).',
      { tab_id: tabId, offset: z.number().int().min(0).optional(), limit: z.number().int().min(100).max(100_000).optional() },
      async ({ tab_id, offset = 0, limit = 20_000 }) => {
        const tab = this.tab(tab_id)
        const { text: body, total } = await auto.readText(tab.wake(), offset, limit)
        const more = offset + body.length < total ? `\n\n[… ${total - offset - body.length} more characters; call again with offset=${offset + body.length}]` : ''
        return text(body + more)
      },
    )

    tool('click', 'Click an element by ref (from snapshot) or CSS selector.', { tab_id: tabId, ref, selector }, async ({ tab_id, ref, selector }) => {
      const tab = this.tab(tab_id)
      return text(await auto.click(tab, tab.wake(), { ref, selector }))
    })

    tool(
      'type',
      'Type text into an input/textarea/contenteditable by ref or selector.',
      {
        tab_id: tabId,
        ref,
        selector,
        text: z.string(),
        clear: z.boolean().optional().describe('Replace existing content (default true).'),
        submit: z.boolean().optional().describe('Press Enter afterwards.'),
      },
      async ({ tab_id, ref, selector, text: value, clear = true, submit = false }) => {
        const tab = this.tab(tab_id)
        const wc = tab.wake()
        await auto.type(wc, { ref, selector }, value, clear)
        if (submit) await auto.pressKey(wc, 'Enter')
        return text(`Typed ${value.length} characters${submit ? ' and pressed Enter' : ''}.`)
      },
    )

    tool(
      'press_key',
      'Press a key in the focused element, e.g. Enter, Tab, Escape, Backspace, Up, Down, PageDown, or a character.',
      { tab_id: tabId, key: z.string(), modifiers: z.array(z.enum(['shift', 'control', 'alt', 'meta'])).optional() },
      async ({ tab_id, key, modifiers }) => {
        const tab = this.tab(tab_id)
        await auto.pressKey(tab.wake(), key, modifiers)
        return text(`Pressed ${[...(modifiers ?? []), key].join('+')}.`)
      },
    )

    tool(
      'scroll',
      'Scroll the page by a number of pixels (negative = up), or scroll an element into view.',
      { tab_id: tabId, dy: z.number().optional(), ref, selector },
      async ({ tab_id, dy = 600, ref, selector }) => {
        const tab = this.tab(tab_id)
        return text(await auto.scroll(tab.wake(), dy, { ref, selector }))
      },
    )

    tool(
      'screenshot',
      'Take a screenshot of the tab (JPEG).',
      { tab_id: tabId },
      async ({ tab_id }) => {
        const tab = this.tab(tab_id)
        let image = await tab.wake().capturePage(undefined, { stayHidden: true })
        if (image.isEmpty()) throw new Error('Screenshot was empty (tab may still be loading).')
        const { width } = image.getSize()
        if (width > 1280) image = image.resize({ width: 1280, quality: 'good' })
        return { content: [{ type: 'image', data: image.toJPEG(75).toString('base64'), mimeType: 'image/jpeg' }] }
      },
    )

    tool(
      'wait_for',
      'Wait until a selector exists and/or text appears on the page, or (with neither) until loading finishes.',
      { tab_id: tabId, selector: z.string().optional(), text: z.string().optional(), timeout_ms: z.number().int().max(60_000).optional() },
      async ({ tab_id, selector: sel, text: needle, timeout_ms = 10_000 }) => {
        const tab = this.tab(tab_id)
        const ok = await auto.waitFor(tab.wake(), { selector: sel, text: needle, timeoutMs: timeout_ms })
        return ok ? text('Condition met.') : { ...text(`Timed out after ${timeout_ms}ms.`), isError: true }
      },
    )

    if (getSettings().mcp.allowEvaluate) {
      tool(
        'evaluate',
        'Run JavaScript in the page and return the JSON-serializable result.',
        { tab_id: tabId, code: z.string().describe('An expression or IIFE.') },
        async ({ tab_id, code }) => {
          const tab = this.tab(tab_id)
          const result = await auto.evaluate(tab.wake(), code)
          return text(JSON.stringify(result, null, 2) ?? 'undefined')
        },
      )
    }

    return mcp
  }
}

function readBody(req: http.IncomingMessage, max = 5 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > max) {
        reject(new Error('Body too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
