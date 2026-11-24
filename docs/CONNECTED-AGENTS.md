# Connected agents (an agent acting for a person)

A **connected agent** is an agent a person runs elsewhere, such as Claude Code, Cursor or VS Code, that acts in Socio **for that person** (CB-90). The person connects it once, approves it in the browser, and from then on it works through the MCP endpoint at `/mcp`.

Every action records both identities, as for socios (CB-31):

- **the agent:** its OAuth client (`client_id`) and the grant, with the person's label for it, such as "Claude Code on my laptop";
- **the person** who approved the grant.

It shows as "Claude Code on my laptop for Ada". An agent never does more than its person could, and never acts as anyone else.

Connected agents need Better Auth (`AUTH_PROVIDER=betterauth`). With mock auth there is no authorization server.

## How it differs from service accounts

|                  | Connected agent                                                     | [Service account](SERVICE-ACCOUNTS.md)    |
| ---------------- | ------------------------------------------------------------------- | ----------------------------------------- |
| Acts as          | the person who approved it                                          | itself, a workspace user of its own       |
| Owned by         | that person                                                         | the company (admins)                      |
| Set up by        | the person, in the browser (OAuth consent)                          | an admin, who copies a `cbk_` key         |
| Credentials      | short-lived access tokens, rotating refresh                         | an API key for 30 to 365 days             |
| Reaches          | `/mcp` (MCP tools)                                                  | `/api` (scoped REST routes)               |
| Effective access | the grant's scopes, then the person's role                          | the key's scopes, then the account's role |
| Ends when        | the person or an admin disconnects it, or the person is deactivated | the key expires or is revoked             |

Use a service account for unattended, company-owned automation. Use a connected agent when a person brings their own agent's work into the workspace.

## Connect Claude Code

```sh
claude mcp add --transport http socio https://<host>/mcp
```

Then, in Claude Code, run `/mcp`, pick `company-brain` and choose to authenticate. Your browser opens on the workspace:

