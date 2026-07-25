# Azure Deployment Plan

> **Status:** Planning

Generated: 2026-07-20

## 1. Project Overview

**Customer:** Capital Excavation

**Goal:** Provision Capital Excavation's existing Azure API Key Broker in Azure while preserving the invariant that vendor keys never leave Azure and without modifying the existing Meraki/VMX infrastructure.

**Path:** Add Components (deploy an artifact-complete existing project)

**Tenant check:** The authenticated tenant is `Capital Excavation` (`capitalexcavation.com`, tenant `6a776d8b-0d62-4acb-945a-a51042d17ac0`). No other tenant is a deployment target.

## 2. Requirements

| Attribute | Value |
|---|---|
| Classification | Production — awaiting user confirmation |
| Scale | Small |
| Budget | Cost-Optimized (~$33/month design target) |
| Subscription | cx-dev-team (3bbb2610-9f72-46b2-9b72-06556e82630e) — awaiting user confirmation |
| Location | `centralus` (user-approved to match the existing Meraki-connected VNet); must support Flex Consumption |
| Target VNet | `vnet-centralus-1` in resource group `CX_group` |
| VNet address space | `172.16.0.0/16` |

### Unresolved environment inputs

- Existing VNet name and resource group
- Available, non-overlapping `/26` integration subnet CIDR
- Meraki/on-prem and VPN-client CIDRs allowed to call the broker
- Capital Excavation broker hostname and private DNS ownership (`broker.contoso.com` is still a placeholder and will not be deployed as-is)
- Vendor backend base URL and key injection contract (header vs bearer)
- Secure, out-of-band values for four vendor secrets (never stored in source, plan, parameters, or logs)

## 3. Components Detected

| Component | Type | Technology | Path |
|---|---|---|---|
| Key broker | API | .NET 8 isolated Azure Functions | `function/src/AzureKeyBroker/` |
| Foundation | Infrastructure | Bicep | `iac/foundation.bicep` |
| Secret/RBAC layer | Infrastructure | Bicep | `iac/keyvault.bicep` |
| Easy Auth | Identity configuration | Bicep + Microsoft Entra | `iac/auth.bicep` |
| Monitoring | Infrastructure | Bicep | `observability/alerts.bicep` |
| Acceptance suite | Validation | Bash/.NET/Bicep checks | `test/` |

## 4. Recipe Selection

**Selected:** Bicep + Azure CLI

**Rationale:** The repository contains hand-authored Bicep and explicitly requires Azure CLI. Deployment is ordered because later layers consume foundation outputs and Entra application identifiers.

## 5. Architecture

**Stack:** Serverless

| Component | Azure Service | SKU |
|---|---|---|
| Broker API | Azure Functions | Flex Consumption FC1 |
| Runtime storage | Storage Account | Standard_LRS |
| Secrets | Key Vault | Standard |
| Telemetry | Application Insights | web |
| Network integration | Existing VNet (`vnet-centralus-1`) | New integration subnet + new private-endpoint subnet |
| Private inbound for Meraki | Private endpoint on Function | Private endpoint + private DNS |
| Identity | Microsoft Entra app registration + system-assigned managed identity | N/A |

**Network constraint (updated):**
- The existing Meraki subnet `snet-centralus-1`, existing NIC `cx877`, and all existing VNet/NSG/Udr resources are immutable and outside deployment scope.
- The deployment may only add new subnets to the existing `vnet-centralus-1` for Function integration and private endpoint.
- This same-VNet design requires:
  1. A dedicated Function integration subnet (delegated to `Microsoft.Web/serverFarms`) for outbound traffic.
  2. A dedicated private-endpoint subnet for the Function App private endpoint, so Meraki can reach the broker privately.
  3. Private DNS for `privatelink.azurewebsites.net` so Meraki on-prem/VPN resolves the endpoint privately.

## 6. Provisioning Limit Checklist

Actual usage and limits will be populated only after the user confirms subscription, location, and existing VNet.

