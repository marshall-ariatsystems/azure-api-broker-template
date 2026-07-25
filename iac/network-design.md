# Network and DNS design (private endpoint + NSG IP filtering, on your existing VNet)

> Spec owner: `spec/azure-api-key-broker-spec.md` §7. This design builds **around** your existing private ingress path (site-to-site VPN, ExpressRoute, or an SD-WAN/edge-appliance route into the VNet) rather than proposing new connectivity.

## 1. The existing asset (read-only, EXISTING-NETWORK CONSTRAINT)

The environment already has an Azure VNet with a **private ingress path** from on-prem plus **VPN ingress**. This template only ADDS subnets, an NSG, a private endpoint, and a private DNS zone to a VNet you already have; **it never creates or modifies your existing VNet peering, gateways, routes, network appliances, or tunnels. Those are referenced read-only.** No IaC resource, config change, runbook step, or `az` command in this deliverable mutates any pre-existing network infrastructure.

| Existing asset | How this design uses it | Created by this IaC? |
|---|---|---|
| Azure VNet (carries your private ingress + VPN) | Adds TWO subnets: one delegated for Function VNet integration, one for the private endpoint | No (reuses existing VNet) |
| Private ingress route (on-prem → Azure) | NSG allow rule for the on-prem CIDR | No (referenced as a CIDR allow rule) |
| VPN ingress | NSG allow rule for the VPN client CIDR | No (referenced as a CIDR allow rule) |
| On-prem DNS | **PREREQUISITE:** conditional forwarding for `privatelink.azurewebsites.net` to a resolver inside the VNet (§3.1) | No (operator task) |

## 2. Default posture: private endpoint + NSG IP filtering (spec §7.1)

Inbound reaches the broker **only** through a private endpoint in your existing VNet, and the IP allow/deny list is enforced by an **NSG on the private endpoint subnet**. Public network access is disabled. Outbound vendor calls leave over Flex Consumption VNet integration.

Implemented in `iac/foundation.bicep` + `iac/modules/private-endpoint-subnet.bicep`:

- `Microsoft.Network/privateEndpoints` on the Function app, `groupIds: ['sites']`
- Private endpoint subnet with **`privateEndpointNetworkPolicies: 'Enabled'`**
- NSG on that subnet:
  - `DenyBlockedSource*` is the **blacklist** (`blockedSourceCidrs`), priority 100+, evaluated first
  - `AllowIngress*` is the **whitelist** (`onPremIngressCidr`, `vpnClientCidr`) on TCP 443, priority 200+
  - `DenyAllInbound` is the catch-all at priority 4000
- `publicNetworkAccess: 'Disabled'` on the Function app
- `virtualNetworkSubnetId` + `vnetRouteAllEnabled: true` on a **separate** delegated subnet for outbound

### 2.1 Why the NSG, and not access restrictions

