# Zirtola

A fast, private, lightweight desktop browser built on Chromium (via Electron), designed first for Windows 11:

- **Chrome extensions**, including LastPass, installed straight from the Chrome Web Store
- **Built-in ad, tracker and cookie-banner blocking**, with no Manifest V3 limits
- **No Google tracking**: no account sign-in, sync or usage reporting, and Chrome's Privacy Sandbox ad APIs are switched off
- **Tab sleeping**: hidden tabs release their memory automatically and wake when you click them
- **Bookmarks bar** with one-click **import from Firefox**
- **Private windows** that keep nothing on disk and don't share cookies with anything else
- **A built-in MCP server** so Claude can drive the browser (off by default)
- **One-click updates** from GitHub Releases

See [docs/SPEC.md](docs/SPEC.md) for the full spec and roadmap.

## Install

Download the latest release from the [Releases page](https://github.com/trendlinepros-afk/web-browser/releases/latest):

| OS | File | Notes |
|---|---|---|
| **Windows 10/11** | `Zirtola-Setup-x.y.z.exe` | Unsigned for now: on first run click **More info → Run anyway** |
| macOS | `Zirtola-x.y.z-arm64-mac.dmg` (Apple Silicon) / `-x64-` (Intel) | Unsigned: right-click the app → **Open**. Auto-update needs signing (planned) |
| Linux | `zirtola_x.y.z_amd64.deb` | Preferred. `sudo apt install ./zirtola_*.deb` |
| Linux | `Zirtola-x.y.z.AppImage` | Fallback |

**Default browser (Windows):** Zirtola offers this once on first launch, or use the ⚙ menu → **Make Zirtola your default
browser…**. Windows opens Settings › Default apps, where you click **Set default** next to Zirtola.

**Coming from "Web Browser"?** That was this app's working name. Updating carries your bookmarks, tabs, settings,
logins and extensions over automatically.

## Updating

**the ⚙ menu → Check for updates…** checks GitHub, downloads the new version and asks you to restart.
Your tabs come back after the restart. The browser also checks quietly on startup (you can turn this off in Settings).

## Using it

| Action | Shortcut |
|---|---|
| New tab / window / private window | Ctrl+T / Ctrl+N / Ctrl+Shift+N |
| Settings | Ctrl+, |
| Bookmark page / show bookmarks bar | Ctrl+D / Ctrl+Shift+B |
| Close tab / reopen closed tab | Ctrl+W / Ctrl+Shift+T |
| Address bar | Ctrl+L, Alt+D, F6 |
| Next / previous tab, jump to tab | Ctrl+Tab / Ctrl+Shift+Tab, Ctrl+1…9 |
| Back / forward / reload | Alt+← / Alt+→ / Ctrl+R (hard reload: Ctrl+Shift+R) |
| Home | Alt+Home (set your homepage in ⚙ → Settings → Startup & home) |
| Zoom | Ctrl+= / Ctrl+- / Ctrl+0 |
| Developer tools | F12 |

(On macOS use Cmd instead of Ctrl.)

### LastPass and other extensions
⚙ → **Settings → Extensions → Install** (LastPass) or **Browse** (the whole Chrome Web Store), then click
**Add to Chrome**. Extension buttons show up in the toolbar. Extensions update automatically.

### Bookmarks
- **Bookmark a page:** click the ☆ in the address bar or press Ctrl+D. It goes on the bookmarks bar, and a
  small dialog lets you rename it or pick a folder.
- **Bookmarks bar:** shown under the address bar (toggle with Ctrl+Shift+B). Click to open, Ctrl+click or
  middle-click for a new tab, and click a folder for its contents. Drag items to reorder them, or onto a folder to
  move them in. Right-click for edit, delete, new folder and "open all". Items that don't fit go under ».
- **Import from Firefox:** ⚙ → **Settings → Bookmarks → Import** (or the link on an empty bar).
  It reads your Firefox profile directly, icons included. Firefox can stay open. Your Firefox toolbar lands on the bar and
  everything else goes under *Other bookmarks › Imported from Firefox*. Importing again skips pages you already have.
- **Import/export HTML:** works with exports from Firefox, Chrome, Edge and Safari, and is a good way to back up.

### Tab groups
- **Open a bookmarks folder as a group:** right-click the folder on the bookmarks bar → **Open in group**. The group
  is named after the folder.
- **Group any tab:** right-click a tab → **Add to new group** (type a name and press Enter) or **Add to group**.
- **The group label:** click it to collapse or expand the group, double-click to rename it, right-click for color,
  new tab in group, move to a new window, ungroup or close.
- **Drag and drop:** drag a tab onto a group (or between its tabs) to add it, drag it out past the group's edge to
  remove it, and drag the label to move the whole group. Groups come back after a restart.

### Ads, trackers and privacy
The shield button next to the address bar shows how many ads and trackers were blocked on the current page.
Click it to turn blocking off for a site that misbehaves, turn cookie-banner hiding on or off, or refresh the
filter lists (this also happens automatically every day). The browser sends the Global Privacy Control signal
(a legal "do not sell or share my data" request in some places), which you can turn off in ⚙ → Settings → Privacy & blocking.

### Clearing your cache and cookies
⚙ → **Settings → Clear browsing data** (or press Ctrl+Shift+Delete): **Clear cache** keeps you signed in;
**Clear** removes cookies and site data for every site. To reset just one site, click the shield next to the
address bar → **Clear cookies & data for this site**. Extensions such as LastPass keep their data either way.

### Saving memory
Tabs you haven't looked at for 15 minutes go to sleep: they show dimmed and use no memory until you click them.
Change the timeout in ⚙ → **Settings → Speed & memory**. If your computer runs low on memory, the
least recently used tabs sleep first. Tabs playing audio, using your camera or mic, or pinned stay awake.

### Chat with Claude
Click the **Claude** button in the toolbar (or press Ctrl+Shift+K) and type what you want: *"Summarize this page"*,
*"Find the cheapest option here and add it to the cart"*. Claude sees the tab you're on and works in the browser while
you watch; each step shows up in the chat. It uses the Claude Code on your computer, so it runs on your own Claude
login with no API key. If Claude Code isn't installed, the panel tells you how to get it. In this chat Claude can
only use the browser: no files, no commands. It asks before buying, sending or deleting anything.

### Letting Claude drive the browser (MCP)
1. ⚙ → **Settings → Claude → Connect**. That's it: Zirtola sets up Claude Desktop and Claude Code (whichever you
   have) to use it. Nothing to copy, and no Node.js needed.
