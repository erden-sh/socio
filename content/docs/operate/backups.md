---
title: 'Backup and restore'
description: 'Recover the database and its matching data, objects and keys together.'
---

## What a backup contains

Socio metadata is in `DATABASE_PATH`; personal datasets and encrypted files live under `USER_DATA_DIR` or configured object storage. A usable snapshot pairs the database with userdata from the same backup run. Computer volumes are separate and need their own recovery scope.

The built backup command is:

```sh
node dist/server/server/backup/backup-cli.js
```

Run it in the actual app environment with the intended paths and storage credentials. `pnpm run backup` invokes the same built CLI from a source checkout that has been built. It can write local and off-site data; it is not a read-only status check.

Successful runs produce `company-brain-YYYYMMDD-HHMMSS.sqlite` and matching `userdata-YYYYMMDD-HHMMSS/` in `BACKUP_DIR`. The database uses SQLite's backup API and is integrity checked. Datasets are copied as databases and files remain encrypted. With object storage, the run snapshots its mirrored objects beneath that userdata directory's `objects/` area. Retention prunes old successful pairs after completion.

## Verify and record

Check the command outcome and backup status, then record the exact source deployment, database and userdata suffix, sizes and hashes. Inventory individual files and applicable object snapshot data; a database hash does not prove that its userdata exists. Verify the off-site upload outcome separately from local success. Keep keys outside the backup, and test that the recovery environment can open the retained data.

Do not regard a hot file copy of SQLite alone as a consistent full backup. Use the application's backup operation or a documented stopped-service snapshot, and coordinate additional writes if your acceptance/recovery process requires a quiescent point.

## Restore as a controlled operation

1. Stop writers, including the app and any separate service that can modify the affected storage.
2. Retain the current database, WAL/SHM and userdata for investigation; do not overwrite the only copy.
3. Restore the selected database to `DATABASE_PATH` and its matching userdata contents to `USER_DATA_DIR`.
4. Restore snapshot object keys to the correct bucket/tenant where applicable; the `objects/` mirror is not ordinary local userdata.
5. Restore the matching keys and compatible service images, start, and verify schema, integrity, health and an owned user workflow.

A restore drill checks recoverability without replacing the live database. The configured continuous-copy drill validates database restores; it does not by itself prove full userdata, object or computer recovery.

## Off-site and continuous copies

The CLI also supports `open <file.sealed> <output>` to decrypt supported sealed backups and `fetch-ltx <directory> [lineage]` to retrieve a configured continuous-copy lineage for Litestream. They require the appropriate data key and off-site settings. Treat plaintext outputs as private recovery artifacts. Continuous database replication is additional protection, not a replacement for paired userdata and object snapshots. See [Storage](/docs/operate/storage) and [Secrets](/docs/operate/secrets).
