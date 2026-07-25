#!/usr/bin/env bash
# BACKEND pane — live-tail the broker's server-side audit log from Application Insights.
#
# Every line is one brokered call, showing: which caller (oid), which app (azp), which role,
# which Key Vault secret was selected, the inject mode, the vendor endpoint + status, and the
# broker's own processing time. The real vendor key is NEVER logged — it only exists in Azure.
#
# App Insights ingestion lags a bit (~15-60s), so lines appear shortly after the frontend calls.
set -euo pipefail
APPID="${APPINSIGHTS_APPID:-3bf83742-0a51-4a4f-9359-1a22c410f729}"

bold=$'\e[1m'; grn=$'\e[32m'; red=$'\e[31m'; dim=$'\e[2m'; rst=$'\e[0m'
echo "${bold}==================================================================${rst}"
echo "${bold} BACKEND  —  Azure key broker (server-side audit log)${rst}"
echo " auth + role selection + ${bold}KEY INJECTION${rst} happen here, in Azure."
echo " ${dim}the vendor key is never logged and never leaves this side${rst}"
echo "${bold}==================================================================${rst}"

declare -A seen
while true; do
  rows=$(az monitor app-insights query --app "$APPID" \
    --analytics-query "traces | where timestamp > ago(4m) | where message startswith '[broker]' | order by timestamp asc | project timestamp, message" \
    -o json 2>/dev/null | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    for r in d['tables'][0]['rows']:
        print(r[0] + '\t' + r[1])
except Exception:
    pass" 2>/dev/null || true)

  while IFS=$'\t' read -r ts msg; do
    [ -z "${ts:-}" ] && continue
    k="${ts}${msg}"
    [ -n "${seen[$k]:-}" ] && continue
    seen[$k]=1
    clock="${ts:11:8}"
    if [[ "$msg" == *ALLOW* ]]; then color="$grn"; else color="$red"; fi
    printf '%s%s%s  %s%s%s\n' "$dim" "$clock" "$rst" "$color" "$msg" "$rst"
  done <<< "$rows"

  sleep 4
done
