# Web Browser

A fast, lightweight desktop browser built on Chromium (via Electron) with:

- **Chrome extensions**, including LastPass, installed straight from the Chrome Web Store
- **Tab sleeping**: hidden tabs release their memory automatically and wake when you click them
- **Incognito windows** that keep nothing on disk and don't share cookies with anything else
- **A built-in MCP server** so Claude can drive the browser (off by default)
- **One-click updates** from GitHub Releases

See [docs/SPEC.md](docs/SPEC.md) for the full spec and roadmap.

## Install

Download the latest release from the [Releases page](https://github.com/trendlinepros-afk/web-browser/releases/latest):

| OS | File | Notes |
|---|---|---|
| Windows | `Web-Browser-Setup-x.y.z.exe` | Unsigned for now: on first run click **More info → Run anyway** |
| macOS | `Web-Browser-x.y.z.dmg` | Unsigned for now: right-click the app → **Open**. Auto-update needs signing (planned) |
| Linux | `web-browser_x.y.z_amd64.deb` | Preferred. `sudo apt install ./web-browser_*.deb` |
| Linux | `Web-Browser-x.y.z.AppImage` | Fallback |

## Updating

**Menu (⋮) → Check for updates…** checks GitHub, downloads the new version and asks you to restart.
Your tabs come back after the restart. The browser also checks quietly on startup (you can turn this off in Settings).

## Using it

| Action | Shortcut |
|---|---|
| New tab / window / incognito window | Ctrl+T / Ctrl+N / Ctrl+Shift+N |
| Close tab / reopen closed tab | Ctrl+W / Ctrl+Shift+T |
| Address bar | Ctrl+L, Alt+D, F6 |
| Next / previous tab, jump to tab | Ctrl+Tab / Ctrl+Shift+Tab, Ctrl+1…9 |
| Back / forward / reload | Alt+← / Alt+→ / Ctrl+R (hard reload: Ctrl+Shift+R) |
| Zoom | Ctrl+= / Ctrl+- / Ctrl+0 |
| Developer tools | F12 |

(On macOS use Cmd instead of Ctrl.)

### LastPass and other extensions
Menu → **Extensions → Install LastPass** (or **Get extensions** for the whole Chrome Web Store), then click
**Add to Chrome**. Extension buttons show up in the toolbar. Extensions update automatically.

### Saving memory
Tabs you haven't looked at for 15 minutes go to sleep: they show dimmed and use no memory until you click them.
Change the timeout in Menu → **Settings → Sleep inactive tabs after**. If your computer runs low on memory, the
least recently used tabs sleep first. Tabs playing audio, using your camera or mic, or pinned stay awake.

### Letting Claude drive the browser (MCP)
1. Menu → **Claude (MCP) → Enable MCP server**.
2. Click **Copy connect command** and run it in a terminal. It looks like:
   ```
   claude mcp add --transport http browser http://127.0.0.1:47823/mcp --header "Authorization: Bearer <token>"
   ```
3. Ask Claude things like *"open my bank's statements page and download last month's PDF"*.

The server listens only on your own computer and needs the secret token. Claude can't see incognito tabs, and
it can't run arbitrary JavaScript unless you turn that on in the same menu. Tabs Claude is driving show an orange dot.

**Claude Desktop** (needs Node.js installed): add this to `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "browser": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://127.0.0.1:47823/mcp", "--header", "Authorization: Bearer <token>"]
    }
  }
}
```

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

```bash
npm version patch          # or minor / major: bumps package.json and creates a tag
git push --follow-tags
```

GitHub Actions builds Windows, macOS and Linux installers, uploads them to a draft release, then publishes it.
Installed browsers pick it up through **Check for updates**.

## License

GPL-3.0. The Chrome extension support library ([electron-chrome-extensions](https://github.com/samuelmaddock/electron-browser-shell))
is GPL-3.0 licensed, so this project is too.
