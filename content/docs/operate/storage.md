---
title: 'Storage and retention'
description: 'Inventory every persistent layer and plan for retained data.'
---

## Know where the bytes live

| Layer                           | What to preserve                                                             |
| ------------------------------- | ---------------------------------------------------------------------------- |
| Application SQLite              | Workspace, page, account, conversation, task, grant and audit metadata       |
| `USER_DATA_DIR`                 | Personal dataset databases, encrypted local files and associated state       |
| Object storage, when configured | Encrypted objects under the configured tenant and user keys                  |
| Backup storage                  | Database/userdata pairs, object snapshots and off-site/continuous-copy state |
| Socio computers                 | Browser profiles, shared workspace, private homes and their UID registry     |

A database backup alone does not contain every file or computer profile. A container's writable layer is not a safe substitute for persistent mounts. With node-local volumes, keep placement deterministic on the node that owns them.

## Local and object-backed files

The default userdata directory is next to the application database unless explicitly configured. Each user's datasets are separate SQLite files; file contents are encrypted. S3-compatible storage can hold files, while their metadata and access grants remain in the application database.

Switching from local files to configured object storage starts a background migration: upload, check, mark moved, then remove the local copy. Interrupted work resumes. An unreachable store causes file operations to fail and health to report storage unavailable; do not redirect reads to an unrelated empty bucket to hide that failure. Verify endpoint, tenant, credentials and storage status.

Object keys encode tenant/user/file identifiers rather than original names, and sizes remain visible to the storage service. Preserve tenant identity and credentials during a restore. Restore snapshot objects to their correct keys; the backup's object mirror should not be placed into local userdata as ordinary files.

## Deletion retains recovery material

Deleting a file, dataset, folder or attachment hides it from normal access and quota accounting while retaining underlying bytes and records. Replacing a file can retain a previous encrypted version. Backups include that retained material. Consequently, frequent large rewrites or heavy deletion can keep consuming disk or bucket capacity even when a person's visible quota looks low. There is no general user purge/restore interface for that retained history.

## Computers need their identity registry

Current computer shell/file operations use stable unprivileged identities and private homes, with explicit collaboration in `shared/`. Back up private homes and the UID registry together. Stale or missing mappings fail closed; do not rebuild a registry by guessing who owns a directory. Browser reset does not replace a complete storage restore.

Monitor both visible use and retained/deleted storage. Review quotas with admins, test [paired recovery](/docs/operate/backups), and keep the [encryption keys](/docs/operate/secrets) needed for every retained snapshot.
