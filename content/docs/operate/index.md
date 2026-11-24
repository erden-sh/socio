---
title: 'Operator help'
description: 'Run, upgrade and recover Socio with verified data and deployment identities.'
---

Operators hold administrative powers plus platform and operator-account authority. Hosting access is separate from the app role: having an operator account does not itself supply Docker, secret-store or infrastructure credentials.

## Plan the work

Use [Deployment](/docs/operate/deployment) for the app boundary, exact origin, authentication, models and optional services. Use [Sign-in and code access](/docs/operate/access-policy) to narrow sign-in methods and allowlists without a redeploy, and for how groups give code access. Use [Secrets](/docs/operate/secrets) for credentials and encryption-key rotation. Use [Storage](/docs/operate/storage) to inventory persistent data rather than assuming the application SQLite file contains every byte. Use [Feature flags and plans](/docs/operate/feature-flags) to ship features dark or decide them for the whole server. Use [Model costs and price sync](/docs/operate/costs) for how Operations prices turns, what the daily price sync downloads, and how to cost self-hosted backends. Use [Workspace bundles](/docs/operate/workspace-bundles) to copy chosen issues, Spaces and pages from one Socio to another.

Before a change, read [Upgrades and recovery](/docs/operate/upgrades) and take a [paired backup](/docs/operate/backups). A running container or accepted update request proves neither migration correctness nor a working user experience.

## Evidence to keep

Record the application image digest and source release, architecture, complete intended service configuration, placement, mount inventory, schema versions and backup identifiers. Keep sensitive configuration private; a summary should contain names, hashes and outcomes rather than environment values, tokens or user content.

After a change, verify the intended healthy app, its release and storage status, the actual route through the proxy, and the affected user flow. Use isolated owned test accounts for acceptance and remove their fixtures afterwards. Never use a real person's account simply because it has the right role.

## Recovery is a data operation

SQLite migration checks reject unknown modules and newer versions. An older image can refuse a database that the new image migrated. Rollback can therefore require restoring a verified database and matching userdata from before the change, together with applicable object snapshots and keys. Do not treat a tag change as a complete recovery plan.

The [admin guides](/docs/admin) describe day-to-day role and workspace management. This section describes deployment operations; examples are generic and must be adapted to the actual service, persistent paths and approved change window.
