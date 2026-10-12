import { getSettings } from './settings'

const SCHEME = /^[a-z][a-z0-9+.-]*:/i
const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'file:', 'about:', 'data:', 'chrome-extension:', 'view-source:'])

/**
 * Turns address bar input into a URL: a full URL, a bare host ("example.com",
 * "localhost:3000"), or otherwise a search query. Returns null for empty input.
 */
export function toNavigableURL(input: string, searchTemplate: string): string | null {
  const text = input.trim()
  if (!text) return null

  if (SCHEME.test(text) && !/^[^:]+:\d+/.test(text)) {
    try {
      const url = new URL(text)
      if (ALLOWED_SCHEMES.has(url.protocol)) return url.href
    } catch {
      // Fall through to search.
    }
    return search(text, searchTemplate)
  }

  if (!/\s/.test(text)) {
    const hostLike = /^(localhost|\[[0-9a-f:]+\]|(\d{1,3}\.){3}\d{1,3}|([a-z0-9-]+\.)+[a-z][a-z0-9-]*)(:\d+)?([/?#].*)?$/i
    if (hostLike.test(text)) {
      const local = /^(localhost|127\.|\[::1\]|192\.168\.|10\.)/i.test(text)
      try {
        return new URL(`${local ? 'http' : 'https'}://${text}`).href
      } catch {
        // Fall through to search.
      }
    }
  }
  return search(text, searchTemplate)
}

function search(query: string, template: string): string {
  return template.replace('%s', encodeURIComponent(query))
}

/** What the address bar should display for a URL. */
export function displayURL(url: string): string {
  return url === 'about:blank' ? '' : url
}

/** The home button's destination, or null for a blank new-tab page. */
export function homepageURL(): string | null {
  const home = getSettings().homepage.trim()
  if (!home || home === 'about:blank') return null
  return toNavigableURL(home, getSettings().searchEngine)
}
