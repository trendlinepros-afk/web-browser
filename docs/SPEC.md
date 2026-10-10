# Web Browser — Product & Technical Spec

Status: **Stage 1 (Foundation) in progress** · Last updated 2026-10-10

## 1. What we're building

A fast, low-overhead desktop browser that:

1. **Runs Chrome extensions, LastPass first of all.** This is a hard requirement and drives the engine choice.
2. **Stays light.** Idle tabs go to sleep, background tabs are throttled, and restored sessions load lazily.
3. **Can be driven by Claude** through a built-in MCP server.
4. **Has a real incognito mode.** It keeps nothing on disk and doesn't share cookies with normal windows.
5. **Updates itself** from GitHub Releases, with a "Check for updates" button.

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

**Licensing:** `electron-chrome-extensions` is dual-licensed as GPL-3.0 or a paid patron license. Because this
repo is public, we use **GPL-3.0** for the whole app. The license is free, but anyone who forks the code must keep it open source.

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
| Idle browser, 1 blank tab | < 350 MB total PSS (measured **318 MB** on Linux, Stage 1) |
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

### Stage 2: UI & everyday features
- Visual design pass: compact tab strip, light and dark themes, smooth tab animations
- Find in page (Ctrl+F), zoom per site, print, reopen closed tab, tab drag-reorder
- History, bookmarks (+ bookmark bar), address bar suggestions (history, bookmarks, search)
- Downloads panel
- Settings page (search engine, sleep timeout, startup behavior, MCP, updates)
- Extension management page, "Allow in incognito" per extension
- Show sleeping tabs dimmed, with a "sleep this tab now" action

### Stage 3: Power & polish
- Built-in ad and tracker blocking (a fast list-based engine; large speed win on heavy sites)
- Task manager (per-tab and per-extension memory and CPU)
- Vertical tabs option, tab groups, split view
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
