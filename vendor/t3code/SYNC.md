# T3 Code vendored core (CB-326)

This directory holds provider packages vendored from **T3 Code**
(https://github.com/pingdotgg/t3code), the MIT-licensed coding-agent core by
T3 Tools Inc. Socio runs these as a long-lived session host inside each
coding sandbox, replacing its own one-shot CLI adapters.

## Source

- **Upstream:** `pingdotgg/t3code`, branch `main`.
- **Commit:** `3fd2b855c5` (the upstream `main` on 2026-11-01, refreshed from a
  read-only worktree at `/tmp/t3code-latest`).
- **Licence:** MIT, copyright © 2026 T3 Tools Inc. See `LICENSE` here and
  `THIRD_PARTY_NOTICES` in the repository root.

## What's vendored

These packages, each a private, unpublished raw TypeScript package
(Effect 4.1.5 services):

`provider-core`, `provider-acp`, `provider-acp-registry`, `provider-grok`,
`provider-opencode`, `provider-pi`, `effect-acp`, `effect-codex-app-server`,
`contracts`, `shared`.

`provider-codex` (the extracted `CodexAdapterV2`) lands as a separate step.

## How they're pinned and wired

- Each is a pnpm workspace package (`pnpm-workspace.yaml` → `vendor/t3code/*`).
- The root `package.json` links them as `link:vendor/t3code/<pkg>`.
- Versions the packages reference as `catalog:` resolve through the
  `catalog:` block in `pnpm-workspace.yaml` (effect 4.1.5 and the markdown /
  crypto pipeline `shared` renders with). Socio's own code does not use
  `catalog:`.
- Test files (`*.test.ts`) and each package's `devDependencies`/`scripts`
  were removed on vendor: Socio doesn't run T3's own tests, and the devDeps
  referenced T3-internal packages (`vite-plus`, `@effect/vitest`) that aren't
  in Socio's workspace.

## What was stripped / replaced

T3's telemetry, relay and update code is **defined** in `contracts` and
`shared` (the relay client, OTLP exporters, PostHog/Axiom ingest). The
definitions are kept here so the packages compile; Socio does not supply the
relay endpoints, and these code paths are not wired into the session host
(step 3 replaces them with Socio's own telemetry, audit and update plumbing,
rather than just removing them).

## Local edits

Socio runs these packages on Effect 4.1, while upstream is on 4.0. Effect 4.1
replaced `effect/Crypto` with `effect/crypto/*` services, so the vendored code
takes `SecureRandom` (`uuidV4`, `randomBytes`) and `Digest` (`Digest.sha256`)
instead of `Crypto.Crypto`. `shared`'s `nodeSqliteClient` passes the `driver`
name that 4.1's `SqlClient.make` requires. Keep these edits on a re-sync
until upstream moves to 4.1.

## Ported into the push relay (`apps/push-relay`)

The push relay's APNs and FCM clients are ports of T3 Code's own relay, not vendored
packages: rewritten onto WebCrypto and `fetch`, with no Effect, no `node:crypto` and no
dependency, since the relay is a Cloudflare Worker without `nodejs_compat`. They don't track
upstream; this list is their notice. Each file names its source in its header comment.

- **Upstream:** `pingdotgg/t3code`, `main` at `549d182aaa` (2026-09-14),
  `infra/relay/src/agentActivity/`.
- **Licence:** MIT, copyright © 2026 T3 Tools Inc (`LICENSE` here; `THIRD_PARTY_NOTICES` section 15).

| Here (`apps/push-relay/src/`) | Upstream                     | What changed |
| ----------------------------- | ---------------------------- | ------------ |
| `apns-jwt.ts`                 | `apnsJwt.ts`                 | Signed with WebCrypto's ECDSA (randomized) instead of `@noble/curves`' deterministic RFC 6979; the key fingerprint with `crypto.subtle.digest`. |
| `apns-provider-tokens.ts`     | `ApnsProviderTokens.ts`      | A class with an injected clock; reused 50 minutes from issue (upstream: 45, with `iat` quantized so isolates agree, which randomized signatures can't), and shared between isolates through D1 with a compare-and-swap; dropped on `ExpiredProviderToken` only. |
| `apns-client.ts`              | `ApnsClient.ts` (`sendPushNotificationRequest` only) | Plain `fetch`; `apns-expiration` from the push's TTL; never `apns-collapse-id`; the sandbox or production host per registration; answers mapped to the relay's outcomes. No Live Activities. |
| `fcm-assertion-signer.ts`     | `FcmAssertionSigner.ts`      | The same claims and WebCrypto, as a function. |
| `fcm-client.ts`               | `FcmClient.ts`               | Plain `fetch`; the access token cached until Google's `expires_in` (upstream: 50 minutes); the push's TTL and Topic as `ttl` and `collapse_key`; "Message is too big" told apart from other `INVALID_ARGUMENT` answers. |

## Re-syncing

To refresh from a newer upstream `main`, from a **read-only worktree** (never
the owner's `~/projects/t3code` checkout, which has their untracked `deploy/`):

```
git -C ~/projects/t3code fetch origin main
git -C /tmp/t3code-latest checkout --detach origin/main   # refresh the worktree
# rsync each package as in the original vendor (excluding *.test.ts, dist, node_modules)
```

Update the commit above and the date, then run `pnpm install --frozen-lockfile`
and `pnpm run check`. Vendoring is deliberate and pinned; upstream takes no
large contributions, so this is a copy, not a fork.
