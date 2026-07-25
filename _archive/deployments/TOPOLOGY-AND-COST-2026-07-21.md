# cxkey Key Broker — E2E Topology & Cost Verification
**Date:** 2026-07-21 · **Baseline being checked:** `kickoff.d/Option D — Serverless Function Key Broker Spec (~$33 mo).md`
**Pricing source:** Azure Retail Prices API (live), region Central US / Zone 2.

---

## 1. End-to-end topology (as deployed)

```
                          TENANT 6a776d8b-0d62-4acb-945a-a51042d17ac0
┌─────────────────────────────┐
│  ON-PREM "Capital" LAN       │
│  Prod VMs (Windows)          │        acquire Entra token (v2)  ┌───────────────────────────┐
│  DNS: DCs 192.168.60.229/230 │◄──────── OIDC / login ──────────►│  Microsoft Entra ID        │
│  VPN clients                 │                                  │  app: cxkey-broker-api     │
└──────────────┬──────────────┘                                  │  appId ce485d55…           │
               │  DNS lookup of broker FQDN                       │  app roles: KeyA/KeyB/KeyC │
               │  ⚠ DCs forward azurewebsites.net → PUBLIC        │  Easy Auth validates token │
               │     ⇒ resolves 20.118.48.4 (public), NOT 10.0.0.10
               │
               │  data path (Meraki vMX private route + VPN ingress)
               ▼
┌───────────────────────────────────────────────────────────────────────────────────────────┐
│  CX_Production_Subscription  (RG CX_Poduction_ResourceGroup)   [ALL NETWORKING LIVES HERE]  │
│                                                                                             │
│   ┌──────────────────────┐   VNet peering (Connected,      ┌────────────────────────────┐  │
│   │ vMX_Meraki VNet      │   forwarded traffic allowed)    │ CX_Production_vNET          │  │
│   │ 10.2.0.0/24          │◄───────────────────────────────►│ 10.0.0.0/16                 │  │
│   │  subnet vMX_Subnet   │                                  │  default 10.0.0.0/24        │  │
│   └──────────────────────┘                                  │   • prod VMs                │  │
│                                                             │   • route: vMX_to_Capital   │  │
│                                                             │   • KV service endpoint     │  │
│                                                             │   • ★ PE pve-broker-cxapi   │  │
│                                                             │       10.0.0.10 (groupId    │  │
│                                                             │       sites, Approved)      │  │
│                                                             │  AzureBastionSubnet 10.0.1.0/24│
│                                                             │  vn-broker-cxapi 10.0.2.0/26 │  │
│                                                             │   (delegated Microsoft.App, │  │
│                                                             │    STAGED, UNUSED)          │  │
│                                                             └──────────────┬─────────────┘  │
│   Private DNS zone privatelink.azurewebsites.net (linked to CX_Production_vNET)             │
│     A: func-broker-cxapi-…centralus-01      → 10.0.0.10                                     │
│     A: func-broker-cxapi-…scm.centralus-01  → 10.0.0.10                                     │
└────────────────────────────────────────────────────────────┼──────────────────────────────┘
                                        Private Link (cross-subscription)
                                                             │
┌────────────────────────────────────────────────────────────┼──────────────────────────────┐
│  cx-dev-team subscription  (RG rg-dev-sandbox)              ▼                               │
│                                            ┌──────────────────────────────────────────┐    │
│                                            │ func-broker-cxapi  (Azure Function)       │    │
│                                            │  Flex Consumption, Node 22, Running       │    │
│                                            │  publicNetworkAccess: DISABLED (PE-only)  │    │
│                                            │  public front-end IP 20.118.48.4          │    │
│                                            │  1 always-ready 2 GiB instance            │    │
│                                            │  System-assigned MI b93151aa…             │    │
│                                            └───────┬───────────────────────┬──────────┘    │
│                                        MI: KV Secrets User        outbound vendor call      │
│                                                    ▼                       ▼                 │
│                        ┌───────────────────────────────┐    ┌────────────────────────────┐ │
│                        │ Key Vault kv-broker-cxapi     │    │ VENDOR (PoC: httpbin.org)  │ │
│                        │  RBAC on; public net Enabled  │    │  real key injected server- │ │
│                        │  secrets: vendor-key-a/b/c    │    │  side, never leaves Azure  │ │
│                        │  (PoC fakes sk-fake-*)        │    └────────────────────────────┘ │
│                        └───────────────────────────────┘                                    │
│   Storage stkeymgmtcx (deploy pkg + AzureWebJobsStorage, connection-string auth)            │
│   Application Insights (per-oid/per-key telemetry, alerts)                                   │
└─────────────────────────────────────────────────────────────────────────────────────────────┘

REQUEST FLOW: caller → (token from Entra) → resolve FQDN → [SHOULD BE 10.0.0.10 via vMX/peering]
  → PE → Function → Easy Auth validates iss/aud/role → select vendor key from KV by single app role
  → scrub smuggled creds → inject real key → call vendor → return.
★ BLOCKER: DNS step resolves public 20.118.48.4, so the private PE path is currently bypassed.
```

