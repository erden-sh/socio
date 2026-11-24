# Service accounts (machine-to-machine access)

External agents and scripts reach Socio as **service accounts** (CB-57). A service account is a workspace user that:

- uses an API key, and never signs in with a password, passkey or link;
- is a member or an admin, never an operator;
- can't chat with socios.

Admins manage service accounts under **Account → Service accounts**: add an account, make keys, revoke keys, change the role, or disable the account.

## Keys

- **Format:** `cbk_` followed by 43 characters. A key is shown once, when it's made; the app stores only its SHA-256.
- **Each key has:**
    - a name: where it runs;
    - scopes: what it may reach;
    - a lifetime of 30, 90 or 365 days.
- **Last use:** the time and address of the key's last request show next to it. They're updated at most once a minute.
- **Rate limit:** 300 requests a minute per key; more get a 429.
- **Disabling an account** revokes all its keys. Its issues and comments stay attributed to it.

## Requests

Send the key as a bearer token:

```sh
curl -s -H "Authorization: Bearer $CB_KEY" https://brain.example.test/api/service/whoami
curl -s -H "Authorization: Bearer $CB_KEY" "https://brain.example.test/api/issues?status=triage"
curl -s -H "Authorization: Bearer $CB_KEY" -H "Content-Type: application/json" \
  -d '{"title":"Something broke","body":"Steps…","kind":"bug","area":"client"}' \
  https://brain.example.test/api/issues
```

- **No browser checks:** a browser never sends a bearer header on its own, so key requests skip the origin and cross-site checks that protect people's cookies.
- **Still applied:** the host check, and `Content-Type: application/json` on writes.
- **Responses:**
    - `401`, `code: "bad_key"`: the key is invalid, expired or revoked, or its account is disabled.
    - `403`, `code: "scope"`: the request is outside the key's scopes.

## Scopes

Anything not listed here is refused. That includes `/api/auth/*`, the chat runtime, the workspace and settings, and the service-account admin routes.

| Scope          | Allows                                                                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| (any key)      | `GET /api/service/whoami`                                                                                                                       |
| `issues:read`  | `GET /api/issues`, `/api/issues/titles`, `/api/issues/search`, `/api/issues/:number`, `/api/issues/export.md`, `/api/issue-attachments/:id`     |
| `issues:write` | `POST /api/issues`; `PATCH /api/issues/:number`; `POST`/`PATCH` comments; `POST` attachments (not import)                                       |
| `pages:read`   | `GET /api/spaces/:spaceId/pages`, `/api/spaces/:spaceId/pages/:id`, `/api/spaces/:spaceId/page-tree`, `/api/pages/titles`, `/api/spaces/search` |

Lists carry summaries, not bodies: `GET /api/issues` gives each issue an `excerpt` instead of its description, and `GET /api/spaces/:spaceId/pages` each page an `excerpt` instead of its content. Read one issue or page for the full text.

Within its scopes, a key can do what its account's role allows. For example, only an admin account can change an issue's status, and a private Space's pages are read only by an admin account or one added to that Space (CB-181); to anyone else it is a 404, as a Space that isn't there.

## Code

- `src/server/service-accounts/service-accounts.ts`: the store, scope rules and key resolution.
- `src/server/service-accounts/service-account-routes.ts`: the admin routes and `whoami`.
- `src/server/app.ts`: the bearer middleware.
- `packages/client/src/modules/settings/ServiceAccountsSection.tsx`: the admin UI.
- Tables `service_accounts` and `service_keys` (workspace migration 4).
