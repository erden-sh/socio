---
title: 'Secrets and account recovery'
description: 'Keep credentials out of configuration exports and rotate encryption keys safely.'
---

## Use secret files

The server supports `<NAME>_FILE` for its declared secret settings, including `SESSION_SECRET`, data-encryption keys, model and Telegram credentials, computer tokens, object-storage keys, off-site backup credentials and the cloud connection's enrollment token (`SOCIO_CLOUD_ENROLLMENT_TOKEN`). A nonempty explicit environment value takes precedence. Missing or unreadable configured files stop startup without echoing their contents.

Use the deployment's secret mechanism with narrow access. Keep the computer supervisor token, computer master token and session secret distinct. Do not put secret values in stack exports, issue comments, model instructions, screenshots or shell arguments. In particular, a one-time account link and a session cookie are credentials even when not called passwords.

## Preserve the data key

`DATA_ENCRYPTION_KEY` seals files, attachments and stored credentials. It accepts 32 random bytes represented as 64 hex characters or base64. Keep a recovery copy separately from the backup data, with equally controlled access. A backup without the keys needed to open it is not usable recovery material.

For rotation, set the new current key and the old one as `DATA_ENCRYPTION_KEY_PREVIOUS`, restart, and wait for health to report data-key resealing complete. Only then remove the previous key from the running service. Older retained backups still need their old keys, so retain those recovery keys outside the app as appropriate. A `key_missing` status requires restoring the missing key, not generating a replacement.

Without a dedicated data key, older data and credentials may depend on a key derived from `SESSION_SECRET`. Rotating that secret prematurely can make them unreadable. Once resealing under a dedicated data key is complete, rotating the session secret still signs people out but need not lose their stored data.

## Recover an account through the actual app environment

Prefer People while an authorized administrator can sign in. If command-line recovery is necessary, use the app service's exact environment and database. The built entrypoint supports:

```sh
node dist/server/server/auth/auth-cli.js list
node dist/server/server/auth/auth-cli.js password-link --email person@example.invalid
```

A password link is printed privately and works once. Do not attach its output to an issue. `create-user` supports `--email`, `--name`, `--role`, optional `--link` for an existing identity, and `--password-file` when a direct password is needed. Use a private file rather than a password in argv. Inspect current accounts and ownership before creation; an uncertain result is not permission to repeat create.

The CLI migrates before use and can write a backup. Its deactivate/reactivate commands preserve account records and role guards; unlike People, it cannot immediately reach every live in-memory connection. Keep at least one active operator and administrator. See [Upgrades](/docs/operate/upgrades) before using an older binary for recovery.
