# AGENTS.md

## Cursor Cloud specific instructions

This repo is a dependency-free static monorepo containing two vanilla-JS HTML5 canvas
toys: `aria/` and `forest/`. There is no package manager, no build step, no backend, and
no environment variables. `node`, `python3`, and Chrome are all preinstalled, so the
startup update script is effectively a no-op.

### Services (both are static sites — serve the folder over HTTP)

| Service | Run command | URL |
|---|---|---|
| Aria (`aria/`) | `cd aria && python3 -m http.server 8000` | http://localhost:8000 |
| Forest (`forest/`) | `cd forest && python3 -m http.server 8001` | http://localhost:8001 |

Serving over HTTP is required (not `file://`): both apps use `<script type="module">`,
which browsers block over the `file://` protocol.

### Tests / lint

There is no linter. The only automated tests are per-app headless-Chrome smoke tests
(`aria/smoke-test.mjs`, `forest/smoke-test.mjs`) which serve the app, screenshot it, and
fail on console errors. Run them one at a time — both hardcode port `8123`.

Gotcha: the `google-chrome` on `PATH` (`/usr/local/bin/google-chrome`) is a computer-use
wrapper that forces a fixed `--user-data-dir` and `--remote-debugging-port=9222`. The
smoke tests invoke bare `google-chrome`, so under the wrapper they join the existing
persistent Chrome instance and hang instead of taking the headless screenshot. Point
`google-chrome` at the real binary for tests:

```bash
mkdir -p /tmp/chrome-shim && ln -sf /usr/bin/google-chrome-stable /tmp/chrome-shim/google-chrome
cd aria   && PATH=/tmp/chrome-shim:$PATH node smoke-test.mjs
cd forest && PATH=/tmp/chrome-shim:$PATH node smoke-test.mjs
```

`/tmp` is wiped between VM restarts, so recreate the shim each session (or add
`/tmp/chrome-shim` to `PATH` before running). Screenshots land at `<app>/smoke-shot.png`
(git-ignored).

### Deploy (reference only, not needed locally)

Only Aria is wired for CI: `.github/workflows/deploy-pages.yml` publishes `aria/` to
GitHub Pages. `aria/vercel.json` supports optional Vercel deploys. Forest has no deploy
pipeline. See `aria/README.md` and `forest/README.md` for details.
