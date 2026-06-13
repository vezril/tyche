#!/bin/sh
# NFR-6 release-gate instrumentation (E7.S3 AC-5): sample the app container's
# CPU% and memory every interval for a period (default: 7 days at 5-minute
# intervals) into a CSV, then print the averages. Gate: ≤ 1 GB RAM and ≤ 5%
# average CPU over 7 days of steady-state use.
#
# Usage:  ./scripts/ops/sample-resources.sh [total-seconds] [interval-seconds]
# Output: ./resources-<timestamp>.csv (timestamp,cpu_percent,mem_used,mem_percent)
set -eu

TOTAL="${1:-604800}"
INTERVAL="${2:-300}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="resources-${STAMP}.csv"

echo "timestamp,cpu_percent,mem_used,mem_percent" > "${OUT}"
END=$(( $(date +%s) + TOTAL ))
echo "sampling every ${INTERVAL}s for ${TOTAL}s -> ${OUT}" >&2
while [ "$(date +%s)" -lt "${END}" ]; do
  docker stats --no-stream --format '{{.CPUPerc}},{{.MemUsage}},{{.MemPerc}}' \
    "$(docker compose ps -q app)" 2>/dev/null \
    | sed "s/^/$(date -u +%Y-%m-%dT%H:%M:%SZ),/" \
    | tr -d '%' >> "${OUT}" || true
  sleep "${INTERVAL}"
done

echo "--- averages (gate: cpu <= 5, mem <= 1GiB) ---"
awk -F, 'NR>1 {cpu+=$2; n++} END {if (n>0) printf "samples=%d avg_cpu=%.2f%%\n", n, cpu/n}' "${OUT}"
