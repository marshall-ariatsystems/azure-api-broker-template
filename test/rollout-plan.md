# Rollout plan (spec §15 step 5, §11)

> Team-by-team rollout starting with a sandbox vendor key + small Entra group.

## Phase 0: pre-flight (admin)

1. Provision the IaC: `iac/foundation.bicep` + `iac/keyvault.bicep` + `iac/auth.bicep` (placeholders substituted with real tenant/client-id).
2. Create the Broker app registration (`identity/app-registration.md`) with `requestedAccessTokenVersion: 2`, the four app roles, and "Assignment required".
3. Configure Easy Auth audiences = client-id GUID + `api://<client-id>`.
4. Set the CANARY vendor key out-of-band: `az keyvault secret set --vault-name "$KV_NAME" --name vendor-api-key-canary --value '<SANDBOX-KEY>'`.
5. Deploy the Function from source (`docs/SYSADMIN-GUIDE.md` §Part 1).
6. Wire the Event Grid cache-bust subscription (`test/rotation-runbook.md` §2.1).
7. Wire alerts + dashboards (`observability/`).
8. Confirm DNS reachability over the private on-prem/VPN ingress path (`iac/network-design.md` §6).

## Phase 1: canary (admin only)

Assign `VendorApi.Admin.Test` to ONE admin user (it is a User-only role). That admin calls
`broker.contoso.com/v1/health` via `clients/call-broker.sh`, then runs the full
`test/test-plan.md` suite against the canary key.

Don't move on until every test passes, the leakage scan is clean, and injected faults actually
fire the alerts.

## Phase 2: Team A (small group)

- Create the Entra group "Broker KeyA Users"; add 2–3 Team A users.
- Assign `VendorApi.KeyA.Invoke` to the group.
- Set the Team A vendor key: `az keyvault secret set --name vendor-api-key-team-a --value '<KEY-A>'`.
- Team A onboards via `clients/local-dev-quickstart.md`.

Exit gate: one week stable, no 4xx spikes, and the per-user dashboard shows the expected callers and nobody else.

## Phase 3: Team B + CI

Repeat Phase 2 for Team B (`VendorApi.KeyB.Invoke` / `vendor-api-key-team-b`).

Then onboard CI: create the federated identity credential (`cicd/oidc-setup-runbook.md`), assign
the CI SP a DIRECT `VendorApi.KeyC.Invoke` assignment, and set `vendor-api-key-ci`. Add
`cicd/call-broker.yml` to the repo and confirm the token-claim assertion gate runs green.

Exit gate: CI calls succeed and the CI app-only token carries the `roles` claim, which §1 of the test plan proves.

## Phase 4: full rollout

Onboard the remaining teams. Tune `QUOTA_CALLER_PER_MIN` and `QUOTA_KEY_PER_MIN` from what the
per-user and per-key dashboards actually show, not from the defaults. Quarterly access review per
`observability/rbac-governance.md`.

## Rollback

Per team, remove the group/SP app-role assignment (`identity/grant-revoke-runbook.md` §7). The
caller's next token carries no recognized role, so they get a 403.

For the whole broker, disable Easy Auth or stop the Function and callers fail closed. Rollback
exposes no vendor key, because it was never exposed in the first place.
