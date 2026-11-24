#!/usr/bin/env bash
# Moves the task cache between the runner's own directory, which actions/cache
# restores to and saves from and no container ever mounts, and the copy of the
# checkout the box mounts:
#
#   turbo-cache.sh import    after restoring, before any container has run
#   turbo-cache.sh export    after the box has finished, before saving
#
# actions/cache runs tar with -P on the runner, so what reaches its directory
# must be what we meant: this is the one place the runner reads what a container
# wrote. It copies only regular files with the names Turborepo gives its cache
# entries, from the top level of a directory that is really a directory, and
# never follows a link. Their contents are never read or run here. Symlinks,
# FIFOs, devices, subdirectories and other names are dropped. No container is
# running at either point, so nothing can swap a file under it.
# SECURITY.md ("CI runs untrusted code") has the threat model.
# Trusted: under .github/, which coding sessions never push (CB-32).
set -euo pipefail

store="$RUNNER_TEMP/turbo-cache"
boxed="$RUNNER_TEMP/src/.turbo-ci"
# A run's entries come to tens of megabytes; past this, something is wrong and
# a cold run is better than evicting everything else in the repository's cache.
limit=${TURBO_CACHE_LIMIT_BYTES:-2147483648}

transfer() {
  local from=$1 to=$2 total=0 count=0 file size
  rm -rf -- "$to"
  mkdir -p -- "$to"
  if [ -L "$from" ] || [ ! -d "$from" ]; then
    echo "turbo-cache: nothing usable at the source"
    return 0
  fi
  while IFS= read -r -d '' file; do
    size=$(stat -c %s -- "$file")
    total=$((total + size))
    if [ "$total" -gt "$limit" ]; then
      rm -rf -- "$to"
      mkdir -p -- "$to"
      echo "turbo-cache: over $limit bytes, dropped everything"
      return 0
    fi
    cp --no-preserve=all -- "$file" "$to/"
    count=$((count + 1))
  done < <(find -P "$from" -mindepth 1 -maxdepth 1 -type f -regextype posix-extended \
    -regex '.*/[0-9a-f]{16}(\.tar\.zst|-meta\.json|-manifest\.json)' -print0)
  echo "turbo-cache: $count files, $total bytes"
}

case "${1:-}" in
  import) transfer "$store" "$boxed" ;;
  export) transfer "$boxed" "$store" ;;
  *)
    echo 'usage: turbo-cache.sh import|export' >&2
    exit 2
    ;;
esac
