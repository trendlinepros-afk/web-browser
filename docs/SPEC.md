# Zirtola: Product & Technical Spec

Status: **Stages 1, 1.5 (privacy & blocking) and 1.6 (bookmarks) done; LastPass gate pending** · Last updated 2026-10-10

## 1. What we're building

**Zirtola** is a fast, low-overhead desktop browser. **Primary platform: Windows 11** (designed and tuned for it
first; macOS and Linux builds ship too). It:

1. **Runs Chrome extensions, LastPass first of all.** This is a hard requirement and drives the engine choice.
2. **Stays light.** Idle tabs go to sleep, background tabs are throttled, and restored sessions load lazily.
3. **Can be driven by Claude** through a built-in MCP server.
4. **Has a real incognito mode.** It keeps nothing on disk and doesn't share cookies with normal windows.
5. **Updates itself** from GitHub Releases, with a "Check for updates" button.
6. **Fixes what's wrong with Chrome** while keeping Chrome's site compatibility (§2a).

Non-goals for now: our own rendering engine, sync servers, a mobile version, and a custom extension store.

## 2. Engine decision

| Option | Chrome extensions (LastPass) | Effort | Verdict |
|---|---|---|---|
| Fork Chromium (like Brave/Vivaldi) | Full | Huge: 100 GB+ builds, a full-time team | ❌ |
| Tauri / system WebView (WebKit, WebView2) | None or very partial | Medium | ❌ fails the LastPass requirement |
| **Electron + `electron-chrome-extensions` + `electron-chrome-web-store`** | Good: MV3 service workers, tabs, storage, contextMenus, action popups, webNavigation, cookies, and installs from the Chrome Web Store | Reasonable | ✅ |

Electron ships current Chromium, so websites behave the same as in Chrome. Extensions get Electron's built-in support plus the
`electron-chrome-extensions` layer, which adds `chrome.tabs`, `chrome.windows`, `chrome.action`,
`chrome.contextMenus` and more.

**Risk:** LastPass is a large MV3 extension. Some APIs it might touch, such as `chrome.offscreen`,
`chrome.tabs.captureVisibleTab` and parts of `chrome.commands`, are missing or only partly implemented. Stage 1 includes
a **LastPass validation gate** (§9). If something breaks, we fill the specific gap in our main process.
That is normal, expected work and doesn't call for a new engine.

Gaps filled so far (`src/main/extension-apis.ts` + `src/preload/extension-sw-preload.ts`):
- **`chrome.alarms`**: Electron accepts alarms but never fires them. Zirtola schedules them in the main
  process (persisted across restarts) and wakes the extension's sleeping service worker to deliver them.
- **`chrome.identity`**: `launchWebAuthFlow` / `getRedirectURL` for extension sign-in flows.
- **`browser` namespace**: Chromium 152 also exposes extension APIs as a separate `browser` object that misses
  electron-chrome-extensions' additions (`browser.windows` undefined). LastPass uses `browser` and crashed at startup
  on `browser.windows.onFocusChanged`. Zirtola points `browser` at `chrome` in extension workers and pages.
- **`chrome.omnibox`**: missing in Electron, so extensions declaring an address-bar keyword crashed at startup
  (LastPass 4.156 declares `"omnibox": {"keyword": "lp"}`). Typing `<keyword> <text>` in the address bar delivers
  onInputEntered to that extension.
- **`chrome.sidePanel`**: harmless stand-in (no side panel yet).
- **Diagnostics**: Settings → Extensions → Copy collects extension worker/page logs for bug reports.

**Licensing:** `electron-chrome-extensions` is dual-licensed as GPL-3.0 or a paid patron license. Because this
repo is public, we use **GPL-3.0** for the whole app. The license is free, but anyone who forks the code must keep it open source.

## 2a. Chromium without Chrome's problems

We use Chromium, the open-source engine, not Chrome, Google's product built on it. Most of what people
dislike about Chrome lives in the product layer, which this browser replaces. How each problem is handled:

| Chrome problem | Our answer | Status |
|---|---|---|
| **Google tracking:** account sign-in, sync, usage stats, Safe Browsing lookups, `X-Client-Data` header | None of that code exists in Electron. A network audit of an idle session showed no calls to Google. One exception: on **Linux** only, the spellchecker downloads its dictionary file from Google's CDN once. Windows and Mac use the OS spellchecker | ✅ |
| **Privacy Sandbox ad APIs:** Topics, FLEDGE / Protected Audience ad auctions, Shared Storage, Attribution Reporting, Fenced Frames | Disabled with Chromium feature switches; verified absent from pages (`privacy.ts`) | ✅ |
| **Ads and trackers** (Chrome's Manifest V3 limits extension blockers) | Built-in blocker using Ghostery's engine with uBlock Origin, EasyList, EasyPrivacy, Peter Lowe and uBlock "badware" lists. It runs inside the browser, so MV3 limits don't apply. Also hides cookie banners. A shield button shows the count and turns blocking off per site. Lists refresh every 24 h, and a snapshot ships in every release so blocking works on first launch, offline included | ✅ |
| **Fingerprinting signals / bot checks** | Zirtola must look exactly like the Chromium it is, or Google ("unusual traffic"), Cloudflare and reCAPTCHA flag it. `client-hints.ts` sends the `Sec-CH-UA*` headers Electron omits, byte-identical to the renderer's own `navigator.userAgentData` (GREASE brand computed like Chromium, exact values learned from the renderer once per version), and honours sites' `Accept-CH` requests. `page-preload.ts` (all frames) adds Chrome's standard `window.chrome` members, reports undecided permissions as "prompt" (Electron can only say granted/denied), and keeps `navigator.languages` in step with `Accept-Language`. Headers go out in Chrome's order; patched functions have the exact shape of native ones (no `prototype`, not constructible, `[native code]`); storage-access requests are granted like Chrome does (reCAPTCHA needs it). WebRTC can't expose local IPs; GPC sent by default | ✅ |
| **Memory hog** | Tab sleeping, memory-pressure sleeping, lazy restore, one process per *site* (not per tab), lazy-loaded subsystems (§4) | ✅ |
| **Google steers web standards** | Can't be fixed on Chromium (or by any single browser). Mitigations: we switch off Google-specific features as they ship, and the tab layer stays engine-agnostic (`Tab` wraps the engine) so a different engine can be adopted later if one becomes viable | ⚠️ mitigated |
| **Security depends on Google's patches** | It's a strength, provided we ship them fast. Dependabot opens a PR for every Electron release (daily check). Electron ships Chromium security fixes within days of Chrome | ✅ process in place |
| **No Safe Browsing** (by design, it phones Google) | Partly covered by uBlock's badware/malware list blocking known-bad resources. A full-page "dangerous site" warning is on the Stage 3 roadmap | ⚠️ partial |

## 3. Architecture

```
┌─────────────────────────── BrowserWindow (one per window) ───────────────────────────┐
│  Chrome UI (renderer/index.html): tab strip · toolbar · address bar · extensions     │
│  ── preload/ui-preload.js exposes a small typed API (contextBridge) ──               │
├──────────────────────────────────────────────────────────────────────────────────────┤
│  Active tab = WebContentsView (sandboxed, contextIsolation, own renderer process)    │
│  Inactive tabs: hidden + throttled  →  after N minutes: DISCARDED (process freed)   │
└──────────────────────────────────────────────────────────────────────────────────────┘
Main process (src/main)
  main.ts         app bootstrap, single instance, UA cleanup, command-line flags
  browser.ts      Browser registry: windows, tabs, IDs, session restore
  window.ts       BrowserWindowController: lays out UI + tab views, IPC to UI
  tab.ts          Tab: create / discard / restore (keeps back-forward history)
  tab-sleeper.ts  Stale-tab discarding + memory-pressure discarding
  profiles.ts     Sessions: persist:default and per-window in-memory incognito
  extensions.ts   ElectronChromeExtensions + Chrome Web Store installer
  permissions.ts  Per-site permission prompts (camera, mic, location, notifications…)
  updater.ts      electron-updater against GitHub Releases
  mcp-server.ts   MCP server (Streamable HTTP on 127.0.0.1, bearer-token auth)
  settings.ts     JSON settings at <userData>/settings.json
  menu.ts         App menu + keyboard shortcuts
  context-menu.ts Page right-click menu, including extension items
  bookmarks.ts    Bookmark store (bar + other), favicon capture
  bookmark-ui.ts  Bar actions, folder menus, edit dialog, import/export flows
  bookmark-import.ts  Firefox profile reader (SQLite via node:sqlite), bookmarks HTML import/export
  blocker.ts      Ad/tracker/malware blocking + cosmetic filtering, per-site allowlist
  filter-worker.ts  Utility process that compiles filter lists (keeps parsing off the main thread)
  privacy.ts      Chromium hardening switches; owns all webRequest hooks; client hints, GPC
preload/page-preload.ts  Per-page: userAgentData brands and navigator.globalPrivacyControl
```

Principles:
- **No framework in the browser UI.** Plain TypeScript and DOM, no React. The UI paints in about a millisecond and adds no bundle weight.
- **The main process owns state.** The UI is a thin view that gets updates pushed over IPC.
- **Web content is sandboxed.** `sandbox: true`, `contextIsolation: true`, no Node in web pages, and a strict CSP on the UI.

## 4. Performance & resource budget

These are targets. We measure against them at the end of each stage.

| Metric | Target |
|---|---|
| Cold start to usable window | < 1.0 s (warm OS cache) |
| New tab to address bar focused | < 50 ms |
| Idle browser, 1 blank tab | < 350 MB total PSS (measured **~320 MB** on Linux incl. the blocker's ~17 MB) |
| 4 tabs on one site | 1 page process, not 4 (measured) |
| 30 tabs restored at startup | Only the active tab loads. The rest cost ~0 MB until clicked |
| Background tab after sleep | Renderer process freed (0 MB) |

Resource savers:
1. **Tab sleeping (discarding).** A tab hidden for longer than `discardAfterMinutes` (default 15) has its WebContents
   destroyed. We keep the URL, title, favicon and **full back/forward history**, and clicking the tab restores it.
   Never discarded: the active tab, tabs playing audio, tabs using the mic or camera, pinned tabs (configurable),
   and tabs Claude touched in the last 2 minutes.
2. **Memory-pressure discarding.** When free system RAM drops below a threshold, we sleep the least recently used tabs first,
   until we're back above it.
3. **Lazy session restore.** Restored tabs start asleep and load only when clicked.
4. **Background throttling.** Chromium's timer and rAF throttling stays on for hidden tabs.
5. **Lean startup.** Unused Chromium features (Media Router / casting) are off. The MCP SDK and the updater
   load only when first used. A new tab is `about:blank`, so it costs no renderer process until you navigate.
6. **Extension cost visibility (Stage 3).** A task manager lists memory and CPU per tab and per extension, so you can see what's heavy.

## 5. Incognito

- Each incognito window gets its own **in-memory** session partition (no `persist:` prefix). Nothing
  is written to disk, and everything is gone when the window closes.
- Incognito never shares cookies or storage with normal windows or with other incognito windows.
- History, session restore and the tab sleeper's saved state skip incognito tabs.
- Extensions are **off by default** in incognito. A per-extension "Allow in incognito" toggle is planned for Stage 2,
  mainly so LastPass can work there if you want it.
- The MCP server **cannot see** incognito tabs unless the "Allow Claude in incognito" setting is on.
- Incognito windows have a dark, clearly different look.

## 6. MCP: letting Claude drive the browser

- A built-in MCP server using **Streamable HTTP** at `http://127.0.0.1:<port>/mcp`, default port 47823.
- **Off by default.** You turn it on from the menu (Claude → Enable MCP server). It binds to localhost only and
  needs a random bearer token, which you can copy from the menu along with a ready-made `claude mcp add` command.
- A blue badge in the toolbar shows when MCP is on. Each tab Claude is driving gets an indicator.
- Tools (Stage 1):

| Tool | Purpose |
|---|---|
| `list_tabs` | id, title, url, active, sleeping, incognito |
| `open_tab` / `close_tab` / `activate_tab` | Tab management |
| `navigate` | Load a URL (or back / forward / reload) in a tab |
| `snapshot` | Compact list of visible, interactive elements with stable `ref`s, plus page title and URL |
| `read_page` | Visible page text (truncated, paginated) |
| `click` | Click by `ref` or CSS selector |
| `type` | Focus by `ref`/selector and type text (optionally press Enter) |
| `press_key` | Send a key (Enter, Tab, Escape, arrows…) |
| `scroll` | Scroll page or element |
| `screenshot` | PNG of the tab |
| `wait_for` | Wait for selector / text / navigation idle |
| `evaluate` | Run JS in the page. **Disabled unless enabled in settings** |

Connect Claude Code:
```
claude mcp add --transport http browser http://127.0.0.1:47823/mcp --header "Authorization: Bearer <token>"
```
Claude Desktop connects through `npx mcp-remote` with the same URL and header (see README).

## 7. Updates

- `electron-updater` with the **GitHub provider** on this public repo, so no token is needed to download updates.
- A **"Check for updates…"** button in the menu checks, downloads, then asks **Restart to update**.
  On launch the browser also checks quietly (can be turned off) and only shows a notice when an update exists.
- Releases: push a tag `vX.Y.Z` and GitHub Actions (`.github/workflows/release.yml`) builds Windows (NSIS),
  macOS (dmg + zip) and Linux (AppImage), then publishes them to a GitHub Release that the updater reads.
- Caveats:
  - **Linux: use the `.deb`.** Extension service workers only get the full `chrome.*` API when Chromium's
    sandbox is on (verified in testing: with `--no-sandbox`, `chrome.contextMenus`/`webNavigation`/`windows`
    are missing in MV3 workers). The .deb installs the sandbox helper properly; AppImage is a fallback.
  - **macOS auto-update requires a signed and notarized app** (Apple Developer account, $99/yr). Until then,
    Mac users download new versions by hand.
  - Unsigned Windows builds show a SmartScreen warning on first install. Updates still work after that.

## 8. Stages

### Stage 1: Foundation (this PR)
Verified by driving the running app through its own MCP server: navigation, typing and submitting forms,
`target=_blank` and `window.open` tabs (with `window.opener`), OAuth-style popups, tab sleep and wake with
history, lazy session restore across restarts, and incognito cookie/storage isolation in both directions.

- [x] Project scaffolding (TypeScript, electron-builder, release workflow, GPL-3.0)
- [x] Multi-window, multi-tab browsing with WebContentsView per tab
- [x] Address bar: URL or search (default engine configurable), keyboard shortcuts
- [x] Tab sleeping (time-based + memory-pressure) with history-preserving restore
- [x] Lazy session restore
- [x] Incognito windows (in-memory partitions)
- [x] Chrome extensions + Chrome Web Store installs; extension toolbar buttons and popups
- [x] Context menu (including extension items), per-site permission prompts, downloads (save dialog)
- [x] Popups / `window.open` that keep `window.opener` (OAuth and SSO logins work)
- [x] Clean Chrome user agent (Google sign-in and similar sites)
- [x] MCP server (Stage 1 toolset), off by default, token-protected
- [x] Check-for-updates button + background check
- [ ] **LastPass validation gate** (§9). Run by hand on a real machine

### Stage 1.5: Privacy & blocking (done)
- [x] Built-in ad, tracker, malware and cookie-banner blocking with per-site toggle and blocked count
- [x] Filter lists: 24 h background refresh in a utility process, release-time snapshot for first run
- [x] Privacy Sandbox ad APIs disabled (verified)
- [x] Client hints and `navigator.userAgentData` consistent with the user agent; GPC on by default
- [x] WebRTC local-IP protection; one process per site
- [x] Dependabot for Electron (Chromium) security releases

### Stage 1.6: Bookmarks (done)
- [x] Bookmarks bar: favicons, folders (drop-downs), overflow », drag to reorder or into folders, right-click menu,
      Other bookmarks, show/hide (Ctrl+Shift+B), empty-bar hint
- [x] ☆ in the address bar / Ctrl+D with an edit dialog (name, URL, folder); Bookmark all tabs
- [x] Import from Firefox: reads `places.sqlite` + `favicons.sqlite` from a copy (works while Firefox is running,
      including unsaved WAL changes), picks the active profile, keeps folder structure and icons, skips smart
      folders, tags and separators, and never imports duplicates
- [x] Import/export Netscape bookmarks HTML (Firefox, Chrome, Edge, Safari)
- [x] Stored in `<userData>/bookmarks.json`; icons kept as data: URLs so the bar makes no network requests
- Releases: every push to `main` publishes a new version (`release.yml`)

### Stage 1.7: Zirtola identity & Windows 11 integration (done)
- [x] Renamed to Zirtola (icon in `build/icon.svg`, rendered by `scripts/render-icon.js`). `appId` kept so installed copies
      update in place; the old "Web Browser" profile is migrated on first run (`profile-migration.ts`)
- [x] Windows 11: tabs in the title bar with native caption buttons (Snap Layouts work), Segoe UI Variable,
      the system accent color (follows changes live), light/dark title bar colors
- [x] Default browser: the installer registers Zirtola under Settings › Default apps (`build/installer.nsh`); one-time
      offer on first run plus a menu item; opens links and .html files passed by Windows

### Stage 1.8: Zirtola's own look (done)
Goal: nothing should feel like Chrome or Firefox. Same two-row layout (tabs above, address below), new identity:
- **Palette** (`renderer/theme.css`, shared by UI, menus and dialogs): dark "ink" surfaces with a soft glow and the
  indigo→cyan gradient from the icon; a light variant follows Windows; violet palette for private windows.
  Theme setting: System / Dark / Light.
- **Shapes**: floating rounded-rectangle tabs (active tab has a gradient edge), a floating address field that
  shows the site's host prominently with a gradient focus ring, chip-style bookmarks, outline icon set, ⚙-style
  sliders button instead of Chrome's ⋮, pages shown as a rounded card inset from the window edge.
- **Menus**: every menu (⚙, page right-click, tab, bookmarks, shield, extension items) is drawn by Zirtola in
  one shared transparent overlay (`popup.ts`, `renderer/overlay.*`), not by the OS. Keyboard navigable,
  submenus, checkmarks. The overlay shares the UI's renderer process, so menus cost ~no memory.
- **Settings panel** (⚙ › Settings or Ctrl+,): a centered two-pane sheet, a sidebar of sections with icons and one
  section shown at a time under its own heading (icon-only sidebar in narrow windows). Sections (Appearance, Search, Speed &
  memory, Privacy & blocking, Clear browsing data, Startup & home, Bookmarks, Extensions, Claude, Updates) replacing nested menus.
- Wording: "Private window" instead of Chrome's "Incognito".

### Stage 1.9: Home button & tab groups (done)
- **Home button** right of reload (Alt+Home); Settings › Startup & home sets the homepage (empty = blank page with
  the address bar focused), "use current page", and hides the button.
- **Tab groups** (`window.ts` owns them; a group's tabs are always contiguous, pinned tabs never grouped):
  bookmarks folder → **Open in group** (named after the folder); tab menu → Add to new group / Add to group / Remove;
  colored label chip in the strip (click collapses, double-click renames inline, right-click: color, new tab in
  group, move to new window, ungroup, close). Drag tabs to reorder and into/out of groups; drag the label to move
  the whole group. Groups are saved with the session.

### Stage 1.10: Claude in the browser (done)
- **Connect** (Settings › Claude): one click registers Zirtola with Claude Desktop and Claude Code. Both launch
  Zirtola.exe as a stdio↔HTTP MCP bridge (`mcp-bridge.ts`, ELECTRON_RUN_AS_NODE) that reads port and token from
  settings, so no Node.js and no token copying.
- **Chat panel** (toolbar Claude button, Ctrl+Shift+K): drops down from the button in the overlay. Each message runs
  the local Claude Code CLI headless (`claude -p`, stream-json) with only Zirtola's MCP tools (`--tools ""`,
  `--strict-mcp-config`), resuming the window's conversation; the active tab is passed as context. Uses the person's
  Claude login (`claude-chat.ts`, `claude-cli.ts`).

### Stage 2: UI & everyday features
Design target: Windows 11 (Fluent): rounded corners, Mica-style surfaces, Segoe UI Variable, accent color.
- Tab animations; themed dialogs for update notices and import results (permission prompts are done)
- Find in page (Ctrl+F), zoom per site, print, reopen closed tab
- History, bookmarks (+ bookmark bar), address bar suggestions (history, bookmarks, search)
- Downloads panel
- Settings page (search engine, sleep timeout, startup behavior, MCP, updates)
- Extension management page, "Allow in incognito" per extension
- Show sleeping tabs dimmed, with a "sleep this tab now" action
- Bookmarks manager page (search, bulk edit); bookmarks in address bar suggestions

### Stage 3: Power & polish
- "Dangerous site" interstitial for top-level navigations to known malware/phishing domains
- Optional third-party cookie blocking
- Task manager (per-tab and per-extension memory and CPU)
- Vertical tabs option, split view, drag tabs between windows
- Import bookmarks and passwords from Chrome
- Richer MCP tools: multi-tab workflows, downloads, file upload, network capture
- Code signing (Windows + macOS) so updates have no warnings

## 9. LastPass validation gate (end of Stage 1)

To run on a real desktop (this needs your LastPass account, so it can't be automated in CI):
1. Menu → Extensions → Open Chrome Web Store, open the LastPass page and click **Add to Chrome**.
2. Confirm the LastPass icon shows in the toolbar and its popup opens.
3. Log in to LastPass from the popup.
4. Visit a site with a saved login: the inline autofill icon appears and the fill works.
5. Save a new site: the "Add to LastPass" prompt appears.
6. Right-click a field: the LastPass context menu items appear.
7. Restart the browser: you're still logged in and the extension reloads.
8. Visit a site using an HTTP login prompt (browser-native username/password dialog): note whether LastPass offers to fill it.
   Electron doesn't currently deliver `chrome.webRequest` events to MV3 service workers (verified with a test
   extension, independent of our own network hooks). If LastPass relies on them, this is the feature that would be missing.
9. With the shield on, check LastPass still logs in and syncs. Requests made by extensions are never blocked by design.

Log any failure as a GitHub issue labelled `lastpass`. We fix gaps in `extensions.ts`.

What's already verified in Stage 1 with a test MV3 extension (LastPass itself can't be downloaded in the CI
sandbox): the service worker starts, content scripts inject, the toolbar button renders, and inside the worker
`chrome.tabs`, `storage`, `contextMenus`, `webNavigation`, `windows`, `cookies`, `notifications`, `scripting`
and `runtime` messaging all work.

## 10. Security notes
- Web content: sandboxed and context-isolated, with no Node.js access. The UI preload exposes only named functions.
- Permissions (camera, mic, location, notifications, MIDI…) prompt per site. Answers are remembered for the session.
- MCP is localhost-only, off by default, needs a bearer token, keeps `evaluate` off by default, and can't see incognito tabs.
- Updates download over HTTPS from GitHub Releases. `electron-updater` checks the SHA-512 from `latest.yml`.
- Chromium security fixes arrive through Electron releases. Dependabot raises them daily; releasing promptly is the
  most important ongoing security task.
- Ad blocking never touches requests made by extensions, so password managers keep working, or top-level
  navigations, so you can always open the page you asked for.
