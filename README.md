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
| `maxRestarts` | `3` | consecutive restart attempts before giving up; reset only after readiness followed by at least 60 s of running (exponential backoff, capped at 60 s) |
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
- **One owner per canonical root.** Roots are resolved through `realpath`, so
  directory aliases share ownership. Under `%TEMP%\dsh-graphify-watch` on Windows
  (`os.tmpdir()` elsewhere), each root's hashed `.lock` path is a nonempty
  directory containing exactly one `owner-<pid>-<uuid>` marker. Ownership is
  acquired by atomically renaming a private prepared directory into place;
  competing processes cannot replace a published nonempty owner directory.
  New-format dead-owner markers are reclaimed only when explicitly marked idle.
  Before spawning, the owner records possible watcher activity; it clears that
  activity only after confirming process-tree cleanup. If the host crashes while
  a watcher may still exist, automatic takeover is refused: confirm that tree has
  stopped before clearing the stale lock. A legacy PID lock file
  still blocks acquisition while its PID is alive; a dead or invalid legacy PID
  file is conservatively retained, with a warning to confirm the old watcher has
  stopped before manually removing that file. Unrecognized or inaccessible locks
  also prevent startup. Graphify itself writes atomically but has no equivalent
  cross-process ownership guard.
- **Restart attempts count consecutive failures.** The initial launch is followed
  by at most `maxRestarts` retries (default `3`). A watcher must report readiness
  and keep running for at least 60 seconds before its subsequent exit resets that
  budget. Brief readiness does not reset a crash loop. Backoff doubles from
  `restartBackoffMs`, up to 60 seconds. Exhaustion logs a warning and requires a
  plugin reload after the cause is fixed.
- **Teardown is awaitable and kills the tree.** The `ctx.effect` disposer returns
  a Promise: `await disposer()` waits for tree termination and the child's `close`
  event before releasing ownership. On Windows a bundled PowerShell runner joins
  a Job Object with `KILL_ON_JOB_CLOSE` before starting graphify. All descendants
  inherit that job, including detached descendants and processes whose ancestors
  have exited. Node terminates the runner through its process handle; Windows
  closes the job and terminates remaining members. PowerShell and the Windows
  .NET compiler are used at startup; no package install or build step is needed.
  Unix uses a dedicated process group with bounded TERM/KILL cleanup. A 3-second
  grace period bounds close and signal delivery. If termination or lock release
  cannot be confirmed, ownership is retained to prevent a second watcher. A
  remount waits for in-flight teardown. Failed teardown requires process inspection
  and a host restart after resolving the failure; plugin reload alone does not
  erase retained ownership.
- **A lifecycle hook is required.** If the host has no `ctx.effect`, the plugin
  logs a warning and starts no watcher, because it cannot arrange managed unload.
- **No dependencies, no build step.** The plugin deliberately does not use
  `@deepseek-ai/schemastery`, so it declares no peer range and cannot be blocked
  by DSH's version-compatibility gate.

## Tests

Run the unit suite without DSH, graphify, dependencies, or a build step:

```powershell
node --test test/*.test.mjs
```

The standalone integration tests require `graphify` on `PATH` and an explicitly
supplied **disposable, already indexed scratch project** with
`graphify-out/graph.json`, `src/store.py`, and `README.md`. They append unique
Python symbols; smoke also appends a document probe and removes any pre-existing
`needs_update` flag. The scratch edits and generated outputs remain for inspection.
Run them **serially**, with no other watcher using that scratch root:

```powershell
node test/smoke.mjs      <root>   # fresh doc event, real symbol node, awaited teardown
node test/resilience.mjs <root>   # fresh restart generation, topology update, ownership
```

Both require `<root>` (no implicit working-directory fallback) and exit nonzero
on any failed assertion. Smoke waits for this document event's completed flag
write and checks unchanged graph content and mtime through additional debounce
cycles. Resilience accepts readiness only after the replacement launch, then
edits code to prove that generation works. Both await their disposer in `finally`
and verify that every observed launcher and descendant PID disappears, using
PowerShell/CIM on Windows or `ps` on Unix. A stop log alone cannot pass teardown.

## Uninstall

Disable the bundle in the Plugins page (or remove the row) and restart DSH. The
plugin's `ctx.effect` disposer returns a Promise; hosts should await it to confirm
that every managed watcher has closed and its ownership has been released. A
failed teardown logs a warning and retains ownership for manual investigation.
