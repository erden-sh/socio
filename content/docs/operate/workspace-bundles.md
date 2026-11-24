---
title: 'Workspace bundles'
description: 'Copy chosen issues, Spaces and pages from one Socio to another, safely and repeatably.'
---

A workspace bundle copies a chosen set of Improvements board issues, Spaces and pages from one Socio (the source) into another (the target). Ids, issue numbers and timestamps are kept. You can run the import again with the same bundle, or with a newer one, and it only adds or updates what changed at the source. Nothing is ever taken from the target.

Both servers must run the same Socio release. The import refuses a bundle whose schema differs from the target's.

## What is copied

- **Issues:** fields, labels, status, timestamps, comments (deleted ones are skipped), attachments, recorded history, votes by people who have an account on the target, and blocked-by and related links when both issues are in the bundle.
- **Spaces:** name, description, the members-only setting, and members who have an account on the target. Socio grants are left for you to set on the target.
- **Pages:** the current text (as revision 1), the page tree, tags, links between pages that are both in the bundle, the cover, and images. Search is indexed as each page is written.

Subscriptions, triage rows, socio requests, issue runs and agent attributions are not copied.

## People and authors

People are matched by **email**, and only to a target account whose email is verified, as sign-in trusts it: an admin created the account, or the sign-in provider confirmed the address. A matched person's issues, comments, votes and Space memberships are theirs on the target. An account that has the email but hasn't verified it is not matched, and the dry run lists who that affects. Anyone without an account on the target, and every socio, is written as **Imported**, and the text gets a byline such as _Originally by Ana Ruiz on Acme, 2026-10-01._ It holds the person's name, the source's label and the date. A page by someone who isn't on the target has no creator and gets the same byline.

## Links and issue mentions

Issue numbers are kept, so `CB-12` still means the same issue. A mention of an issue that was **not** copied becomes `CB-12 (<source>)`, linked to the source's own board by its absolute URL. It never resolves to an unrelated issue on the target. `#12` shorthand is left as written: in issue text it is usually a pull request number, not an issue.

### When the target already has the number

While both boards take new issues, a new source issue's number may already belong to another issue on the target. What happens depends on that issue:

