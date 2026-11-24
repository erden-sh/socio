#!/usr/bin/env bash
# Puts main's feature boundary baseline in the copy of the checkout, for
# tests/feature-boundaries.test.ts: a change's baseline may only shrink from
# main's, and the copy the box tests has no .git to read main's from.
#
# The checkout fetches two commits (fetch-depth: 2). On a pull request it is
# GitHub's merge of the branch into main, whose first parent is main as the
# test sees it; on a push to main it is the new commit, whose first parent is
# the previous main. The file is read from that parent's tree with
# `git cat-file blob`, which applies no filter, textconv or attribute, and runs
# on the runner before any container has, from the checkout's own .git, which
# no container mounts. The branch can't write that commit: it is main's.
#
#   $RUNNER_TEMP/src/.ci-reference/feature-boundary-baseline.json   main's baseline
#   $RUNNER_TEMP/src/.ci-reference/feature-boundary-baseline.absent its commit, when it has none
#
# The directory is emptied first, so nothing the branch put there survives.
# Without a first parent the step fails: the test would have nothing to hold
# the baseline against. The one exception is the repository's first commit,
# pushed to main: it is recorded as having no baseline (`root`). A pull
# request's checkout is always a merge with main as its first parent, and
# main is protected from force pushes, so no branch can reach this case.
# SECURITY.md ("CI runs untrusted code") has the threat model.
# Trusted: under .github/, which coding sessions never push (CB-32).
set -euo pipefail

workspace=$GITHUB_WORKSPACE
out="$RUNNER_TEMP/src/.ci-reference"
file=scripts/feature-boundary-baseline.json

rm -rf -- "$out"
mkdir -p -- "$out"
if ! parent=$(git -C "$workspace" rev-parse --verify --quiet 'HEAD^1^{commit}'); then
  if [ "${GITHUB_EVENT_NAME:-}" = push ] && [ "${GITHUB_REF:-}" = refs/heads/main ]; then
    echo root >"$out/feature-boundary-baseline.absent"
    echo "reference-baseline: the first commit on main has no parent and no baseline"
    exit 0
  fi
  echo "::error::The checkout has no parent commit to read main's baseline from"
  exit 1
fi
if git -C "$workspace" cat-file -e "$parent:$file" 2>/dev/null; then
  git -C "$workspace" cat-file blob "$parent:$file" >"$out/feature-boundary-baseline.json"
  echo "reference-baseline: $file from $parent"
else
  echo "$parent" >"$out/feature-boundary-baseline.absent"
  echo "reference-baseline: $parent has no $file"
fi
