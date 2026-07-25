# Test plan (runtime/behavioral tests, spec §12, §12.1, §15 step 5)

> These are RUNTIME tests, not a static review. The council required decoding REAL tokens and asserting on the claims, exercising the multi-role 403 branch, attempting credential smuggling on every surface, scanning logs for leakage, and proving rotation and DNS reachability.

## 1. Token-decode tests (spec §12.1)

| Test | Action | Expected |
|---|---|---|
| User delegated token | `az account get-access-token --scope "<appIdUri>/.default"`; decode | `ver=2.0`, `aud=client-id GUID (or api://GUID)`, `iss=v2 endpoint`, exactly one `VendorApi.Key*` role |
| CI app-only token | GitHub OIDC → `az account get-access-token --scope ...` | same assertions; proves `allowedMemberTypes=Application` carries the `roles` claim |
| Wrong audience | forge/call with `aud` ≠ broker client-id | broker returns 401 (Easy Auth); NO vendor request sent |
| Wrong issuer / v1 token | call with `--resource` (v1) | broker returns 401 (v1 issuer rejected) |
| No roles | a role-less app-only token | broker returns 403 (zero-role branch); NO vendor request sent |

Automated by `test/token-claims-assert.sh` (CI gate + local dev).

## 2. Multi-role 403 test (spec §5, §12)

| Test | Action | Expected |
|---|---|---|
| Two key roles | assign a principal BOTH `VendorApi.KeyA.Invoke` and `VendorApi.KeyB.Invoke`; acquire token; call broker | broker returns **403** `Caller must have exactly one vendor-key role` with `matchedRoleCount=2`; NO vendor request sent |

Proves the `count != 1` branch rejects the ambiguity instead of silently taking the first match.

## 3. Credential-smuggling matrix (spec §6.3: allowlist, fail-closed)

| Surface | Attempt | Expected |
|---|---|---|
| Header | `x-api-key: attacker`, `X-API-Key`, `apikey`, `api-key`, `authorization` | all rejected (400); caller supplied a credential-shaped field |
| Query | `?api_key=`, `?key=`, `?access_token=`, `?token=`, `?subscription-key=` | rejected (400) |
| Body (JSON) | `{"api_key":"...","key":"...","authorization":"..."}` | rejected (400); credential-shaped body field |
| Forward allowlist | unknown non-credential header `X-Foo: bar` | dropped silently (allowlist); vendor request proceeds without it |
| Response symmetry | vendor error echoes `x-api-key` header or `{"key":"..."}` body | scrubbed to `[redacted]` before returning to caller |

## 4. Leakage test (spec §6.3, §6.4, §10, §11)

| Check | Method | Expected |
|---|---|---|
| Logs contain the key ALIAS | App Insights query | present (`customDimensions.keyAlias`) |
| Logs NEVER contain the real vendor key | App Insights + Log Analytics full-text scan | absent |
| Logs NEVER contain the bearer token | App Insights scan | absent |
| No key in a logged query string | `requests` / `traces` scan | absent (symmetric outbound/on-error scrub) |
| Caller `oid`/`azp` NOT forwarded to vendor | vendor-side request inspection | absent (attribution is logs-only) |

## 5. Rotation-window test (spec §8)

| Test | Action | Expected |
|---|---|---|
| TTL refresh | rotate the KV secret; wait ≤ TTL (5 min) | next broker call uses the new key; old value evicted from cache |
| Immediate cache-bust | rotate the KV secret; Event Grid `SecretNewVersionCreated` fires | `CacheBustFunction` invalidates within seconds; next call uses new key |
| 401/403 invalidation | simulate a vendor 401 after rotation | broker invalidates the cached secret and re-fetches immediately |
| Single-active-key honesty | if vendor allows one live key | document a brief planned cutover window (no zero-downtime assumption) |

## 6. DNS / network reachability test (spec §7.1)

| Test | From | Expected |
|---|---|---|
| Private resolution | on-prem client (over the private ingress path) | `broker.contoso.com` resolves and the broker responds (200/4xx, not connection-refused) |
| VPN resolution | VPN client | same as on-prem |
| Public refusal | a host on the public internet | connection refused / 403 (access restriction; public access disabled) |
| Outbound egress | Function → vendor | originates from the VNet-integrated subnet (verify via vendor allowlist logs or `az network nic show-effective-route-table`) |

## 7. Rate-limit test (spec §9)

| Test | Action | Expected |
|---|---|---|
| Per-caller limit | exceed `RATE_LIMIT_PER_CALLER_PER_MINUTE` | broker returns **429** + `Retry-After` |
| Per-key limit | exceed `RATE_LIMIT_PER_KEY_PER_MINUTE` | broker returns **429** + `Retry-After` |

## 8. Acceptance matrix (spec §12 parity)

See `test/acceptance-matrix.md`. Every spec §12 row maps to one of the tests above with a PASS/FAIL.

## 9. CI gate

`test/token-claims-assert.sh` runs in `cicd/call-broker.yml` as a mandatory step before the broker call. A failed assertion fails the workflow build (no broker call made).
