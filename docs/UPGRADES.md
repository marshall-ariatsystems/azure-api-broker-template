# Upgrade contract

Application releases do not recreate the resource group, Entra applications, managed identities, Key Vault, or policy tables.

## Routine update

```bash
git pull --ff-only
azd deploy admin
azd deploy broker
```

Deploy only the changed service. The admin UI ships with the admin Function, so `azd deploy admin` updates both without changing identity or infrastructure.

Before a release that changes stored documents:

```bash
node deploy/migrate.mjs plan --account "$(azd env get-value AZURE_STORAGE_ACCOUNT_NAME)" --release vX.Y.Z
node deploy/migrate.mjs apply --account "$(azd env get-value AZURE_STORAGE_ACCOUNT_NAME)" --release vX.Y.Z
```

`plan` is read-only. `apply` snapshots every non-secret policy document before compatible transforms. It never reads Key Vault. Keep connection IDs, policy row keys, and Key Vault secret names stable across releases.

Use `azd provision` only for reviewed infrastructure changes. Run ARM what-if first. To roll application code back, deploy the previous admin or broker package; do not restore or expose credential values.
