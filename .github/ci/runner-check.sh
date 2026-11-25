#!/usr/bin/env bash
# Checks the runner before CI starts any container (CB-32; SECURITY.md,
# "CI runs untrusted code"). CI runs on single-use VMs, a fresh one per job:
# Blacksmith's (runs-on: blacksmith-…), or GitHub-hosted ones. The sandbox
# relies on two facts about that host, so every job checks them and stops if
# either is false:
# - Docker 26 or later: older engines let `--internal` networks resolve and
#   leak through the host's DNS (CVE-2024-29018).
# - Nothing listens on the host except on loopback (and the DHCP client on
#   the instance's own interface): `--internal` networks can still reach
#   listeners on the host's bridge gateway.
# Trusted: under .github/, which coding sessions never push (CB-32).
set -euo pipefail
docker=${DOCKER:-docker}
ss=${SS:-ss}

version=$("$docker" version --format '{{.Server.Version}}')
if ! [[ $version =~ ^([0-9]+)\. ]] || [ "${BASH_REMATCH[1]}" -lt 26 ]; then
  echo "::error::Docker $version on this runner; CI needs 26 or later (CVE-2024-29018)"
  exit 1
fi

# A Blacksmith VM runs Blacksmith's own services: its transparent cache on
# the VM's private address, and its agent. Nothing in a job may stop those, so
# on Blacksmith every packet from Docker's bridges to this host is dropped
# first (.github/ci/bridge-firewall.sh), and the check below lets through those
# two ports alone, and nothing else.
blacksmith=false
if [[ ${RUNNER_NAME:-} == blacksmith-* ]]; then
  blacksmith=true
fi

# GitHub's and Blacksmith's images start sshd on every address, and nothing
# in a job needs it: stop it first, then check as strictly as before.
if [ "${RUNNER_ENVIRONMENT:-}" = github-hosted ] || $blacksmith; then
  # A unit this image lacks is fine: the check below still sees any listener.
  ${SSH_STOP:-sudo systemctl stop ssh.socket ssh.service} || true
fi

if $blacksmith; then
  if ! ${FIREWALL:-sudo bash "$(dirname "$0")/bridge-firewall.sh"}; then
    echo "::error::Could not close this runner to its Docker bridges, so CI can't confirm the host is isolated"
    exit 1
  fi
fi

# Every TCP and UDP listener, as "<proto> <local address>". Fine: loopback,
# and the DHCP client (UDP 68 at the instance's own address, bound to its
# interface), which the Docker bridge gateway isn't. If ss itself fails (or is
# missing), stop: no output must never read as "nothing listens".
if ! listeners=$("$ss" -Hltnu); then
  echo "::error::Could not list this runner's listeners ($ss failed), so CI can't confirm the host is isolated"
  exit 1
fi
# The `|| true` below only absorbs grep's "no lines left" status.
exposed=$(printf '%s\n' "$listeners" | awk 'NF {print $1, $5}' |
  grep -Ev ' (127\.[0-9.]+|\[::1\]|\[::ffff:127\.[0-9.]+\])(%[[:alnum:]]+)?:[0-9]+$' |
  grep -Ev '^udp [1-9][0-9]*\.[0-9]+\.[0-9]+\.[0-9]+%[[:alnum:]]+:68$' || true)
# On Blacksmith, behind the firewall: its cache (8378) and its agent (49193).
if $blacksmith; then
  exposed=$(printf '%s\n' "$exposed" | grep -Ev '^tcp [^ ]+:(8378|49193)$' || true)
fi
if [ -n "$exposed" ]; then
  echo "::error::This runner listens beyond loopback, which CI's internal networks could reach: $(echo "$exposed" | tr '\n' ' ')"
  exit 1
fi
if $blacksmith; then
  echo "Runner OK: Docker $version, Docker's bridges closed to the host, no other listeners beyond loopback"
else
  echo "Runner OK: Docker $version, no listeners beyond loopback"
fi
