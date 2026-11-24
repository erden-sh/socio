---
title: 'Service accounts'
description: 'Give company-owned scripts limited REST access with revocable keys.'
---

A service account is a workspace identity for automation. It has its own attribution and uses an API key rather than a browser password, passkey or sign-in link. It can be a member or admin, never an operator, and it cannot chat with socios.

Use it for an unattended integration owned by the team. For an external assistant acting for a person, use [connected-agent OAuth grants](/docs/admin/connected-agents) instead.

## Create the account and key

Open **Settings → People**, the **Service accounts** tab, create a descriptive account, and choose the least powerful role that works. Choose **New key** on the account and name the key for the place it will run. Select scopes and a lifetime of 30, 90 or 365 days. Each key shows who made it, when, when it was last used and from where, and when it expires; **Disable** is in the account's **⋯** menu.

The key is shown once. Copy it directly into the receiving service's secret store; the app keeps its hash, not a recoverable copy. Do not paste it into a shared page, chat or issue. A key starts with `cbk_`, but its appearance does not prove that it is active or correctly scoped.

## Match scopes to the task

- `issues:read` lists, searches and reads board items and permitted attachments.
- `issues:write` files issues, comments and attachments and updates fields allowed by the account's role.
- `pages:read` lists and reads Spaces' pages and searches them: Spaces open to the whole workspace, and private ones only for an admin account or one added to the Space.

Keys use the scoped REST API, not the chat runtime or inbound MCP endpoint. Scopes do not grant workspace settings or service-account administration. An account with a member role still cannot change administrative issue fields with an issues-writing key.

Send a key in the Authorization bearer header. JSON writes need `Content-Type: application/json`. Verify identity through `GET /api/service/whoami` before performing writes. Lists contain excerpts; read an individual item or page for its full content. A `401` with `bad_key` means the key is invalid, expired, revoked or disabled; `403` with `scope` means the request exceeds its scope. Requests are rate limited.

## Rotate and retire

Inspect last-use information to find stale keys. Create a replacement, update the one intended consumer and verify it before revoking the old key. Revoke lost keys immediately. Disabling the service account revokes all its keys while keeping its existing records attributed to it. Inventory both role and scope when reviewing access.