## 2. Azure services inventory

| # | Service | Resource | Subscription | Role in solution |
|---|---------|----------|--------------|------------------|
| 1 | Azure Functions (Flex Consumption, Node 22) | func-broker-cxapi | cx-dev-team | The broker; token-gated key injection + proxy |
| 2 | Microsoft Entra ID (app reg + Easy Auth) | cxkey-broker-api | tenant | Caller identity, app roles, token validation |
| 3 | Key Vault | kv-broker-cxapi | cx-dev-team | Holds real vendor keys (PoC fakes today) |
| 4 | Storage (StorageV2) | stkeymgmtcx | cx-dev-team | Deployment package + AzureWebJobsStorage |
| 5 | Application Insights | (function-linked) | cx-dev-team | Telemetry, per-caller usage, alerts |
| 6 | VNet + peering | CX_Production_vNET ↔ vMX_Meraki | CX_Production | Private data path from on-prem/VPN |
| 7 | Private Endpoint | pve-broker-cxapi (10.0.0.10) | CX_Production | Private inbound to the Function |
| 8 | Private DNS zone | privatelink.azurewebsites.net | CX_Production | FQDN→10.0.0.10 **inside Azure only** |
| 9 | Bastion | CX_BASTION | CX_Production | Admin access (pre-existing) |
| — | **DNS Private Resolver** | **NOT DEPLOYED (proposed)** | CX_Production | Would let on-prem DNS resolve 10.0.0.10 |

## 3. Cost verification vs the ~$33/mo projection

### Baseline as originally costed (spec §13) — **no PE, no resolver**
| Component | ~$/mo |
|---|---|
| Flex Consumption, 1 always-ready 2 GiB (compute) | 26 |
| Application Insights | 5 |
| Key Vault + Function storage | ~2 |
| Networking (reuse Meraki VNet + access restrictions) | 0 |
| **Baseline total** | **~33** |

### Live retail-price deltas for the deployed / proposed additions
| Item | Meter (Azure Retail Prices API) | Cost |
|---|---|---|
| Private Endpoint (**deployed**) | Standard Private Endpoint, $0.01 / hr × 730 | **+$7.30/mo** (+ ~$0.01/GB data) |
| DNS Private Resolver — inbound endpoint (**proposed**) | Private Resolver Inbound Endpoint, flat | **+$180/mo** |
| DNS Forwarding Ruleset (if used) | Private Resolver DNS Forwarding Ruleset | +$2.50/mo |
| Forwarder VM alternative (B1s–B2s) | Compute | +$8–30/mo |
| hosts-file / `curl --resolve` (per box) | — | $0 |

### Scenarios — does the projection still stand?
| Scenario | Networking approach | Total/mo | Verdict |
|---|---|---|---|
| **A. Deployed PE + DC pinpoint DNS zone** ← **CHOSEN** | PE + one AD-integrated single-record zone on the DCs | **~$40** | ✅ Holds; private path, centrally managed, zero per-box config |
| B. Deployed PE + per-box hosts file | PE + hosts entry on each box | ~$40 | ✅ Holds, but unmanaged sprawl — superseded by A |
| C. Deployed PE + DNS Private Resolver | PE + managed resolver | ~$220 | ❌ ~6.6× over — see Appendix A |
| D. "Revert to spec baseline" (no PE) | access restrictions only | n/a | ⛔ **Infeasible for on-prem callers** (Azure requires a PE) — see §4 |
| E. Public + IP allowlist (no PE) | public endpoint locked to egress IP | ~$33 | ✅ Only true-$33 path, but abandons private-network posture |

