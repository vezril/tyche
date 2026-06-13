#!/bin/sh
# NFR-2 release-gate instrumentation (E7.S3 AC-4): capture EVERY outbound
# connection from the app container for a period (default 24 h) and summarize
# the distinct destinations. Expected result during normal use (excluding
# link/re-link flows): Plaid endpoints only — no telemetry, no CDN, no fonts.
#
# Usage:   ./scripts/ops/capture-network.sh [duration-seconds] [container]
# Output:  ./netcap-<timestamp>.pcap + a unique-destination summary on stdout.
# Needs:   docker; runs tcpdump inside the app container's network namespace
#          via a throwaway nicolaka/netshoot container (no change to the app).
set -eu

DURATION="${1:-86400}"
CONTAINER="${2:-$(docker compose ps -q app)}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
PCAP="netcap-${STAMP}.pcap"

echo "capturing ${DURATION}s of traffic from container ${CONTAINER} -> ${PCAP}" >&2
docker run --rm --net "container:${CONTAINER}" -v "$(pwd):/cap" nicolaka/netshoot \
  timeout "${DURATION}" tcpdump -i any -w "/cap/${PCAP}" 'tcp[tcpflags] & tcp-syn != 0 and src net not 127.0.0.0/8' \
  || true # timeout's exit code is expected

echo "--- unique outbound destinations (verify: Plaid only) ---"
docker run --rm -v "$(pwd):/cap" nicolaka/netshoot \
  sh -c "tcpdump -nn -r /cap/${PCAP} 'tcp[tcpflags] & tcp-syn != 0' 2>/dev/null \
         | awk '{print \$5}' | sed 's/\.[0-9]*:\$//' | sort -u"
echo "--- reverse-lookup each IP above; all must resolve to *.plaid.com ---"