| Resource Type | Number to Deploy | Total After Deployment | Limit/Quota | Notes |
|---|---:|---:|---:|---|
| Microsoft.Web/serverfarms (FC1) | 1 | Pending confirmation | Pending quota check | Flex Consumption |
| Microsoft.Web/sites | 1 | Pending confirmation | Pending quota check | Function app |
| Microsoft.Storage/storageAccounts | 1 | Pending confirmation | Pending quota check | Standard_LRS |
| Microsoft.KeyVault/vaults | 1 | Pending confirmation | Pending quota check | Standard, RBAC |
| Microsoft.Insights/components | 1 | Pending confirmation | Pending quota check | Application Insights |
| Microsoft.Network/virtualNetworks/subnets | 2 | Pending VNet review | Existing VNet address capacity | New integration subnet + new private-endpoint subnet in existing `vnet-centralus-1` |
| Microsoft.Network/privateEndpoints | 1 | Pending limit check | Pending limit check | For Function private inbound from Meraki |
| Microsoft.PrivateDns/privateDnsZones (privatelink.azurewebsites.net) | 1 | Pending limit check | Pending limit check | Private DNS for Meraki on-prem resolution |
| Microsoft.Authorization/roleAssignments | 4 | Pending confirmation | Pending limit check | Secret-scoped Key Vault Secrets User |
| Microsoft Entra applications/servicePrincipals | 1 each | Pending tenant check | Pending tenant limit check | Broker API identity |

**Status:** Pending Azure context and network parameter confirmation.

## 7. Execution Checklist

### Phase 1: Planning
- [x] Analyze workspace
- [x] Gather baseline requirements from the existing spec
- [x] Confirm subscription, location, classification, and environment inputs with user
  - Subscription confirmed: cx-dev-team (3bbb2610-9f72-46b2-9b72-06556e82630e)
  - Location confirmed: centralus
  - VNet confirmed: vnet-centralus-1 in CX_group
- [x] Prepare resource inventory
- [ ] Fetch quotas and validate capacity
- [x] Scan codebase
- [x] Select recipe
- [x] Plan architecture
- [ ] User approved the finalized plan

### Phase 2: Preparation
- [ ] Resolve validation defects and parameterize real Entra/vendor settings
- [ ] Create non-secret environment parameter files
- [ ] Confirm no source, parameter file, command output, or log contains real vendor keys
- [ ] Update status to Ready for Validation

### Phase 3: Validation
- [ ] Compile all Bicep templates
- [ ] Build/test the .NET project
- [ ] Run `bash test/run-smoke-bars.sh`
- [ ] Run Azure deployment validation and **what-if** (HiTL gate before any resource creation)
- [ ] Verify static RBAC scope is limited to the four vendor secrets
- [ ] Confirm what-if shows: integration subnet created, private-endpoint subnet created, private endpoint created, NO changes to `snet-centralus-1`, NO changes to `cx877`, NO Meraki/VMX mutations
- [ ] Record validation proof and update status to Validated

### Phase 4: Deployment
- [ ] Create/confirm target resource group
- [ ] Deploy foundation and capture outputs
- [ ] Create/configure Entra broker application and app roles
- [ ] Deploy Key Vault secret slots and secret-scoped RBAC
- [ ] Set real vendor keys via a secure out-of-band admin operation
- [ ] Deploy Easy Auth and real app settings
- [ ] Build/package/deploy Function code
- [ ] Deploy observability alerts
- [ ] Configure private DNS/custom hostname if approved
- [ ] Verify live resources, identity, RBAC, auth behavior, and endpoint
- [ ] Report the fully-qualified `https://` endpoint and update status to Deployed

## 8. Validation Proof

> The azure-validate workflow must populate this section before setting status to Validated.

| Check | Command Run | Result | Timestamp |
|---|---|---|---|
| Pending | Pending | Pending | Pending |

**Validated by:** Pending azure-validate workflow

## 9. Files to Generate or Update

| File | Purpose | Status |
|---|---|---|
| `.azure/deployment-plan.md` | Deployment source of truth | Created |
| `.azure/*.parameters.json` | Environment-specific, non-secret deployment values | Pending confirmation |
| Existing Bicep/function files | Correct defects found by validation | Pending validation |

## 10. Next Steps

> Current: Azure context confirmation

1. Confirm subscription, region, existing VNet/network inputs, hostname, and vendor contract.
2. Complete quota checks and finalize the plan for approval.
3. Validate, provision, deploy code, and verify the live endpoint.
