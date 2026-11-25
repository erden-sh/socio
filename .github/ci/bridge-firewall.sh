#!/usr/bin/env bash
# Closes this host to its Docker bridges (CB-32; SECURITY.md, "CI runs
# untrusted code"): every packet a container sends to the host itself, through
# docker0 or a user-defined bridge (br-…), is dropped, except replies to
# connections the host opened. Containers still reach each other and, on a
# network that isn't internal, the internet: that traffic is forwarded, never
# delivered to the host. Run as root, by runner-check.sh on runners whose own
# services listen beyond loopback. Fails, so the job stops, unless every rule
# is in place for IPv4 and IPv6.
# Trusted: under .github/, which coding sessions never push (CB-32).
set -euo pipefail
for tool in "${IPTABLES:-iptables}" "${IP6TABLES:-ip6tables}"; do
  for bridge in docker0 br-+; do
    # Inserted at the top, ahead of anything else in INPUT: the reply rule
    # goes in last, so it ends up first.
    "$tool" -w -I INPUT 1 -i "$bridge" -j DROP
    "$tool" -w -I INPUT 1 -i "$bridge" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  done
  # Confirm what INPUT now starts with, after its policy: these four rules, in
  # this order, or stop.
  want=$'-A INPUT -i br-+ -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT\n-A INPUT -i br-+ -j DROP\n-A INPUT -i docker0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT\n-A INPUT -i docker0 -j DROP'
  # sed reads to the end: head would close the pipe early, and pipefail
  # would then fail a firewall that is in place.
  have=$("$tool" -w -S INPUT | grep -v '^-P ' | sed -n '1,4p')
  if [ "$have" != "$want" ]; then
    echo "$tool: INPUT doesn't start with the bridge rules:" >&2
    printf '%s\n' "$have" >&2
    exit 1
  fi
done
echo "Closed this host to Docker's bridges (docker0, br-+), IPv4 and IPv6"
