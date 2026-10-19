# Contributing

Thanks for taking a look. This is a small plugin; the bar is simple: keep it dependency-free, keep the two faces honest, and prove behavior with tests.

## Setup

There is nothing to install.

```bash
git clone https://github.com/Sean1shao/dsh-plugin-session-manager.git
cd dsh-plugin-session-manager
npm test
```

Node 18.17+ is enough. `npm test` runs `node --test`, which discovers `test/*.test.mjs`.

## Layout

| Path | Face | Rule |
|---|---|---|
| `lib/index.js` | Host (Node ESM) | Only `node:` builtins. No third-party imports — the package must stay installable by copying a folder. |
| `lib/client.js` | Browser (`__ModuleLoader__` lazy CJS) | Only the frozen platform specifiers (`react`, `react-dom/client`, `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`, …). No bundler step: the file *is* the bundle. |
| `cordis.patch.yml` | Composition | One `insert` row whose `name` is exactly the package name. |
| `install.ps1` | Tooling | Must stay compatible with Windows PowerShell 5.1 (UTF-8 **with BOM**, no `$PSScriptRoot` in `param()` defaults). |

## The two contracts that must not break

**1. The browser bundle format.** DSH loads client code as a lazy CJS registration:

```js
window.__ModuleLoader__.load({ id: '<package name>', factory: (require) => { … return module.exports } })
```

The factory receives a `require` that resolves *only* against the shell's shared module table. Adding an import outside that table means adding a `dsh.client.external` entry and a dependency — check first whether a platform module already does the job.

**2. The deletion safety order.** Activity check → locate → remove. Never reorder, and never make the activity probe fail-open: a session must not be deleted while DSH cannot prove it is idle.

## Tests

```bash
npm test
# in constrained environments where the node:test runner cannot spawn children:
node test/host.test.mjs
node test/client.test.mjs
```

* `test/host.test.mjs` builds fake sessions roots in the OS temp directory, drives the registered route with real `Request`/`Response` objects, and fakes only `ctx` (no DSH needed).
* `test/client.test.mjs` installs a fake `window.__ModuleLoader__`, a fake `document`, and a fake shared-module table, then asserts the registration shape and the rendered element tree.

Add a test for every behavior change. A PR that changes the route, the status codes, or the menu registration without touching tests will be asked to add them.

## Pull requests

- One logical change per PR; describe the user-visible effect in the title.
- If you touch the protocol (path, body, status codes), update `README.md`, `README.zh-CN.md`, and `ARCHITECTURE.md`.
- If you touch `install.ps1`, run it against a throwaway profile and verify the install → re-install → uninstall cycle, including the `-Profile` and `-Uninstall` flags.
- Keep comments in the language of the surrounding code; both Chinese and English appear in this repo, so match the file you edit.

## Release checklist

1. Bump `version` in `package.json`.
2. Add a `CHANGELOG.md` entry.
3. Tag: `git tag v0.1.0 && git push --tags`.
4. If publishing to npm, make sure the name is available or switch to a scope (`@you/dsh-plugin-session-manager`), then `npm publish --access public`.
