---
title: 'Upgrades and recovery'
description: 'Verify migrations, drain work and preserve a restore path before changing images.'
---

## Freeze the intended change

Read the release notes and record the exact old and new image digests, source versions, architectures and full service definitions. Include related services where their protocol or persistent layout changes. Preserve existing secrets, networks, placement and mounts unless a reviewed change deliberately alters them.

A version in a repository or a movable image tag is not the running deployment identity. Verify the current service and container, embedded release and health before applying anything. If another actor already deployed the target, inspect and reconcile that actual state instead of replaying the update.

## Back up and rehearse

Take a fresh [paired database and userdata backup](/docs/operate/backups), verify integrity and record its exact suffix, source and hashes. Include object snapshots and computer volumes where they belong to the recovery scope. Keep the matching keys. Do not reuse a timestamp from another deployment's backup.

Inspect migration plans read-only on a disposable database copy with the intended binary:

```sh
node dist/server/server/modules/migrate-cli.js /path/to/disposable-copy.sqlite
```

This reports planned steps or refuses unknown schema; it does not execute them. Rehearse startup migration and restore using copies and isolated services before relying on the production change. Never point a rehearsal at live userdata or external providers.

## Drain, deploy and verify

Wait for active work to settle, then use the deployment's reviewed drain/update procedure. Production SIGTERM drains; a development force-stop control is not a production shortcut. Keep the journal and native update handles so an unknown response can be observed rather than blindly repeated.

After the update, verify exact image, healthy lifetime, embedded version, expected schema versions and integrity, mounts and unchanged intended configuration. Test the affected UI using owned fixtures through the actual origin. Clean up fixtures and sessions before declaring acceptance. Accepted API requests and successful container startup are intermediate evidence.

## See and apply updates from the Platform page

The **Updates** card on **Platform** shows the running version and commit, the releases newer than it from the configured release feed, and each release's notes and Upgrading steps. Set the feed on the card: GitHub releases of a repository, which carry notes, or image tags on GHCR, which do not. A private feed needs a read-only token; it is stored sealed and is never shown again. Checks run on the interval you set, or when you click **Check now**, and send nothing that identifies the workspace or its people. Operators are notified once about each new release. Only operators see the card.

Without the optional updater, the card only informs you: apply the release through the reviewed procedure above. With it, **Update to** a release opens a guided apply:

1. Read the Upgrading steps of every release up to the target and do the ones that come before the update, such as new secrets or images. When there are steps, or the feed has no notes, you must confirm before continuing.
2. Socio takes a backup with the configured backup settings, including the off-site copy if one is configured. If it fails, nothing changes.
3. The updater changes only the stack's image tag keys through the Portainer stack API and keeps every other setting. It checks first that the images exist.
4. It waits for the new version to report healthy, then marks the update **Updated**. Otherwise it restores the previous stack settings and waits for the previous version to report healthy (**Rolled back**).

**Rollback failed** means the previous version did not come back, usually because the new one had already migrated the database. Follow [Backup and restore](/docs/operate/backups) with the backup the card names, then deploy the previous image. The app restarts during an update, and the page reconnects on its own.

Automatic updates are off by default. When turned on, they apply only releases whose notes list no Upgrading steps. They stop at the first release with steps or without notes, and they never retry a release whose update failed. Continue to verify each update as described above. A healthy status check is evidence, not acceptance.

## Why an older image can fail

Startup migrations are forward-only. Strict checking refuses a module or version the binary does not know. Version 0.20 adds the `mcp-connections` schema module at version 1; an older 0.19.1 binary rejects that database even if its older tables look intact. Changing only the app image is not a supported downgrade.

A rollback may require stopping writers, retaining the failed state for investigation, restoring the pre-upgrade database and its paired userdata/object data, restoring compatible service images and keys, then verifying the restored app and user flow. Include retained computer identity volumes where relevant. Choose that plan before updating, not after discovering the old image cannot start.
