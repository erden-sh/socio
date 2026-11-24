---
title: 'Deployment'
description: 'Define the app, proxy, persistent data and optional services before starting them.'
---

## Establish the deployment boundary

Use a reviewed deployment definition and an immutable image identity for the required architecture. The repository includes local Compose files and separate Portainer stack examples. Their service names and volumes are templates, not authority for an existing host. Inspect the live deployment before applying an update, and retain its full prior definition.

The application runs on Node.js 26.13.0 or a supported later Node 26 release; the project pins pnpm 10.15.0. For a source build, install the frozen lockfile, build the web and server output, and run the built server. Its working directory must include the built web server files and release data. Starting only a client asset server does not run Socio.

## Authentication and origin

For remote access use Better Auth, a strong session secret and an exact HTTPS `APP_ORIGIN`. Match scheme, host and port; do not include a path or trailing slash. Behind a trusted reverse proxy, configure proxy trust only when the app port cannot be reached around that proxy. Secure-origin auth uses host-only cookies, so changing the origin affects sessions and integrations.

Mock authentication is for loopback development. It is not an access-control solution for a team deployment and the server refuses non-loopback use.

Terminate HTTPS at the reviewed proxy. Preserve streaming responses; do not compress `text/event-stream` in the proxy. Keep browser, computer, storage, database and worker services private rather than exposing their ports as public app endpoints.

## Persist and place deliberately

Mount `DATABASE_PATH`, `USER_DATA_DIR` and `BACKUP_DIR` on persistent storage, with backups separate from the main data volume. A service using node-local storage must stay on its data-owning node. Inventory optional object storage and the computer's browser, workspace and private-home volumes. See [Storage](/docs/operate/storage).

Seed the first shared model backend if needed; afterwards operators manage it under Platform. Missing inference does not make manual page editing unavailable. Computers, Telegram, coding sessions, apps and voice require their own configured services and secrets. Enabling a UI permission does not deploy them.

Failure labels in Operations send scrubbed error text to the default shared model only after an admin turns them on. `CLASSIFY_FAILURES`, `CLASSIFY_FAILURES_DAILY` and `CLASSIFY_FAILURES_THRESHOLD` set the defaults: off, 200 calls a day, 0.9. Admins can override them in Operations → Settings. The Evaluate button there runs the same check as `pnpm run classify:eval -- --use=failures --provider=workspace` in a checkout, or `node dist/server/server/classify/eval-main.js --use=failures` in the app image. Both forms need `DATABASE_PATH`, plus `DATA_ENCRYPTION_KEY` or `SESSION_SECRET` to open the backend's key. The command makes one model call per golden label and records its result in the database.

Session intent and themes (Operations → Themes) work the same way: off until an admin turns them on, they send a chat's scrubbed title and first three person messages to the default shared model. `CLASSIFY_INTENT`, `CLASSIFY_INTENT_DAILY`, `CLASSIFY_INTENT_THRESHOLD` and the matching `CLASSIFY_THEMES*` set their defaults: off, 300 calls a day, 0.8 for intent and 0.7 for themes. Evaluate them with `--use=intent` or `--use=themes`.

Learning triage works the same way too. Off until an admin turns it on, it sends each finished Learning conversation's scrubbed title and the people's messages, cut to 1,500 characters and without the socio's replies, to the default shared model. It also sends each proposal's text for a repeat check and a privacy check. `CLASSIFY_LEARNING`, `CLASSIFY_LEARNING_DAILY` and `CLASSIFY_LEARNING_THRESHOLD` set its defaults: off, 200 calls a day, 0.9. Evaluate it with `--use=learning`.

## Verify before handoff

Check the exact running image and architecture, health and embedded version, schema/integrity, correct mounts, proxy origin, sign-in and an owned role-appropriate workflow. Check backup status and restore readiness. If accepting a computer upgrade, include its compatible supervisor and computer images and persistent identity registry. Record the result without credentials or real user content.
