# dsh-plugin-graphify-watch

Keeps one `graphify watch` process alive per configured root, so a code change
rebuilds the graphify knowledge graph automatically — whoever made it: a DSH file
tool, an external editor, a shell command, or a `git checkout`.

## Why supervise instead of detect

`graphify watch` already owns the whole decision surface: the extension filter,
`.graphifyignore`, skipping dot directories and `graphify-out/`, batch debounce,
the code-vs-doc split, deletion eviction, and the `needs_update` flag. Watching
the real filesystem is also the only way to see changes DSH did not make itself —
the harness `workspace/changes` signal is derived from git snapshots plus
file-tool captures, so a shell-only edit is invisible to it.

So this plugin detects nothing. It owns lifecycle only: start, log, restart on
crash, and kill the whole process tree on unload.

## What it does per root

| Root state | Plugin behaviour |
|---|---|
| has `graphify-out/graph.json` | spawn `graphify watch <root>` |
| no `graphify-out/graph.json` | skip, with a log line telling you to run `/graphify` there first |
| already watched by this process | skip (`this process already watches it`) |
| already watched by another process | skip (`already watched by process <pid>`) |

Code edits rebuild `graph.json` + `GRAPH_REPORT.md` with no LLM. Doc, PDF and
image edits leave the graph alone and write `graphify-out/needs_update`; the
plugin surfaces that line with a reminder to run `/graphify --update`.

## Configuration

| key | default | meaning |
|---|---|---|
| `enabled` | `true` | set `false` to keep the row but start nothing |
| `roots` | `[]` | absolute project paths to watch. **Empty means "use the host working directory, and only if it is already indexed"** — set this explicitly in practice |
| `exePath` | `""` | explicit path to `graphify`; empty searches `PATH` |
| `maxRestarts` | `3` | consecutive restart attempts before giving up (exponential backoff, capped at 60 s) |
| `restartBackoffMs` | `2000` | first backoff delay |
| `logRebuilds` | `true` | log every watcher line; the one-time readiness banner is always logged |

Point it at your projects by overriding this row in
`~/.dsh/profiles/desktop/cordis.patch.yml`. **An override replaces the row's whole
`config`, so restate every field you want to keep:**

```yaml
- id: graphify-watch
  name: dsh-plugin-graphify-watch
  config:
    enabled: true
    roots:
      - C:\Users\Administrator\Documents\my-project
    exePath: ""
    maxRestarts: 3
    restartBackoffMs: 2000
    logRebuilds: true
```

## Install

The `desktop` profile is reserved for the Electron shell, so the plain npm `dsh`
CLI refuses to manage it. Use the app.

1. Open the sidebar's **Plugins** page.
2. **Add plugin** → `C:\documents\dsh\dsh-plugin-graphify-watch` (an absolute
   local path is accepted).
3. Enable the `dsh-plugin-graphify-watch` bundle.
4. **Restart DSH.** Adding a `file:` dependency link needs a process restart —
   Node caches real paths.

Manual equivalent, if the UI path is unavailable (run from the profile
directory, which is the pnpm project):

```powershell
cd ~\.dsh\profiles\desktop
# add to dependencies:  "dsh-plugin-graphify-watch": "file:C:/documents/dsh/dsh-plugin-graphify-watch"
# append to dsh.profile.bundles:  "dsh-plugin-graphify-watch"
node "C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness\resources\runtime\pnpm\bin\pnpm.cjs" install
# then restart DSH
```

## Verify

```powershell
# the watcher should be running (a graphify.exe plus its Python child)
Get-CimInstance Win32_Process -Filter "Name='graphify.exe'" | Select-Object ProcessId,CommandLine

# touching a real symbol must rewrite the graph
Add-Content <root>\src\thing.py "`ndef probe():`n    return 1`n"
(Get-Item <root>\graphify-out\graph.json).LastWriteTime
```

A comment-only edit is *not* enough: graphify correctly reports
`No code-graph topology changes detected; outputs left untouched`.

## Behaviour worth knowing

- **Debounce is graphify's own 3 seconds.** `--debounce` exists only on the module
  entry point (`python -m graphify.watch`), not on the `graphify` CLI, so this
  plugin does not pretend to configure it.
- **The document layer stays manual.** Refreshing docs, PDFs and images needs an
  LLM pass, so it remains an explicit `/graphify --update`. Automating it is
  possible (headless `graphify extract --backend` against a local
  OpenAI-compatible endpoint) but costs tokens unattended, so it is deliberately
  out of scope here.
- **One owner per root.** A lock file under `%TEMP%\dsh-graphify-watch` holds the
  owning pid, so two DSH windows cannot both rewrite the same `graph.json` —
  graphify writes atomically but holds no cross-process lock, and its shrink
  guard would reject the loser's write.
- **Teardown kills the tree.** `graphify.exe` from `uv tool install` is a launcher
  that starts the venv Python as a child, so the plugin uses `taskkill /T /F` on
  Windows rather than killing only the launcher.
- **No dependencies, no build step.** The plugin deliberately does not use
  `@deepseek-ai/schemastery`, so it declares no peer range and cannot be blocked
  by DSH's version-compatibility gate.

## Tests

Both run standalone against a real scratch project; no DSH needed.

```powershell
node test/smoke.mjs      <root>   # start, code rebuild, doc flag, teardown
node test/resilience.mjs <root>   # crash restart, duplicate-root refusal, lock
```

## Uninstall

Disable the bundle in the Plugins page (or remove the row) and restart DSH. The
plugin's `ctx.effect` disposer stops every watcher it started, so no `graphify`
process is left behind.
