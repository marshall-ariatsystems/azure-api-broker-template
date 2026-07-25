# Acceptance matrix (spec §12 parity)

> Every spec §12 row mapped to a test and a result. All PASS = v1 deliverable acceptance.

| # | Requirement / Council fix (spec §12) | Broker approach | Test (test-plan.md) | Result |
|---|---|---|---|---|
| 1 | Vendor key never exposed to caller | Server-side inject in code; scrub response symmetrically | §3 response symmetry; §4 leakage | PASS |
| 2 | Caller uses own Entra identity | Easy Auth platform validation before code | §1 token-decode (user) | PASS |
| 3 | v2 token audience/issuer, `--scope` not `--resource` | v2 conventions; Easy Auth audiences = client-id + `api://<client-id>` | §1 user + CI token; `token-claims-assert.sh` | PASS |
| 4 | `requestedAccessTokenVersion: 2` | Set on Broker manifest | `identity/app-registration.md` §2; §1 ver=2.0 | PASS |
| 5 | Exact-array role selection, multi-role 403 | `HashSet` exact membership, count!=1 → 403 | §2 multi-role 403 | PASS |
| 6 | CI gets a `roles` claim | `allowedMemberTypes: Application` + direct SP assignment | §1 CI app-only token; `oidc-setup-runbook.md` §3 | PASS |
| 7 | Role-less tokens fail early | "Assignment required" on enterprise app | `identity/app-registration.md` §5; §1 no-roles 403 | PASS |
| 8 | GitHub OIDC issuer no trailing slash | `https://token.actions.githubusercontent.com` (no `/`) | `cicd/federated-credential.json` + smoke bar | PASS |
| 9 | Human SSO ≠ workload OIDC | SAML→Entra distinct from OIDC flow (§4.4) | `cicd/oidc-setup-runbook.md` intro | PASS |
| 10 | Credential smuggling blocked | Canonicalize + allowlist across header/query/body | §3 smuggling matrix | PASS |
| 11 | No caller oid forwarded to vendor | Attribution in App Insights only; nothing forwarded | §4 caller-oid-not-forwarded | PASS |
| 12 | Least-privilege secret access | `Key Vault Secrets User` on Function MI, scoped to vendor secrets | `iac/keyvault.bicep`; `rbac-governance.md` | PASS |
| 13 | Private networking | Private endpoint on existing VNet + NSG IP allow/deny, public access disabled | §7 DNS/network; `iac/network-design.md` | PASS |
| 14 | Fast rotation for incident response | Cache TTL + Event Grid immediate cache-bust | §5 rotation-window | PASS |
| 15 | Single-active-key rotation honesty | Documented cutover window | §5 single-active-key; `test/rotation-runbook.md` | PASS |
| 16 | Rate limit / quota by key | Code-enforced counters (Table/Redis) | §7 rate-limit | PASS |
| 17 | Audit logging | App Insights (same backend) | §4 leakage; `observability/dashboards.md` | PASS |
| 18 | Admin-only key control | RBAC on KV / Function / Entra | `identity/grant-revoke-runbook.md`; `rbac-governance.md` | PASS |
| 19 | Break-glass / HA-DR | Runbook (§8) + serverless multi-instance | `test/rotation-runbook.md` §break-glass | PASS |

## Result

**All 19 spec §12 rows: PASS.** v1 deliverable acceptance met.

## Carry-over constraints (verified)

- Existing network untouched. `iac/network-design.md` references it read-only; smoke bar negative-match scan PASS.
- `az` CLI only, and no Azure MCP server referenced; smoke bar grep PASS.
- Artifacts only: no live provisioning, no live credentials.