1. Sign in, if you aren't already. You come back to the request afterwards.
2. The consent screen shows the agent's name and logo, the **domain** its details come from, what it may do, and your own name. Claude Code's redirect goes back to your computer, so it is marked **Unverified local app**: any program there can claim to be it. Approve only a connection you just started.
3. Name the connection (it defaults to the agent's name), for example "Claude Code on my laptop", and choose **Approve**. **Deny** tells the agent no.

The browser goes back to Claude Code, which now has the workspace's tools.

Other MCP clients connect the same way: give them `https://<host>/mcp`. The client must support the MCP authorization spec with Client ID Metadata Documents (CIMD).

## Grants

A **grant** is one person's approval of one agent. Each approval is a grant of its own, so the same agent on two computers is two grants with two labels.

- **Each grant has:** the client (its id, name, and domain, or "unverified local app"), the person's label, the scopes, when it was created and last used (written at most once a minute), and its revocation.
- **Account → Connected agents:** each person lists their grants (agent, domain, label, scopes, connected, last used) and disconnects them.
- **Admin → Connected agents** (`/admin/agents`): admins list everyone's grants, with the person and last use, and disconnect any. Disconnecting is audited.
- **Disconnecting** a grant deletes its access and refresh tokens at once: the agent's next request is refused.
- **Deactivating a person** disconnects all their agents; reactivating them doesn't bring the agents back.
- **Allowed client domains** (Admin → Connected agents): off by default. When set, only agents whose metadata comes from those domains, or their subdomains, can connect, and existing grants for other domains stop working. A local app's domain is only what it claims.

## Scopes

| Scope            | Allows                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `issues:read`    | search, list and read issues and their comments                                               |
| `issues:write`   | file issues, comment, vote, and change the fields the person may change (status: admins only) |
| `pages:read`     | read Spaces, their page trees, and search them                                                |
| `offline_access` | a refresh token, so the agent stays connected without asking again                            |

A scope outside this list is refused (`invalid_scope`), and so is `openid`. Effective access is the grant's scopes, then the person's role: a member's agent can't change an issue's status.

## The authorization server

Better Auth's OAuth provider plugin (`@better-auth/oauth-provider`), set up for the MCP authorization spec (2026-07-28):

- **OAuth 2.1 authorization code with PKCE.** PKCE is required, S256 only.
- **Refresh tokens rotate.** Each refresh returns a new pair; the used refresh token stops working. Access tokens last an hour, refresh tokens 30 days.
- **Tokens are opaque and stored hashed** (SHA-256): access tokens start `cbat_`, refresh tokens `cbrt_`.
- **Resource indicators (RFC 8707).** Tokens are bound to `https://<host>/mcp`. The authorization request must name it as `resource`; a token for another resource is refused.
- **Clients register by their Client ID Metadata Document.** The `client_id` is an https URL, which the server fetches for the client's name, logo and redirect URIs. Dynamic Client Registration is off.
- **Every authorization shows the consent screen.** Nothing is approved silently.

### Discovery

| URL                                                                                                | What                                                                                         |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `/.well-known/oauth-protected-resource/mcp` (and `/.well-known/oauth-protected-resource`)          | Protected Resource Metadata (RFC 9728) for `/mcp`                                            |
| `/.well-known/oauth-authorization-server/api/auth` (and `/.well-known/oauth-authorization-server`) | Authorization server metadata (RFC 8414), with `client_id_metadata_document_supported: true` |
| `/api/auth/oauth2/authorize`, `/api/auth/oauth2/token`, `/api/auth/oauth2/revoke`                  | The endpoints; the issuer is `https://<host>/api/auth`                                       |

A `401` from `/mcp` carries `WWW-Authenticate: Bearer resource_metadata="https://<host>/.well-known/oauth-protected-resource/mcp", scope="…"`.

### Fetching client metadata safely

A client id is a URL the server fetches, so the fetch is guarded against request forgery (`src/server/agents/cimd.ts`):

- **https only,** on the standard port, with a path, on a named host (not an IP address, `localhost` or `.local`).
- **Public addresses only.** The host name is resolved first, and every address must be public: no loopback, private, link-local or CGNAT ranges, nor their IPv6 equivalents. The connection is pinned to the checked address, so DNS can't change its answer in between.
- **No redirects:** a 3xx is refused, not followed.
- **At most 8 KB, within 5 seconds,** JSON, uncompressed.
- **Cached** as its `Cache-Control` says, between one minute and a day (five minutes without one), up to 200 documents. A stored client is used for up to a day while its document can't be fetched.
- **Checked:** the document's `client_id` must be its own URL; it must be a public client (`token_endpoint_auth_method: none`), set no secret, and list redirect URIs that are https, loopback http, or an app's own scheme.
- **Redirect URIs match the document exactly.** The one allowance (RFC 8252): a loopback `http` redirect the document lists without a port matches on any port.

## For the MCP endpoint

`platform.agentGrants.resolve(token, resource)` is the `AgentTokenResolver` (`src/server/agents/actor.ts`). Call it with the bearer token and `mcpResource(origin)` (`src/server/agents/oauth.ts`), the canonical URL of `/mcp`:

```ts
const actor = await platform.agentGrants.resolve(bearer, mcpResource(origin));
if (!actor) return 401 with WWW-Authenticate: agentChallenge(origin, 'invalid_token');
if (!platform.agentGrants.take(actor.grantId)) return 429; // 300 a minute per grant
```

It returns the `AgentActor` (grant, client, label, person and scopes), or null when the token is missing, unknown, expired or revoked, for another resource, its grant was disconnected, its client's domain isn't allowed, or its person is deactivated. It checks the database on every call, so a disconnect takes effect on the next request.

## Code

- `src/server/agents/actor.ts`: the shared contract (`AgentActor`, `AgentScope`, `AgentTokenResolver`).
- `src/server/agents/oauth.ts`: the plugin's options, discovery documents and the challenge.
- `src/server/agents/cimd.ts`: the safe metadata fetch and its checks.
- `src/server/agents/grants.ts`: grants, the resolver, revocation and the allowlist; table `agent_grants` and `agent_settings` (agent-grants migration 1).
- `src/server/agents/routes.ts`: the account and admin routes.
- `src/server/auth/better-auth.ts`: the plugin, the well-known routes and the consent endpoint (`/api/agent-consent`). The plugin's tables are `auth_oauth_*` (auth migration 3).
- `packages/client/src/views/ConnectAgent.tsx`: the consent screen (`/connect`) and the way back after sign-in (`/connect/continue`).
- `packages/client/src/modules/settings/ConnectedAgentsSection.tsx` and `packages/client/src/modules/agents/`: Account and Admin → Connected agents.

Later: the device authorization grant (RFC 8628) for agents without a browser, creating the same grants.

## MCP tools

The brain's MCP endpoint is `/mcp` on the app's origin (for example `https://brain.example.test/mcp`). It speaks Streamable HTTP in stateless mode: every request is a JSON-RPC `POST` with JSON answers, and there are no sessions or event streams (`GET` and `DELETE` get 405).

**Access**

- Every request needs `Authorization: Bearer <access token>` from a grant. Without one, or with a token that is invalid, expired, revoked or meant for another resource, the answer is 401 with `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"`, so the client can find the authorization server and sign in.
- Service-account keys (`cbk_`) and data tokens are refused here; they work only under `/api`.
- The host must be one the app answers on. A request from a browser must come from the app's own origin.
- Each grant is limited to 300 requests a minute (429 after that, with `Retry-After: 60`).
- Until the authorization side is set up, `/mcp` answers 503 "Connected agents are not set up".

**Who the agent acts as**

The agent always acts as the person who approved the grant. It can do only what both the grant's scopes and that person's role allow, through the same checks as the web app. A member's agent can't change an item's status, priority or owner, because a member can't. The agent can never act as anyone else.

`tools/list` shows only the tools within the grant's scopes. If an agent calls a tool its grant lacks, the answer is 403 with `WWW-Authenticate: Bearer error="insufficient_scope", scope="<the missing scope>", ...`, and nothing runs.

| Scope          | Tools                                                                                                                                        |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `issues:read`  | `search_issues` (open, closed or all), `read_issue`, `read_issue_attachment`, `list_issues` (filters, sort, paging), `list_issue_components` |
| `issues:write` | `file_issue`, `comment_on_issue`, `vote_on_issue`, `unvote_issue`, `update_issue`                                                            |
| `pages:read`   | `list_spaces`, `list_pages` (a Space's page tree), `search_pages`, `read_page`, in Spaces the person reads (CB-181)                          |

- `file_issue` files into triage. It first runs the same check for similar open items as a socio's `file_improvement`, and returns `possible_duplicates` without filing. Calling it again with `force: true` files anyway.
- `read_issue` lists, in `attachments`, the files attached to the item and to its comments, newest first: id, name, media type, size, `on` (`item` or `comment`, with the comment's `commentAt`, the same as its `at` in `comments`), when it was added, whether by the person or another person, and its link. Its newest images come in the same answer as MCP image content after the JSON text, at most 5 images and 5 MB in all (`READ_IMAGES_MAX`, `READ_IMAGES_MAX_BYTES` in `src/server/agents/board.ts`). `images.sent` lists those images in order; `images.leftOut` lists the other images, each with the reason.
- `list_issues` enumerates all nondeleted issues when `status` is omitted, including `done` and `wont_fix`. Follow its `next` offset until `null`; `total` is the count for that request and `complete` says there is no further page. Each sort uses issue number to break ties. These are live views: concurrent inserts, edits or deletes may shift pages, so they are not a frozen historical snapshot. Socios with board permission have the same listing through `list_improvements`.
- `read_issue` and a socio's `read_improvement` return `statusHistory`: actual `created`, `imported` and `status` events, with `from`, `to`, ISO UTC `at` and persistent `sequence`. Initial records have `from: null`; an imported record establishes the known imported state, without inventing transitions before import. Pages default to 100 events and accept `historyLimit` (1–100) and `historyAfter` (the previous `statusHistory.next` sequence). Follow `next` until `null`; `complete: false` means the recorded timeline is truncated in this response. `coverage: recorded-only` applies even when `complete: true`: it does not promise pre-import history. Order is recorded sequence, including older rows whose sequence was migrated from insertion order; timestamps are stored event times and may tie or move backward. History exposes no actor identifiers or names.
- `read_issue` also gives `blockedBy` and `blocks` (CB-29): the items this one waits for and the items waiting for it, each with its key, title (emails taken out) and status. A blocker counts as done once it is `done` or `wont_fix`. It also gives `related` (CB-274): the items linked to this one with no blocking either way, in the same form. `file_issue` can set `related` on the new item for anyone, and `blockedBy` and `blocks` only for an admin; a pair of items has one link.
- `read_issue_attachment` reads one attachment by its id: an image as image content, a text file as text (emails taken out, at most 20,000 characters), a PDF as its details only. A wrong id, a deleted file or a file of a deleted item is `not_found`.
- `file_issue` and `comment_on_issue` take optional `attachments`: `[{ name, mediaType, data }]`, with `data` in base64. They go through the web upload's checks: PNG, JPEG, GIF or WebP images, PDFs or plain text, the type read from the content and agreeing with `mediaType` and the name's extension, at most 5 MB each and 10 on an item in all. Every file is checked before anything is written, so one bad file fails the whole call with a message naming it, and nothing is filed or commented. A comment's files belong to that comment. Each file is the person's, and its history row records the agent beside it (as an `update` row; the audit says "attached a file to"). A request to `/mcp` is at most 8 MB, so a call carries about 6 MB of files; send more in further comments.
- `vote_on_issue` casts the person's one vote: the same vote they cast on the web, so voting twice changes nothing.
- `update_issue` changes status, priority, area, kind, assignee (`me`, a name or an id), labels, components and resolution, within the person's role.
- Components (CB-442) are the plugins and apps an item is about: `plugin:<id>`, `app:<id>`, `plugins:*` (all plugins) or `apps:*` (all apps); a deleted app's tag reads `app:<id>@<generation>`. Each connection's tools are built for its person, so the choices are theirs: the plugins they may use and the apps they may open (an admin's: all of them). Up to 50 choices are an enum in `file_issue`'s schema and named in the descriptions; above that the schema takes the ref pattern, and `list_issue_components` names them. `file_issue` takes optional `components` (any member, when filing); `update_issue`'s replace the ones the person can see and keep the others (admins only); `list_issues` takes `component`, an exact match (`plugins:*` finds items tagged "All plugins", not every plugin's). `read_issue` and `list_issues` give each item's components as `{ ref, name, state? }`, only those the person may see, without owner names. A ref the person can't see is refused as unknown, as one that doesn't exist, and the answer lists their current choices (a client may hold an old tools list).
- Results are structured JSON, and the text content carries the same JSON. A refusal (`forbidden`) or a missing item (`not_found`) comes back as a tool error, with a message the agent can pass on.
- Item and page text is written by people, so tool descriptions and results tell the agent to treat it as untrusted data, not instructions.
- Item text comes without emails or other people's names, as socios read it.

**Attribution**

What an agent writes stays the person's: they are the reporter of the item, the author of the comment, the owner of the vote, and the actor in the history. Next to each action, `issue_agent_actions` (issues migration 9) records the client id, the client name, the grant, the person's label for the connection, and the person. The issue's detail shows the filing, the comment and the history row as "‹label› for ‹person›", for example "Claude Code on my laptop for Ada". `AgentActions.activity(grantId)` lists one grant's board actions, newest first, for the admin audit.

### One-shot issue status subscriptions

`subscribe_to_issues` watches explicit issue keys (1–20) for the person behind the current connection, once, when **all** reach `targetStatus` (default `done`) after a future status transition. Creating it returns `alreadyMatched` and never sends a historical notice. If the issues already match, the watch waits for a later transition away and back. Repeating the same active subscription returns the existing watch. A person can have 50 active watches.

Creation and cancellation need both `issues:read` and `issues:write`. `list_issue_subscriptions` needs `issues:read`, returns only that person's watches, and pages with `next`. `cancel_issue_subscription` takes the subscription UUID and cannot recall an already recorded notice. Socios with board permission have the same tools, bound to their current person. People can also create, inspect and unsubscribe in Account → Notifications. Creation and cancellation keep their acting socio or agent provenance without exposing private source-thread identifiers in the returned subscription. These watches remain owned by the person after an agent connection ends; they are not tied to a private chat's readability.

This first increment supports explicit groups and a single requested status. It does not support saved queries, recurring alerts or notifications for pre-subscription history. Deleted or replaced members and deactivated recipients cancel pending watches. Notifications contain issue keys and the matched status, without issue titles, descriptions, comments or private source-thread identifiers; they open the board. Existing channel choices and private-content settings apply.

Status events after subscription creation are replayed in persisted order, including after restart. A durable outbox, its stable notification identity and an in-app fallback are claimed atomically. External channels are attempted after commit in a separate bounded pool (four active tasks and 32 waiting). Discovery and sending share that bound. Saturation retains the in-app notice without requeueing external work. Attempts request cancellation after 30 seconds; shutdown requests cancellation and waits at most 250 milliseconds. Transports that ignore cancellation remain tracked against the active bound until they settle, with unknown external outcomes; they do not block later durable notices or shutdown. Privacy preferences are checked again immediately before sending. Ambiguous or failed external attempts are not automatically repeated; this is not an exactly-once delivery guarantee. The in-app fallback follows the existing notification visibility and retention windows. A watch marked `triggered` means its notification was recorded, not that a device displayed it.