## 4. Decision (2026-07-21) & why the original $33 design was infeasible

**Decision: keep the deployed private endpoint and solve on-prem DNS with a single AD-integrated "pinpoint" zone on the domain controllers (Scenario A). Budget: ~$40/mo. The managed DNS Private Resolver (Scenario C, ~$220/mo) is explicitly NOT adopted.**

**Why not literally revert to the ~$33 no-PE spec (Scenario D)?** The original spec (§7.1) assumed on-prem/VPN users could reach the Function privately using only access restrictions + VNet integration, with no private endpoint. That is **not achievable on Azure**, confirmed against current Microsoft Learn docs:
- Flex Consumption **VNet integration is outbound-only** — *"you can't use virtual network integration to provide inbound access to your app."*
- **Inbound IP access restrictions** evaluate the caller's **public** source IP, so a private Meraki/VPN CIDR never matches.
- **Service-endpoint ("Virtual Network" type) access restrictions do not extend to on-premises** — Microsoft's guidance is to use Private Link / Private Endpoint for on-prem access.
- **"Public network access disabled" + access restrictions are mutually exclusive** — disabling public access forces a private endpoint anyway.

⇒ For on-prem/VPN callers, **a private endpoint is mandatory** for a private path. The earlier "spec drift" to the PE was therefore the *correct* Azure-required design, not an error. The only way to hit a literal $33 with no PE is Scenario E (public endpoint locked to the office/VPN public egress IP), which trades the private-network posture for internet transport (still TLS + IP + Entra-token + app-role gated).

**Net vs the sign-off number:** the ~$33 projection becomes **~$40/mo** (one private endpoint). That ~$7/mo delta is the honest cost of doing on-prem private access the only way Azure supports it. Centralized DNS is achieved for **$0** via the pinpoint zone rather than the ~$180/mo managed resolver.

## 5. On-prem DNS change — runbook (the one change that completes the private path)

On the CX domain controllers (`192.168.60.229` / `192.168.60.230`, AD-integrated DNS), create a **pinpoint forward-lookup zone** whose name is the broker's exact FQDN, holding a single apex A record → the private endpoint. This overrides resolution for *only* that one name; the rest of `azurewebsites.net` is unaffected.

**PowerShell (run once on a DC; AD replication carries it to both):**
```powershell
$fqdn = "func-broker-cxapi-csb2cscrdcdka3fy.centralus-01.azurewebsites.net"
Add-DnsServerPrimaryZone -Name $fqdn -ReplicationScope "Domain"
Add-DnsServerResourceRecordA -ZoneName $fqdn -Name "@" -IPv4Address "10.0.0.10"
```

**Verify (from a DC and from any VPN client):**
```powershell
Resolve-DnsName func-broker-cxapi-csb2cscrdcdka3fy.centralus-01.azurewebsites.net
# expect: 10.0.0.10   (NOT the public 20.118.48.4)
```

Notes: apex A record (`-Name "@"`) resolves as "(same as parent folder)". Only the runtime hostname is needed; if private Kudu/deploy is ever required, add a second pinpoint zone for `...scm.centralus-01.azurewebsites.net`. TLS/Host still validate because only the name→IP mapping changes — the client keeps sending the FQDN in SNI/Host.

---

## Appendix A — DNS Private Resolver (evaluated, not adopted)

A managed **Azure DNS Private Resolver** (inbound endpoint in `CX_Production_vNET` + conditional forwarder on the DCs for `azurewebsites.net`) would centralize private DNS with zero per-box config. **Rejected on cost:** the inbound endpoint is **~$180/mo** (Azure Retail Prices API, flat per-endpoint — no hourly/cheap tier), a ~$187/mo swing over baseline that pushes the solution to ~$220/mo (~6.6× the projection). For a single broker with one stable PE IP, the free DC pinpoint zone (§5) delivers the same hands-off outcome. Revisit the resolver only if the org later needs fleet-wide resolution of many `privatelink.*` names or dynamically-changing private IPs.
