# Working on this repo

**Zirtola**: a Chromium (Electron) browser. The owner uses **Windows 11 Pro**: design for Windows first,
and keep macOS/Linux working.

## Always ship to `main`
The owner's standing instruction: **push every finished change to `main`**. Each push to `main`
triggers `.github/workflows/release.yml`, which builds all installers and publishes a GitHub
release; that is what the in-app **Check for updates** reads. A change that isn't on `main`
never reaches the owner. (Docs-only changes skip the release.)

Before pushing:
1. `npm run typecheck && npm run build`
2. Exercise the change in the running app (see "Testing" below).
   For anything touching tabs, windows, sleeping, extensions or startup, also run `npm run bench`
   (under `xvfb-run` here) and compare with the table in `docs/SPEC.md` §4. Speed and low memory are
   the browser's core values.
3. After pushing, check the Release workflow run and fix it if it fails.

## Layout
- `src/main`: main process (windows, tabs, sleeping, extensions, blocker, bookmarks, MCP, updater)
- `src/preload`: `ui-preload` (browser UI bridge), `page-preload` (runs in web pages)
- `src/renderer`: browser UI, plain TypeScript, no framework (keep it that way: speed)
- `docs/SPEC.md`: product spec and roadmap. Keep it current.

## Testing in a headless container
- Run under `xvfb-run`. As root Chromium needs `--no-sandbox`, but **extension service workers
  only get the full chrome.* API with the sandbox on**: test extensions as a non-root user
  without `--no-sandbox`.
- Enable MCP in `settings.json` (`mcp.enabled`, `mcp.token`, `mcp.allowEvaluate`) and drive
  the app over `http://127.0.0.1:47823/mcp` to test real behavior.
- Point `XDG_CONFIG_HOME` at a scratch dir to get a throwaway profile.