2. Restart Claude: quit Claude Desktop from the system tray and open it again, or start a new `claude` session.
3. Ask Claude things like *"Use Zirtola to open my bank's statements page and download last month's PDF"*.

Keep Zirtola open while Claude uses it. Claude can only reach it from your own computer (not from claude.ai on the
web or cloud sessions). It can't see private windows, and it can't run arbitrary JavaScript unless you turn that on
in the same settings section. Tabs Claude is driving show a glowing dot. To stop it, turn off
"Let Claude control Zirtola".

## Development

Requires Node.js 22+.

```bash
npm install
npm start          # build and run
npm run typecheck  # type-check main, preload and UI
npm run dist       # build installers for your OS into release/
```

Code layout: `src/main` (browser engine: windows, tabs, sleeping, extensions, MCP, updates),
`src/preload` (the bridge to the UI), `src/renderer` (tab strip and toolbar, plain TypeScript, no framework).

### Releasing a new version

Every push to `main` is a release. GitHub Actions builds Windows, macOS and Linux installers, numbers the version
`<major>.<minor>.<build>`, and publishes it. Installed browsers pick it up through **Check for updates**.
Bump `major`/`minor` in `package.json` for big milestones. Docs-only pushes don't trigger a release.

## License

GPL-3.0. The Chrome extension support library ([electron-chrome-extensions](https://github.com/samuelmaddock/electron-browser-shell))
is GPL-3.0 licensed, so this project is too.
