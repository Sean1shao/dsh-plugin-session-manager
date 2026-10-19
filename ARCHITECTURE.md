# Architecture

This document explains how the plugin plugs into DSH, why it takes the route it does, and which invariants the tests pin. It assumes DSH's Cordis-based plugin model but not any prior knowledge of this package.

## Where the data lives

```
$DSH_HOME/                      # ~/.dsh
├── sessions/
│   └── --D-workplace-demo--/   # one directory per project (encoded from the session's cwd)
│       └── session-<uuid>/     # one directory per session
│           └── session.v4.jsonl.zstd
├── storages/
│   ├── workspace.json          # workspace registry: order, archive set, pin set
│   └── session_projcache/
│       └── sessions/<id>.json  # projection checkpoint, rebuildable
└── attachments/v1/objects/     # content-addressed blobs
```

The JSONL log is the only authoritative copy of a session. Everything else is derived, cached, or an index.

## Why "out-of-band maintenance"

`dsh-session-persistence` states the contract plainly:

> **No delete or retention interface** — pruning stored sessions is out-of-band backend maintenance.

`dsh-workspace` reinforces it on the UI side: removing a workspace registration never touches folders or sessions, and the sidebar can archive but never delete. So a delete feature has to (a) do the filesystem work itself and (b) present it as an explicit, confirmed action. This plugin is that maintenance pass.

## One row, two faces

DSH loads a plugin package through a Loader row:

```yaml
- insert:
    - id: session-manager
      name: 'dsh-plugin-session-manager'
```

* The **host face** is the package entry (`lib/index.js`, ESM). It exports `inject = ['connection']` and `apply(ctx)`, so Cordis mounts it only once the web transport exists and unloads it with its fiber.
* The **browser face** is `lib/client.js`, declared in `package.json` as `dsh.client` with `"platform": "web"`. `dsh-client-modules` scans every active Loader entry, reads that declaration, and serves the bundle at `/plugins/dsh-plugin-session-manager/client.js`.

The two faces only meet through the wire, never through imports: the client bundle runs in a browser module table whose allowed specifiers are frozen (react, react-dom, cordis, client-store, ui-slots, ui-primitives). The row *name* must be exactly the package name — that is how the module scanner attaches the browser half to the row.

## The call path

```
sidebar menu item
  → fetch('POST /api/dsh-session-manager/delete', { sessionId })
  → Connection's /api prefix route (admission: browser cookie, Host/Origin fence)
  → createSharedFetchHandler: exact route match wins over the Typert gateway
  → handleDelete()
```

`ctx.connection.fetch.register({ path, methods, requestBody, fetch })` is a documented public seam: DSH itself uses exact Fetch routes for session-log downloads and raw uploads. Registrations are scoped to the *reading* fiber (Cordis traces service access back to the caller), so unloading the plugin removes the route and re-enabling it can register again.

### Why not Typert Remote

DSH's typed Host↔Client channel needs generated artifacts: `lib/typert.host.js`, `lib/typert.remote-client.js`, zod schemas, and a codegen step that does not exist outside the DSH monorepo. For a single method, that machinery buys type safety we already get from a two-field JSON body, and it would make the package unbuildable by anyone reading the repo. The exact-Fetch channel is the smaller, honest seam.

## Deletion algorithm

```
handleDelete(request):
  body.sessionId        → must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}
  activity              → ctx.waterfall('workspace/session-activity', { sessionId }, () => [])
                          non-empty  → 409 session-active   (no writes)
                          throws     → 500 activity-check-failed (no writes)
  locate                → <root>/<project>/<id>, exact directory-name match
                          missing    → 404 not-found
  rm -rf <session dir>  → EBUSY/EPERM/EACCES → 409 locked, otherwise 500 delete-failed
  purge                 → storages/session_projcache/sessions/<id>.json (best effort)
  → 200 { ok: true, sessionId, deleted }
```

The activity waterfall is the same one `archiveSession` consults, so "has running work" means the same thing here as it does to DSH's own archive guard: a live turn, running subagents, background jobs, or active reminders.

The sessions root resolves in this order: explicit `config.sessionsRoot` → `ctx.sessionPersistence.root` → `$DSH_HOME/sessions`. A client-supplied path is never used.

## Invariants pinned by tests

1. The route is exactly `POST /api/dsh-session-manager/delete`, `requestBody: 'buffered'`.
2. A session with reported activity is never touched — not even a cache purge.
3. A failed activity probe is treated as "unknown", which also means "don't delete".
4. Malformed input (`bad JSON`, traversal-shaped id) never reaches the filesystem.
5. The client bundle stays a `__ModuleLoader__.load({ id, factory })` registration whose factory requires only platform modules, and registers one `sidebar.workspaces.session.menu.item` entry with `order: 500`.
6. The dialog is mounted outside the session row, because closing the menu unmounts the row and would take a row-owned dialog with it.

## Deliberate non-goals

* **No trash bin.** A move-to-trash variant would need a stable location outside `sessions/` that DSH's own scanners ignore; that is a design decision for the host, not a plugin.
* **No workspace-registry surgery.** `workspace.json` keeps a dangling id until the next workspace mutation; DSH filters dangling ids on read, and rewriting the registry from a plugin risks corrupting a two-write durable format.
* **No attachment GC.** Blobs are content-addressed and may be shared, so reference counting belongs to DSH.
* **No live list refresh.** The sidebar is fed by a host projection stream; deleting files emits no event. The plugin reloads the page instead of inventing a private refresh channel.
