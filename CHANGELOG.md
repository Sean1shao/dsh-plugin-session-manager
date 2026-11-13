# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Synchronize session deletion with the workspace sidebar and active chat on DSH `0.2.2-rc.1` ([#1](https://github.com/Sean1shao/dsh-plugin-session-manager/issues/1)).
- Accept the empty patch list generated for a fresh DSH profile in the Windows installer.

## [0.1.0] - 2026-10-19

### Added

- **Delete session** action in the sidebar session row menu
  (`sidebar.workspaces.session.menu.item`, order 500, danger styling,
  own group after *Copy session ID*).
- Confirmation dialog mounted independently of the session row, so it
  survives the menu closing.
- Host endpoint `POST /api/dsh-session-manager/delete` on DSH's Connection
  exact-Fetch registry, with browser authentication and Host/Origin fencing
  inherited from DSH.
- Safety gate: the session must be reported idle by DSH's
  `workspace/session-activity` waterfall. A non-empty answer returns
  `409 session-active`; a failed probe returns `500 activity-check-failed`.
  Neither writes anything.
- Path traversal guard on `sessionId`, plus `409 locked` for files still in
  use and `404 not-found` for missing logs.
- Best-effort purge of the session's projection cache record
  (`storages/session_projcache/sessions/<id>.json`), controllable with
  `purgeCache`.
- `sessionsRoot` configuration; defaults to `sessionPersistence.root` and
  then `$DSH_HOME/sessions`.
- `install.ps1` for Windows profiles (copy + marked `cordis.patch.yml` row),
  with idempotent install and `-Uninstall`.
- `node:test` suites for both faces (16 assertions groups), runnable without
  DSH.

### Fixed

- `install.ps1` no longer reads `$PSScriptRoot` inside `param()` defaults.
  With `[CmdletBinding()]` on Windows PowerShell 5.1 that value is still empty
  during parameter binding, which made `-Source` an empty string and produced
  `GetFullPath … The path is not of a legal form`. Paths are now resolved in
  the script body, with explicit diagnostics and `~` expansion.

[Unreleased]: https://github.com/Sean1shao/dsh-plugin-session-manager/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Sean1shao/dsh-plugin-session-manager/releases/tag/v0.1.0
