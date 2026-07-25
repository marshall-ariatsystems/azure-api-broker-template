# Turnkey Managed Broker Service

## Recommendation

Offer this as a **managed secure AI access service**, not as a service that
resells or holds customers' vendor API keys.

The recommended initial model is customer-hosted and provider-managed:

1. The customer owns its Azure subscription, Key Vault, identity tenant, and
   vendor accounts.
2. We deploy, configure, monitor, and support the broker in the customer's
   Azure environment.
3. Developers use the broker bridge and familiar application configuration,
   without being given vendor API keys.
4. We charge an implementation fee and a recurring managed-service fee.

This makes the secure path the convenient path while keeping the customer in
control of its secrets and cloud boundary.

## Customer value

The service should cover:

- Broker and identity deployment
- Vendor onboarding and approved-model policy
- Bridge/client installation, upgrades, and compatibility support
- Usage limits, rate limits, cost controls, and audit visibility
- Monitoring, alerting, operational support, and incident handling
- Key rotation procedures and access reviews
- Documentation and developer onboarding

The product promise is simple: application teams use their approved AI tools
normally; the broker makes secure access the default and hides the operational
complexity.

## Operating model

| Area | Customer owns | Provider operates |
| --- | --- | --- |
| Azure subscription and tenant | Yes | Delegated, limited access only |
| Vendor accounts and API keys | Yes | Broker retrieves keys only at runtime |
| Key Vault and secret lifecycle | Yes | Rotation process and configuration support |
| Broker infrastructure | Yes, deployed in its environment | Deployment, upgrades, monitoring, support |
| Developer integration | Application ownership | Bridge tooling, onboarding, troubleshooting |
| Policy and approvals | Final authority | Recommended controls and enforcement |

Never place customer vendor keys in a shared support system, deployment
pipeline, ticket, or developer workstation. The broker should retrieve a key
only when it needs to make the approved outbound request.

## Access and security guardrails

- Use least-privilege delegated Azure access scoped to the required customer
  subscription or resource group.
- Let the customer revoke delegated access and retain break-glass control.
- Keep each customer's resources, identities, logs, and network boundary
  isolated from every other customer.
- Do not log vendor API keys, bearer tokens, prompts, or sensitive response
  bodies by default.
- Establish an explicit support, incident-response, retention, and service
  level agreement before production onboarding.
- Keep customer approval required for material policy changes, new vendors, or
  broadened access scopes.

Azure Lighthouse supports delegated management of customer resources with
scoped access, and Azure Managed Applications can package repeatable managed
deployments while retaining customer-side governance. See the official
documentation: [Azure Lighthouse onboarding](https://learn.microsoft.com/en-us/azure/lighthouse/how-to/onboard-customer) and [Azure Managed Applications overview](https://learn.microsoft.com/en-us/azure/azure-resource-manager/managed-applications/overview).

## Product path

| Stage | Offering | Goal |
| --- | --- | --- |
| 1. Concierge deployments | Managed deployment in each customer's Azure environment | Validate the service and learn real operating needs |
| 2. Repeatable product | Standardized deployment, optionally an Azure Managed Application or private Marketplace offer | Reduce deployment effort and simplify procurement |
| 3. Hosted platform | Multi-tenant managed broker, only if justified by customer demand | Add scale, accepting substantially higher security and compliance responsibility |

Start with stage 1. It has the best trust posture and the fastest route to
revenue. Productize common deployment and operations work after several
customer deployments demonstrate which parts are truly repeatable.

For Marketplace commercial models and transaction options, see [Microsoft
Marketplace transaction considerations](https://learn.microsoft.com/en-us/partner-center/marketplace-offers/marketplace-commercial-transaction-capabilities-and-considerations).

## Positioning

> Your teams use approved AI tools normally. We make secure access the easiest
> route and operate the infrastructure behind it.

