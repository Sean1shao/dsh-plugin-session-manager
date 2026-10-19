# dsh-plugin-session-manager

[![CI](https://github.com/Sean1shao/dsh-plugin-session-manager/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Sean1shao/dsh-plugin-session-manager/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A **Delete session** action for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) sidebar.

DSH ships *archive* — which hides a session and keeps every byte — but no delete. Session logs are only removed by out-of-band file maintenance. This plugin adds the missing action as a regular sidebar menu item, with a confirmation dialog and a host-side guard that refuses to touch a session that is still running work.

[中文说明](README.zh-CN.md)

```
Session row → ⋯
├── Pin                100
├── Rename             200
├── Fork               300
├── Archive            400
├── Copy session ID    450
└── Delete session     500  ← this plugin (danger styling, own group)
```

**Status:** 0.1.0 — young. The host route, the deletion logic, and loading of the
browser bundle are covered by tests and were checked against a real profile; the
menu entry itself is exercised by hand. DSH's plugin surface is still moving, so
pin the DSH version you tested against.

## Requirements

- DSH Desktop or `dsh --profile web`.
  Built against **DSH Desktop 44.7.0** (`@deepseek-ai/dsh-*` 0.2.1-rc.2).
- Windows PowerShell 5.1+ for the installer. Manual installation works on macOS and Linux too.
- No runtime dependencies: the host half imports only `node:fs`, `node:os` and `node:path`.

## Install

The plugin lives in a DSH *profile*: its `package.json` lists bundles, and `cordis.patch.yml` holds the composition rows.

### Windows

```powershell
# 1. Quit DSH completely (tray menu; closing the window may only minimize)
# 2. Clone and install into the current profile
git clone https://github.com/Sean1shao/dsh-plugin-session-manager.git
cd dsh-plugin-session-manager
powershell -ExecutionPolicy Bypass -File .\install.ps1
# 3. Start DSH again
```

`install.ps1` copies this package to `<profile>\node_modules\dsh-plugin-session-manager` and appends a marked `insert` row to `<profile>\cordis.patch.yml`. Both steps are idempotent; `-Uninstall` reverses them exactly.

```powershell
# another profile, or a profile elsewhere
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profile 'D:\dsh-home\profiles\web'
# remove
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
```

### macOS / Linux (manual)

```bash
# run from inside the cloned repository
git clone https://github.com/Sean1shao/dsh-plugin-session-manager.git
cd dsh-plugin-session-manager
PROFILE="${DSH_HOME:-$HOME/.dsh}/profiles/desktop"
mkdir -p "$PROFILE/node_modules"
cp -R . "$PROFILE/node_modules/dsh-plugin-session-manager"
cat >> "$PROFILE/cordis.patch.yml" <<'YAML'

- insert:
    - id: session-manager
      name: 'dsh-plugin-session-manager'
YAML
```

Restart DSH. The profile directory defaults to `%USERPROFILE%\.dsh\profiles\desktop` on Windows and `~/.dsh/profiles/desktop` elsewhere; check `DSH_PROFILE_DIR` if you are unsure.

## Usage

Hover a session row → `⋯` → **Delete session** → confirm.

- If the session still has work running (a turn, live subagents, background jobs, reminders), the host refuses and reports how many activities are pending. Stop them first.
- On success the page reloads once. The sidebar's membership comes from a host projection stream, and deleting files emits no event, so a reload is the honest way to get a clean list.
- If the log file is in use (for example the session is open and still writing), you get `409 locked`; close the session and retry.

## What gets deleted

| Path | What it is |
|---|---|
| `<sessions root>\<project dir>\<session id>\` | the append-only session log — the only authoritative data |
| `~/.dsh/storages/session_projcache/sessions/<id>.json` | that session's projection checkpoint (best effort; the cache is fail-soft) |

The sessions root is `$DSH_HOME/sessions` by default (usually `~/.dsh/sessions`).

**Not** deleted: the workspace directory and its files, the workspace registry (`workspace.json`), other sessions, and attachment objects (`attachments/v1/objects`, content-addressed and possibly shared).

## Safety model

Deletion is irreversible, so the host half never trusts the client:

1. `sessionId` must match `[A-Za-z0-9][A-Za-z0-9._-]{0,127}` — no path traversal.
2. `workspace/session-activity` is asked first. Any reported activity → `409 session-active`, **nothing is written**. If the check itself fails → `500`, also nothing.
3. Only then is the log directory located by exact name match and removed.
4. The projection cache record is purged best-effort and never blocks the result.

All of this sits behind Connection's `/api` route, so it inherits browser authentication, the Host/Origin fence, and fiber-scoped lifecycle (unloading the plugin removes the route).

## Configuration

```yaml
- id: session-manager
  config:
    # Explicit sessions root. Defaults to sessionPersistence.root, then $DSH_HOME/sessions.
    sessionsRoot: 'D:\somewhere\sessions'
    # Also purge the projection cache record. Default: true.
    purgeCache: true
```

## How it works

One Loader row carries two faces:

| Face | File | Role |
|---|---|---|
| Host | [`lib/index.js`](lib/index.js) | registers `POST /api/dsh-session-manager/delete` on the Connection exact-Fetch registry |
| Browser | [`lib/client.js`](lib/client.js) | a `__ModuleLoader__` lazy-CJS bundle that contributes to the `sidebar.workspaces.session.menu.item` slot |

Why not Typert Remote? A single action does not justify generated descriptors and codecs; DSH already uses the exact-Fetch channel for session-log downloads and raw uploads. Details in [ARCHITECTURE.md](ARCHITECTURE.md).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `GetFullPath … The path is not of a legal form` | You are on the 0.1.0-pre installer. The current script resolves `$PSScriptRoot` inside the body; the old one read it during parameter binding, where PowerShell 5.1 leaves it empty. Nothing was written. Re-run. |
| `… is not digitally signed` | Run with `powershell -ExecutionPolicy Bypass -File .\install.ps1`. |
| No **Delete session** entry after install | Did you fully quit and restart DSH? Does `<profile>\cordis.patch.yml` contain the `session-manager` row? Check the Plugins page for a load failure. |
| `404 not-found` | The session was already deleted, or its id is escaped into a directory name this plugin does not decode. |
| `409 session-active` | Stop the session's work (turn / subagents / jobs / schedules) first. |

## Development

```
lib/index.js      host face — route + deletion logic
lib/client.js     browser face — __ModuleLoader__ bundle, menu item + dialog
cordis.patch.yml  composition row (used when installed as a bundle)
test/             node:test suites
```

```bash
npm test
# or one file at a time:
node test/host.test.mjs
node test/client.test.mjs
```

Neither suite needs DSH running: the host suite drives the registered route through a fake context, and the client suite loads the bundle with a fake `__ModuleLoader__` and a fake shared-module table. See [CONTRIBUTING.md](CONTRIBUTING.md) for the two contracts that must not break.

## License

[MIT](LICENSE)
