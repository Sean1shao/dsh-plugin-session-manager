---
name: Bug report
about: Something broke — wrong delete target, refused action, crash, or nothing appears
title: ''
labels: bug
assignees: ''
---

## What happened

<!-- A clear description of the bug. -->

## What you expected

## Steps to reproduce

1.
2.
3.

## Environment

| | |
|---|---|
| DSH version (Help → About, or the app `version` file) | |
| OS and version | |
| Profile | `desktop` / `web` / other: |
| Install method | `install.ps1` / manual copy / other: |

## Diagnostics

<!--
Please include:
- The Network entry for POST /api/dsh-session-manager/delete (status + response body), if the menu item appears but the action fails.
- The `<profile>\cordis.patch.yml` tail where the `session-manager` row was added.
- Any DSH log lines mentioning `session-manager`.
- The Plugins page state if the entry is missing.
-->

```
paste here
```

## Is this a data-loss issue?

<!-- If a session was deleted that you did not intend to delete, say so first and
     keep a copy of `%USERPROFILE%\.dsh\sessions` before doing anything else. -->