- **A live issue filed on the target** (never imported): the bundle's issue is **renumbered**. It takes the target's next free number, and the dry run lists it as `renumber CB-388 → CB-393 (CB-388 here is another issue)`, counted as a create. The dry run's number is the one free at that moment; an issue filed on the target before you apply moves it on. Applying picks the numbers as the import starts, in the same transaction that moves the target's issue counter past them, so an issue filed on the target meanwhile always gets a later number. On the target, every `CB-388`, `/issues/CB-388` and source URL of it in imported text (issue bodies, comments, resolutions and pages) reads `CB-393`; blocked-by and related links follow the issue, not the number. The issue's text starts with _Originally CB-388 on Acme._, and the import's note says so too. The target's own CB-388 is left alone.
- **The source's own issue, renumbered by an earlier import:** the same. When the source reaches the number a renumbered copy took, its new issue is renumbered too.
- **An issue filed on the target and then deleted there:** the dry run lists it as `replace deleted CB-12 here (deleted <date>)`, and applying removes it for good, with its comments, history, attachments and every other record of it, as the import starts, before it writes anything else. The bundle's issue then takes that number; replacing comes before renumbering. Restore the deleted issue before you apply if you want to keep it.
- **Any other issue** (a copy another import brought, or one with the bundle issue's id that no import from this source wrote): a **conflict**. The issue on the target is left alone, the bundle's issue is not imported, and its mentions point at the source. Such a copy may well be the same issue (from a source whose address changed, say), and renumbering would make a second one.

A renumbering is kept (in `import_map`): a later import updates the same issue under its new number, never makes a second one, and never renumbers it again.

To keep the old rule, where any number taken on the target is a conflict, pass `--keep-numbers-strict` (or `"keepNumbersStrict": true`).

Links to copied pages point at the target. Links to pages that weren't copied point at the source. Code is never changed: fenced code blocks and inline code keep their text.

## Export, on the source

Run it in the source's app container. It reads a snapshot of the database, never the live file. Without `--from`, it makes a `VACUUM INTO` copy under `BACKUP_DIR` and removes it afterwards. To export from a backup instead, open it first and pass `--from <file>`.

```sh
node dist/server/server/bundle/bundle-cli.js export \
  --out /backups/bundles/2026-11-erden --label Acme \
  --issues 12,15-18,@issues.txt --spaces <space-id> --pages <page-id>,<page-id> \
  --deny-space <space-id>
```

- `--issues` takes numbers, ranges, `all`, or `@file` with one per line. `--spaces` copies whole Spaces. `--pages` picks single pages; a picked page whose parent isn't picked becomes a root.
- `--label` is how the target names the source in bylines and links. `--origin` defaults to the source's `APP_ORIGIN`.
- **The deny-list is required.** Name every Space an export must never read with `--deny-space` (repeatable, or `@file`) or `BUNDLE_DENY_SPACES` (comma-separated). If a selected Space, or a selected page's Space, is on it, the export refuses before it reads anything. Use `--no-deny-list` only when there is nothing to protect.

The bundle holds attachments and images **unsealed**. It is written private to the server's user (directories 0700, files 0600). Keep it on the host, copy it only to the target's backup volume, and delete it after the import.

## Import, on the target

Put the bundle directory under the target's `BACKUP_DIR/bundles/`. The import runs inside the live server, so nothing has to stop. Operators only:

```sh
# Dry run (the default): writes nothing, returns the report.
curl -X POST https://<target>/api/operator/bundles/import -d '{"bundle":"2026-11-erden"}' …
curl https://<target>/api/operator/bundles/import …   # the run's state and report
```

`GET /api/operator/bundles` lists the bundles there. The POST also takes `"spaceMap": {"<source space id>": "<target space id>"}` to put a source Space's pages into an existing Space on the target, `"terms": ["…"]` to add words to the sensitive-detail review, and `"keepNumbersStrict": true` (see above). One import runs at a time.

### From the command line, without stopping the server

No browser at hand? Run the same import from a shell in the target's app container. It hands the job to the running server, waits, and prints the same report:

```sh
node dist/server/server/bundle/bundle-cli.js import /backups/bundles/2026-11-erden \
  --as <operator user id> --live [--apply] [--space-map SRC=DST ...] [--term WORD ...] \
  [--keep-numbers-strict] [--json report.json]
```

- The bundle must be a directory directly under `BACKUP_DIR/bundles/`: the server reads it by name, as the web import does.
- The server runs it exactly as the web import: the same backup check before `--apply`, its own copy of the database, one import at a time (a web import running makes it refuse, and the other way round), and the same log lines. Its `import_runs` row says `via='cli'`, with `--as` as who started it.
- The server checks that `--as` names an operator who isn't deactivated, and refuses anyone else.
- The CLI reaches the server through a Unix socket, never a network port: one per database, in a directory under the container's temporary directory (`/tmp/socio-bundle-<uid>/`), private to the app's user (0700; the socket 0600). The server refuses a directory someone else owns or that is a link, and the CLI refuses to talk to one that is open to other users. It isn't on a volume, so another container can't reach it. Each server makes its socket as it starts; in a start-first upgrade the new one takes it over.
- If the CLI says no server answers, the server isn't running on that database (or started before this release): import from the web, or stop the app and run the import offline.

**Read the dry run's report before you apply.** It lists the counts per record type and action, issue numbers kept and numbers taken on the target, authors matched and not matched, issues and pages named but not copied, samples of every text rewrite, attachment and image bytes, conflicts, and a list of **sensitive details** to review: home directory paths, Portainer stack and endpoint ids, internal host names and private addresses, and emails. Nothing is redacted.

Then:

1. Take a full backup: `node dist/server/server/backup/backup-cli.js` (see [Backups](/docs/operate/backups)).
2. Apply within 15 minutes: the same POST with `"apply": true`. It refuses without a backup that finished in the last 15 minutes. It also copies the database to `BACKUP_DIR/import-<time>/` before its first write.
3. Check counts, open a few issues and pages, and follow some links.
4. Delete the bundle.

The import writes in chunks of 25 records, one transaction each, and yields between them so the server keeps answering. Attachments and images are read one file at a time, within a fixed memory budget. Images are sealed again with the target's data key and stored in the operator's Files under `imported/<source>/`.

`bundle-cli.js import <dir> --as <operator user id> [--apply]` without `--live` does the same offline, with the same checks. It refuses while a server is running on the database.

## No notifications

Imported issues are written with source `import`, straight into their tables. No board event fires, so nobody is notified (Telegram, push or in-app), auto-triage skips them, and no model is asked anything. When a later bundle changes the status of an issue someone on the target watches, the watch takes the new status as already known. The copied status change is not added to the history, so the watch never fires.

## Running it again

Each applied import records what it wrote. A later run with a newer bundle:

- adds what is new;
- updates what nobody on the target edited since the last import;
- leaves alone anything edited or deleted on the target, and lists it as a conflict. **Edits on the target always win.**

A second run with the same bundle changes nothing.

## Rolling back

Restore the backup you took before applying (see [Backups](/docs/operate/backups)). The import's own copy in `BACKUP_DIR/import-<time>/` holds the database only. Imported images are files in the operator's Files, so restore the matching userdata as well.
