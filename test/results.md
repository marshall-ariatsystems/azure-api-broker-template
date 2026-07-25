# Test results, v1 (smoke-bar evidence)

> Run: `bash test/run-smoke-bars.sh` → **37 passed, 0 failed** (exit 0). No live Azure credentials; artifacts-only.

## Summary

| Bar group | Count | Result |
|---|---|---|
| Status files A1–A8 schema-valid | 8 | PASS |
| iac/outputs.json hostname + principalId | 1 | PASS |
| identity v2 issuer + fields | 1 | PASS |
| app-roles.json ≥3 Key* roles each→one alias | 1 | PASS |
| Bicep builds clean (foundation, keyvault, module, auth, alerts) | 5 | PASS |
| JSON valid (4 files) | 4 | PASS |
| FIC issuer no-trailing-slash + audience exact | 1 | PASS |
| call-broker.yml parse + id-token:write + no secrets + --scope + assertion + no --resource | 6 | PASS |
| call-broker.sh broker.contoso.com + --scope + no --resource + no literal key | 4 | PASS |
| Existing-network read-only negative-match scan | 1 | PASS |
| No Azure MCP server referenced | 1 | PASS |
| Broker code: exact HashSet select + count!=1 403 + allowlist scrub + no caller-oid forward | 3 | PASS |
| acceptance-matrix.md all PASS (19 spec §12 rows) | 1 | PASS |
| **Total** | **37** | **all PASS** |

## Spec §12 acceptance matrix: all 19 rows PASS

See `test/acceptance-matrix.md`. Every security property of the APIM design is preserved: vendor key never exposed to caller; caller uses own Entra identity; v2 tokens (`--scope`, not `--resource`); `requestedAccessTokenVersion: 2`; exact-array role selection with multi-role 403 (default; opt-in `MULTI_ROLE_VENDOR_ROUTING` enables vendor-named multi-role routing); CI gets a `roles` claim (`Application` member type + direct SP assignment); role-less tokens fail early; GitHub OIDC issuer no trailing slash; human SSO ≠ workload OIDC; credential smuggling blocked (allowlist, not denylist); no caller oid forwarded to vendor; least-privilege secret access (scoped RBAC); private networking (private endpoint on existing VNet + NSG IP filtering); fast rotation (cache TTL + Event Grid cache-bust); single-active-key honesty; code-enforced rate limits; App Insights audit logging; admin-only key control; break-glass + HA-DR.

## Carry-over constraints (verified by smoke bars)

- Existing network untouched. Bar 10: no `az` command, no Bicep resource, and no runbook step mutates any pre-existing network infrastructure (VNet peering, gateways, routes, appliances, or tunnels). Referenced read-only as the existing private route.
- `az` CLI only. Bar 11: no Azure MCP server referenced.
- Artifacts only: no live provisioning, no live credentials.
- No no-mistakes until the very end (per captain's instruction).

## Runtime tests (spec §12.1, §15 step 5): defined, to be executed at deploy time

`test/test-plan.md` defines the runtime/behavioral suite: token-decode (user + CI), multi-role 403, credential-smuggling matrix (header/query/body), leakage scan, rotation-window (TTL + Event Grid bust + 401-invalidation), DNS reachability (private resolves / public refuses), rate-limit 429. These run against live Azure once the admin provisions the IaC. The token-claim assertion (`test/token-claims-assert.sh`) is already wired as a mandatory CI gate in `cicd/call-broker.yml`.
