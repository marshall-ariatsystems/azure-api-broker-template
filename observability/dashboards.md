# Dashboards: per-user + per-key (spec §10, §11)

> spec §10: "record per-caller (oid) and per-key usage, 4xx/5xx counts, latency, and vendor-error rates" so a noisy team or a leaking key is visible **without exposing secrets**. spec §11 is metadata-only: never log vendor request/response bodies, bearer tokens, or vendor keys.

## 1. Per-user dashboard (caller `oid`)

| Panel | KQL (App Insights / Log Analytics) |
|---|---|
| Requests by caller | `requests \| summarize count() by tostring(customDimensions.oid)` |
| 401/403 by caller | `requests \| where resultCode startswith "40" \| summarize count() by tostring(customDimensions.oid), resultCode` |
| 429 (rate-limited) by caller | `requests \| where resultCode == 429 \| summarize count() by tostring(customDimensions.oid)` |
| Latency p95 by caller | `requests \| summarize p95(duration_s) by tostring(customDimensions.oid)` |
| Errors by caller | `exceptions \| summarize count() by tostring(customDimensions.oid)` |

## 2. Per-key dashboard (selected vendor-key **alias**, never the key)

| Panel | KQL |
|---|---|
| Requests by key alias | `requests \| summarize count() by tostring(customDimensions.keyAlias)` |
| Vendor 401/403 by alias (rotation signal) | `requests \| where resultCode in (401, 403) \| summarize count() by tostring(customDimensions.keyAlias)` |
| Cache-bust events by alias | `customEvents \| where name == "CacheBust" \| summarize count() by tostring(customDimensions.keyAlias)` |
| Rate-limit hits by alias | `requests \| where resultCode == 429 \| summarize count() by tostring(customDimensions.keyAlias)` |
| Quota consumption vs vendor limit | `requests \| summarize calls=count() by tostring(customDimensions.keyAlias) \| extend pct_of_600 = calls / 600.0` |

## 3. What is NEVER logged (spec §11, §6.3)

- The real vendor key value. Only the **alias** goes in, e.g. `vendor-api-key-team-a`.
- The caller's bearer token.
- Vendor request/response bodies on the vendor leg.
- Any credential-bearing header/query/body field. The scrubber redacts these; if anything is logged at all, log only `redacted:true`.

## 4. Alert wiring

Alerts are defined in `observability/alerts.bicep` (4xx/5xx/latency/KV-anomaly/cold-start). Wire them to the admin action group. Page immediately on 401/403 spikes and KV-deny anomalies, since both mean RBAC drift or a compromised MI.