This one bites people. **App Service access restrictions are not evaluated for traffic arriving through a private endpoint.** From [Microsoft Learn](https://learn.microsoft.com/en-us/azure/app-service/overview-access-restrictions#how-it-works):

> When traffic reaches App Service, it first evaluates if the traffic originates from a private endpoint or is coming through the default endpoint. **If the traffic is sent through a private endpoint, it sends directly to the site without any restrictions. Restrictions to private endpoints are configured using network security groups.**

So `siteConfig.ipSecurityRestrictions` is **not** the IP filter in this design. It is retained in `foundation.bicep` purely as defense-in-depth for the public default endpoint, which is disabled anyway. The NSG is the only thing filtering source IPs on the private path. Delete it believing the access restrictions still cover you and **you have no IP filtering at all** — every source that can route to the private endpoint gets in.

### 2.2 Why `privateEndpointNetworkPolicies` must be `Enabled`

NSGs are **bypassed** on private endpoint subnets by default, because network policies are disabled for the subnet. Per [Microsoft Learn](https://learn.microsoft.com/en-us/azure/private-link/private-endpoint-overview#network-security-of-private-endpoints), network policy support must be turned on for NSG and UDR rules to take effect. The module sets this explicitly. Flip it back to `Disabled` and every rule in §2 stops applying: nothing errors, nothing logs, the filtering is simply gone.

### 2.3 Why two subnets

The Flex Consumption VNet-integration subnet is delegated to `Microsoft.App/environments` and, per [Microsoft Learn](https://learn.microsoft.com/en-us/azure/azure-functions/functions-networking-options#subnets), "can't already be in use for other purposes (like private or service endpoints)". The private endpoint therefore needs its own undelegated subnet.

> **Delegation note:** Flex Consumption requires `Microsoft.App/environments`. This **differs** from Elastic Premium and Dedicated plans, which use `Microsoft.Web/serverFarms`. Using the wrong one fails integration.

Sizing: the integration subnet minimum is **/27** (default here is `/26`); the private endpoint subnet needs only a handful of addresses (default `/28`).

## 3. DNS

The private endpoint's A record lives in a `privatelink.azurewebsites.net` private DNS zone created by this template and **linked** to your existing VNet (`registrationEnabled: false`, so resolution only; the template never registers records for your VMs). Clients **inside** the VNet resolve the private IP automatically.

### 3.1 On-prem / VPN resolution: OPERATOR PREREQUISITE

Clients outside the VNet do **not** use Azure DNS, so they will not see the private zone. Before callers on-prem or on VPN can reach the broker, the DNS admin must conditionally forward `privatelink.azurewebsites.net` (and `azurewebsites.net`, if the broker hostname is a CNAME into it) to a resolver that sits **inside** the VNet. That is either an **Azure DNS Private Resolver** inbound endpoint or an existing DNS forwarder VM. Azure's platform resolver at `168.63.129.16` is only reachable from within the VNet, so on-prem cannot forward to it directly.

**This is not deployed by this template**, and it is not optional. Without it, on-prem clients resolve the public name, get a public IP, and fail against a Function with public access disabled. It is deliberately left out of the IaC because it touches DNS infrastructure the template has no business mutating, and because many orgs already operate a suitable forwarder.

Verify from on-prem before onboarding anyone:

```bash
nslookup <funcapp>.azurewebsites.net
# must return the private endpoint IP, not a public one
```

Get the IP the record should point at:

```bash
az network private-endpoint show -g <rg> -n <prefix>-pe \
  --query 'customDnsConfigs[0].ipAddresses[0]' -o tsv
```

## 4. Fallback posture: access restrictions only (no private endpoint)

Set `deployPrivateEndpoint: false`. The Function keeps its public default endpoint with `ipSecurityRestrictions` scoped to your on-prem/VPN CIDRs as the only inbound control, and **no private DNS work is required**.

Treat this as a downgrade. Traffic traverses the public front end and is filtered at the App Service layer by source IP, instead of never being publicly routable in the first place. Choose it only when the DNS forwarding in §3.1 is not achievable. Cost drops by the private endpoint's ~$7/month.

## 5. Outbound / fixed egress IP (spec §7.3)

If the vendor allowlists a specific outbound IP, use the existing VNet integration plus a **NAT Gateway** on the integration subnet for a stable egress IP. If the org already has a fixed egress path through its network edge, reuse it. A NAT Gateway is an optional add-on and is not in the baseline cost.

## 6. Verification (deploy-time, by the admin)

1. **DNS:** from on-prem, `nslookup <funcapp>.azurewebsites.net` returns the private endpoint IP (§3.1).
2. **Allowed source:** from a host inside `onPremIngressCidr`, `curl -v https://broker.contoso.com/api/health` succeeds.
3. **Blocked source:** from a host inside any `blockedSourceCidrs` range, the same call times out at the NSG. You want a TCP timeout, not an HTTP 403. A 403 means you are hitting the public endpoint and the private path is not in use.
4. The Function's default hostname refuses connections from the public internet (`publicNetworkAccess: Disabled`).
5. **NSG is actually in force:** confirm `privateEndpointNetworkPolicies` is `Enabled` on the PE subnet. If it reads `Disabled`, every rule in §2 is being bypassed and you are wide open on the private path.
   ```bash
   az network vnet subnet show -g <vnet-rg> --vnet-name <vnet> -n <prefix>-pe-subnet \
     --query privateEndpointNetworkPolicies -o tsv
   ```
6. **Outbound:** the vendor call originates from the VNet integration subnet (vendor-side allowlist logs, or `az network nic show-effective-route-table`).
