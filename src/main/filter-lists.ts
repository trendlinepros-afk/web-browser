// Filter list sources. No Electron imports: also used by scripts/build-filters.js at release time.
import { adsAndTrackingLists } from '@ghostery/adblocker'

/** Mirrored and kept current by the Ghostery adblocker project on GitHub. */
const ASSETS = 'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets'

const COOKIE_BANNER_LISTS = [`${ASSETS}/easylist/easylist-cookie.txt`, `${ASSETS}/ublock-origin/annoyances-cookies.txt`]

/** uBlock Origin's scriptlets and redirect resources (e.g. harmless stand-ins for blocked scripts). */
export const RESOURCES_URL = `${ASSETS}/ublock-origin/resources.json`

/** EasyList, EasyPrivacy, uBlock Origin filters (incl. badware/malware) and Peter Lowe's list. */
export function filterListUrls(cookieBanners: boolean): string[] {
  return [...adsAndTrackingLists, ...(cookieBanners ? COOKIE_BANNER_LISTS : [])]
}
