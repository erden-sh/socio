---
title: 'Feature flags and plans'
description: 'Ship features dark, decide them for the whole server, and define plans.'
---

Flags are declared in the code, each with a safe default, a stage, an owning area and a removal date. The server decides every flag per request for one person. The client only shows what the server decided, and socio tools of a flag that is off for a person are left out of their turns. There is no outside flag service and nothing is reported anywhere.

## Stages

- **Released** (`ga`): an optional feature, on Settings → Optional features.
- **Early access** (`early-access`): experimental, on Settings → Early access, off until admins turn it on.
- **In development** (`dev`): only in a deployment marked internal, with `SOCIO_DEPLOYMENT_KIND=internal`. There it is on Settings → In development, for admins. Anywhere else (any other value, or unset) it is never listed and never on, whatever `FEATURE_FLAGS`, a stored rule or a plan says; `FEATURE_FLAGS` entries for such flags are logged once at start and ignored.

## The order of decisions

Each layer replaces the one before:

1. The flag's default in the code.
2. `FEATURE_FLAGS` on this server, for example `web-reads=off` (comma-separated, `on` or `off`). An unknown flag is logged and ignored; a malformed list stops startup.
3. A stored rule for the whole server.
4. The workspace's plan, when it includes or leaves out the flag.
5. The workspace admins' rule.

A **locked** server rule ends the decision at step 3. A plan that **leaves a flag out** turns it off at step 4, and admins can't turn it back on. No person's own choice takes part: people don't turn flags on or off for themselves.

## Server rules and plans

Server rules and plans are set out of band, not in the app's Settings: Settings shows what they decide, read-only, as **Set by this server's configuration**. Prefer `FEATURE_FLAGS` in the deployment's configuration. One server runs one workspace today; rules and the plan are kept under its `TENANT_ID`.

## Records and clean-up

Rule and plan changes are lines in the workspace audit, with their before and after values, shown under **Recent changes**. Flags past their removal date are logged at start: they are due to be removed from the code. Rules for flags a newer version no longer has are ignored.

Admin guidance is in [Features and early access](/docs/admin/features).
