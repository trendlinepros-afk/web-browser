import { safeStorage } from 'electron'
import { getSettings, updateSettings } from './settings'

/**
 * Talks to a Deluge Web UI (the one at http://<server>:8112, e.g. a Docker container on Unraid) over
 * its JSON-RPC endpoint, the same way the old "Deluge Siphon" extension did:
 *
 *   auth.login(password) → session cookie
 *   web.connected / web.get_hosts / web.get_host_status / web.connect  (attach to the daemon)
 *   core.add_torrent_magnet(uri, options) or core.add_torrent_file(name, base64, options)
 *   label.add / label.set_torrent  (optional, needs Deluge's Label plugin)
 */

export interface AddResult {
  /** Torrent name shown to the user. */
  name: string
  /** True when Deluge already had it. */
  duplicate?: boolean
  /** A label was asked for but couldn't be set (e.g. Label plugin off). */
  labelNote?: string
}

class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message)
  }
}

const NOT_AUTHENTICATED = 1

/** Stored passwords are encrypted with the OS keychain when it's available. */
export function savePassword(password: string): void {
  const value = !password
    ? ''
    : safeStorage.isEncryptionAvailable()
      ? `enc:${safeStorage.encryptString(password).toString('base64')}`
      : password
  updateSettings((s) => (s.torrents.password = value))
}

function storedPassword(): string {
  const value = getSettings().torrents.password
  if (!value.startsWith('enc:')) return value
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'))
  } catch {
    return ''
  }
}

/** "tower:8112", "http://192.168.1.5:8112/" or a reverse-proxy path → the JSON-RPC endpoint. */
export function endpointFor(address: string): string | null {
  let text = address.trim()
  if (!text) return null
  if (!/^https?:\/\//i.test(text)) text = `http://${text}`
  try {
    const url = new URL(text)
    url.hash = ''
    url.search = ''
    url.pathname = `${url.pathname.replace(/\/+$/, '').replace(/\/json$/, '')}/json`
    return url.toString()
  } catch {
    return null
  }
}

/** The dn= (display name) of a magnet link, or its hash. */
export function magnetName(uri: string): string {
  try {
    const params = new URLSearchParams(uri.slice(uri.indexOf('?') + 1))
    const dn = params.get('dn')
    if (dn) return dn
    const xt = params.get('xt')
    if (xt) return xt.replace(/^urn:btih:/i, '').slice(0, 16)
  } catch {
    // fall through
  }
  return 'magnet link'
}

/** The name inside a .torrent (its bencoded info dictionary's "name"). */
function torrentName(data: Buffer): string | null {
  const text = data.toString('latin1')
  const at = text.indexOf('4:info')
  const m = at >= 0 ? /4:name(\d+):/.exec(text.slice(at)) : null
  if (!m) return null
  const start = at + m.index + m[0].length
  return Buffer.from(text.slice(start, start + Number(m[1])), 'latin1').toString('utf8') || null
}

export class DelugeClient {
  private cookie = ''
  private nextId = 1

  private endpoint(): string {
    const url = endpointFor(getSettings().torrents.url)
    if (!url) throw new Error('Set your Deluge Web UI address in Settings → Torrents.')
    return url
  }

  private async rawCall<T>(method: string, params: unknown[]): Promise<T> {
    const url = this.endpoint()
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(this.cookie ? { Cookie: this.cookie } : {}) },
        body: JSON.stringify({ method, params, id: this.nextId++ }),
        signal: AbortSignal.timeout(15_000),
      })
    } catch (err) {
      const host = new URL(url).host
      throw new Error(err instanceof Error && err.name === 'TimeoutError' ? `Deluge at ${host} isn't answering.` : `Can't reach Deluge at ${host}. Is it running?`)
    }
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(';')[0]
      if (pair.startsWith('_session_id=')) this.cookie = pair
    }
    if (!res.ok) throw new Error(`Deluge answered ${res.status} ${res.statusText}. Is ${new URL(url).host} the Deluge Web UI?`)
    let body: { result?: T; error?: { message?: string; code?: number } | null }
    try {
      body = (await res.json()) as typeof body
    } catch {
      throw new Error(`${new URL(url).host} didn't answer like a Deluge Web UI.`)
    }
    if (body.error) throw new RpcError(body.error.message ?? 'Deluge reported an error', body.error.code)
    return body.result as T
  }

  /** Calls a method, signing in first (or again, when the session expired). */
  private async call<T>(method: string, params: unknown[] = []): Promise<T> {
    if (!this.cookie) await this.login()
    try {
      return await this.rawCall<T>(method, params)
    } catch (err) {
      if (!(err instanceof RpcError) || err.code !== NOT_AUTHENTICATED) throw err
      await this.login()
      return this.rawCall<T>(method, params)
    }
  }

  private async login(): Promise<void> {
    this.cookie = ''
    const ok = await this.rawCall<boolean>('auth.login', [storedPassword()])
    if (!ok) throw new Error('Deluge rejected the password (it\'s the Web UI password; the default is "deluge").')
  }

  /** The Web UI must be attached to a Deluge daemon; the Docker images usually do this on their own. */
  private async ensureDaemon(): Promise<void> {
    if (await this.call<boolean>('web.connected')) return
    const hosts = await this.call<unknown[][]>('web.get_hosts')
    for (const host of hosts ?? []) {
      const id = String(host[0])
      const status = await this.call<unknown[]>('web.get_host_status', [id]).catch(() => null)
      const state = String(status?.[1] ?? '')
      if (state === 'Online' || state === 'Connected') {
        await this.call('web.connect', [id])
        return
      }
    }
    throw new Error('Deluge\'s Web UI has no daemon. Connect one in its Connection Manager.')
  }

  private options(): Record<string, unknown> {
    const t = getSettings().torrents
    const options: Record<string, unknown> = { add_paused: t.addPaused }
    if (t.downloadLocation.trim()) options.download_location = t.downloadLocation.trim()
    return options
  }

  /** Signs in and attaches to the daemon; returns the Deluge version for the settings page. */
  async test(): Promise<string> {
    this.cookie = ''
    await this.ensureDaemon()
    const version = await this.call<string>('daemon.get_version').catch(() => '')
    return version ? `Deluge ${version}` : 'Deluge'
  }

  async addMagnet(uri: string): Promise<AddResult> {
    await this.ensureDaemon()
    return this.finish(magnetName(uri), () => this.call<string | null>('core.add_torrent_magnet', [uri, this.options()]))
  }

  async addTorrentFile(filename: string, data: Buffer): Promise<AddResult> {
    await this.ensureDaemon()
    const name = torrentName(data) ?? filename.replace(/\.torrent$/i, '')
    return this.finish(name, () => this.call<string | null>('core.add_torrent_file', [filename, data.toString('base64'), this.options()]))
  }

  private async finish(name: string, add: () => Promise<string | null>): Promise<AddResult> {
    let id: string | null
    try {
      id = await add()
    } catch (err) {
      if (err instanceof Error && /already (in session|being added)/i.test(err.message)) return { name, duplicate: true }
      throw err
    }
    // Deluge 1.x returns null for a torrent it already has.
    if (!id) return { name, duplicate: true }
    const label = getSettings().torrents.label.trim().toLowerCase()
    if (!label) return { name }
    try {
      const labels = await this.call<string[]>('label.get_labels')
      if (!labels.includes(label)) await this.call('label.add', [label])
      await this.call('label.set_torrent', [id, label])
      return { name }
    } catch {
      return { name, labelNote: 'no label: Deluge\'s Label plugin is off' }
    }
  }
}
