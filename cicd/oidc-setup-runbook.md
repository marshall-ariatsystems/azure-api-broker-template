# OIDC setup runbook: GitHub Actions → Entra (az CLI only)

> Spec owner: §4.4. **GitHub SAML SSO** (human sign-in to GitHub) and **OIDC workload identity federation** (Actions machine auth) are two different things, and people conflate them constantly. SAML/user-MFA does NOT protect the Actions OIDC flow; workload-identity Conditional Access is a separate, blocking-only regime.

## 1. Create the CI workload app registration + service principal

```bash
az ad app create --display-name "Broker CI Workload (ORG/REPO prod)"
CI_APP_ID=$(az ad app list --display-name "Broker CI Workload (ORG/REPO prod)" --query '[0].appId' -o tsv)
az ad sp create --id "$CI_APP_ID"
CI_SP_ID=$(az ad sp show --id "$CI_APP_ID" --query id -o tsv)
```

## 2. Create the federated identity credential (spec §4.4, issuer NO trailing slash)

> **Critical:** the issuer is **exactly** `https://token.actions.githubusercontent.com` (**no trailing slash**, per GitHub's OIDC reference). Issuer/subject/audience matching is exact and case-sensitive. A stray slash here costs people an afternoon, because the failure surfaces as a generic token-exchange error that names nothing.

Using the JSON in `cicd/federated-credential.json`:

```bash
BROKER_CLIENT_ID='00000000-0000-0000-0000-000000000000'  # PLACEHOLDER
az ad app federated-credential create --id "$CI_APP_ID" \
  --parameters cicd/federated-credential.json
```

Verify the issuer has no trailing slash and the audience is exact:

```bash
az ad app federated-credential list --id "$CI_APP_ID" --query '[].{issuer:issuer,aud:audiences,subject:subject}' -o table
# issuer must end with 'githubusercontent.com' (no '/'), audiences must be ['api://AzureADTokenExchange']
```

## 3. Assign the CI SP a DIRECT per-key broker app role (spec §4.3, NO group nesting)

```bash
ROLE_C_ID=$(az ad app show --id "$BROKER_CLIENT_ID" --query 'appRoles[?value==`VendorApi.KeyC.Invoke`].id' -o tsv)
az ad app role assignment add \
  --id "$BROKER_CLIENT_ID" \
  --role "$ROLE_C_ID" \
  --assignee-object-id "$CI_SP_ID" \
  --assignee-principal-type ServicePrincipal
```

## 4. Configure the GitHub Actions secrets (NO vendor key, NO Azure client secret)

Set these as GitHub Actions **variables** rather than secrets. They're non-sensitive identifiers:

```bash
gh variable set AZURE_CLIENT_ID        --body "$CI_APP_ID"
gh variable set AZURE_TENANT_ID        --body "$TENANT_ID"
gh variable set AZURE_SUBSCRIPTION_ID  --body "$SUB_ID"
gh variable set APP_ID_URI             --body "api://$BROKER_CLIENT_ID"
gh variable set BROKER_HOST             --body "broker.contoso.com"
```

> **Never** set a vendor key, an Azure client secret, or a bearer token as a GitHub secret. The only credential is the short-lived OIDC token minted per-run.

## 5. Runner reachability (spec §A5, chosen path not open)

The primary path is self-hosted runners in the Azure VNet, or GitHub-hosted runners with Azure private networking, reaching the broker over the private path directly. That's why the workflow (`cicd/call-broker.yml`) pins `runs-on: [self-hosted, azure-vnet]`.

There is an alternative if you need one: controlled public ingress (Front Door Premium PL / App Gateway WAF) that still enforces Easy Auth. It carries real cost, and it is not the default here. Use the self-hosted in-VNet runner unless something forces your hand.

## Microsoft Learn + GitHub Docs citations

- GitHub OIDC to Azure (issuer no trailing slash): https://learn.microsoft.com/en-us/azure/developer/github/connect-from-azure-openid-connect
- Workload identity federation trust with GitHub: https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-create-trust-github
- `az account get-access-token` (scope=v2): https://learn.microsoft.com/en-us/cli/azure/account?view=azure-cli-latest#az-account-get-access-token
- Access token claims reference: https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference
- Conditional Access for workload identities: https://learn.microsoft.com/en-us/entra/identity/conditional-access/workload-identity
- GitHub: about security hardening with OIDC: https://docs.github.com/en/actions/how-tos/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect
- GitHub: SAML SSO vs OIDC concepts: https://docs.github.com/en/actions/concepts/security/openid-connect
