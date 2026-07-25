# Rotation runbook (spec §8)

> spec §8: "The admin rotates a vendor key by setting a new value on the Key Vault secret. The broker's cache TTL (e.g., 5 minutes) picks up the new value on the next refresh; for fast incident response, wire a Key Vault Event Grid `SecretNewVersionCreated` event to a small Function that busts the cache immediately — **faster** than APIM's up-to-4-hour named-value refresh."

## 1. Normal rotation (cache-TTL window, ≤ 5 min)

```bash
KV_NAME='apibkr-optd-kv'
az keyvault secret set --vault-name "$KV_NAME" --name "vendor-api-key-team-a" \
  --value '<NEW-REAL-VENDOR-KEY-OUT-OF-BAND>'
```

The Function's 5-min cache TTL picks up the new value on the next refresh. You get no downtime,
but only if the vendor supports overlapping active keys. Check §4 before you assume it does.

## 2. Immediate cache-bust (incident response, faster than APIM's 4h)

### 2.1 Wire the Event Grid subscription (admin, one-time)

```bash
KV_ID=$(az keyvault show --name "$KV_NAME" --query id -o tsv)
FUNC_ID=$(az functionapp show --name "apibkr-optd-func" --query id -o tsv)
# Event Grid subscription on SecretNewVersionCreated -> the CacheBust function endpoint.
az eventgrid event-subscription create \
  --source-resource-id "$KV_ID" \
  --name "broker-cache-bust" \
  --endpoint-type azurefunction \
  --endpoint "$FUNC_ID/functions/CacheBust" \
  --included-event-types "Microsoft.KeyVault.SecretNewVersionCreated"
```

### 2.2 On rotation, the event fires

`CacheBustFunction` invalidates all cached vendor secrets. The next broker call re-fetches the new
value from Key Vault, typically within seconds.

## 3. 401/403 invalidation (spec §6.2)

If the vendor returns 401/403 (rotated key already invalid upstream), the broker invalidates the cached secret for that alias and re-fetches immediately. No manual action needed.

## 4. Single-active-key honesty (spec §8, council correction)

> Zero-downtime rotation requires the vendor to support overlapping active keys. If the vendor allows only one live key at a time, document the cutover as a brief planned outage window rather than assuming zero downtime.

If your vendor supports overlapping keys, rotate whenever you want; old and new both work through
the TTL window. If it allows only one live key, schedule a brief planned cutover in a low-traffic
window and expect a short burst of vendor 401s until the cache refreshes.

## 5. Break-glass (spec §8)

If the broker is down or its managed identity loses Key Vault access:

1. Verify the MI's `Key Vault Secrets User` assignment on the specific secrets (`identity/grant-revoke-runbook.md` §5).
2. Confirm the Function's VNet integration, private endpoint, and PE-subnet NSG are intact (`iac/network-design.md`).
3. Redeploy the Function from source with the pinned configuration (`docs/SYSADMIN-GUIDE.md` §Part 2).
4. As a last resort, the admin (not developers) issues vendor calls directly from a controlled admin workstation while the broker is restored.
