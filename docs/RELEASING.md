# Releasing Socio

For the agent cutting a release for a developer, and for the developer. The mechanics are in `scripts/release.mjs` (CB-165, CB-178); the deploy that follows is the operator's (a self-hosting guide is coming).

## The rules

- **Never go to 1.0 without the owner.** Socio is 0.x. While it is, `### Breaking` makes a minor release and the script refuses `--major` without `--yes`. Do not pass `--yes` yourself: 1.0 is a product decision.
- **One release per deploy.** Every deploy is a release (a version, a tag, notes). Do not deploy untagged commits, and do not cut a release you will not deploy.
- **Never push without the owner's go.** The script commits and tags locally and never pushes. Show the owner the version, summary and highlights, then wait. Only then `git push origin main <tag>`.
- **Releases are cut on `main`, with a clean tree.** `--dry-run` is safe anywhere it can run; a real run changes package.json and the notes (pnpm-lock.yaml holds no version of the project's own, CB-183).
- Say "socio" and "socios", never "Dot", in the summary, highlights and notes.

## Cutting one

```sh
pnpm run -s release:check              # is Unreleased ready? lists every problem with its fix
pnpm run -s release --draft-summary    # the Unreleased bullets, most important first, and a highlights list to rewrite
pnpm run -s release --dry-run --json   # version, why that bump, sections, what is missing
pnpm run -s release --json             # for real: commit "Release vX.Y.Z" and the annotated tag
```

Always pass `-s` (`pnpm run -s`) with `--json`: without it pnpm prints its own banner (`> socio@0.6.1 release ...`) on stdout before the object, and it no longer parses. `node --import tsx scripts/release.mjs --dry-run --json` works too. pnpm needs no `--` before the script's options; the npm habit `pnpm run release -- --dry-run` works as well (the script skips the `--` pnpm passes on).

Before it commits, `pnpm run release` runs `tests/release-notes.test.ts` on the files it just wrote. If that fails it puts package.json and the notes back, commits and tags nothing, and prints the test output. That test keeps v0.1.0 to v0.6.1 as a fixed tail, so a new release needs no edit to it; if it fails for a new release, the notes or the test are wrong, so fix them.

`release:check --notes-only` skips the summary and highlights; use it in CI on every change. Without it the check is for the moment before a release. With `--json`, every command prints one object and exits 1 when `ok` is false; an error (also a wrong option) comes as `{ "ok": false, "error": "...", "missing": [...] }`, and each message says what to change.

## Drafting the summary and highlights

1. Run `pnpm run release --draft-summary`. It lists each Unreleased bullet (its bold lead and issue key) and a suggested list.
2. Write the **summary**: one or two plain sentences for the people who use Socio, not for developers. What can they do now, what no longer goes wrong? No issue keys, no file names.
3. Pick **3 to 5 highlights** (1 to 5 are allowed), the changes people will notice, each as `What people notice (CB-n)`. Rewrite the bold leads in plain words; drop internal-only changes (they stay in the full notes). Fixes of one thing can share a highlight.
4. Put them in docs/RELEASE-NOTES.md under `## Unreleased`:

    ```md
    ### Summary

    One or two plain sentences about the release.

    - What people will notice (CB-157)
    - Another change (CB-160)
    ```

    or pass `--summary "…" --highlight "…"` (repeat the flag) to the release command. Commit the notes before releasing: the tree must be clean.

5. Run `pnpm run release:check` until it passes. Valid issue keys are written `CB-12`.

Each change adds its own bullet under `### New`, `### Changed`, `### Fixed` or `### Upgrading` as it merges; see the comment at the top of docs/RELEASE-NOTES.md.

## When images need rebuilding

Build from the tag (`scripts/build-images.mjs`).

- **Read the release's `### Upgrading` section** (in docs/RELEASE-NOTES.md, under Unreleased before you cut it) before deploying: it lists the migrations, images and settings to apply.
- **One time, for the release that moves to pnpm (CB-183):** rebuild the **app and apps runtime** images from the same tag and deploy them together (both install the same way).
- The **app** image is rebuilt for every release, because it carries the version and the release notes.
- The apps runtime and computer images change only with their own code. A deploy of one of them alone, with no app change, is still a patch release: say so in its summary.
- Never run Docker or Portainer commands for this without the owner's go; deploys go through the Portainer stack API.
