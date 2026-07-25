# Security policy

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.**

Report privately through either channel:

- GitHub **Security** tab, **Report a vulnerability** (private security advisory). Preferred.
- Email **marsh@cloudmarsh.com** with `SECURITY` in the subject.

Please include the affected component (`function-node/`, `iac/`, `admin-ui/`,
`clients/`), the version or commit, reproduction steps, and what an attacker gains.

You can expect an acknowledgement within 3 business days and a status update within 10. Fixes are
released before public disclosure; we will credit you in the advisory unless you ask otherwise.

## Supported versions

`main` only. This is a template repository, and instance repos created from it are the
responsibility of their operators. Advisories are published against `main`; pull the fix forward
into your instance.

## What is in scope

The security property this project exists to hold:

> A real vendor API key never leaves Azure, and a caller never possesses one.

Anything that breaks that property is in scope. Concretely:

- Any path by which a caller obtains a vendor key, or a key reaches a log, trace, response body,
  error message, or telemetry field.
- Authorization bypass: calling a vendor whose app role you do not hold, including via the
  vendor-named route (`/broker/<vendor>/...`).
- Credential-scrub bypass, where a caller-supplied header, query parameter, or body field survives
  into the outbound vendor request.
- Caller-identity forwarding, meaning `oid` / `azp` reaching the vendor leg.
- Key Vault access scope escalation, or the function's managed identity reading beyond the vendor-key
  secrets.
- IaC in `iac/` that opens public network access, weakens Easy Auth, or grants broader RBAC than the
  spec calls for.
- `admin-ui/` binding to anything other than localhost, or persisting a secret to disk.

Out of scope:

- Vulnerabilities in Azure itself. Report those to
  [MSRC](https://msrc.microsoft.com/report/vulnerability).
- Vendor API vulnerabilities. Report those to the vendor.
- Misconfiguration of your own deployment that the template does not cause (for example, assigning a
  vendor role to the wrong principal).
- Findings that require an attacker who already holds Owner/Contributor on the resource group.
- Dependency CVEs with no exploitable path through this code. Open a normal issue for those.

## Security model

The full threat model and control set is in
[`spec/azure-api-key-broker-spec.md`](spec/azure-api-key-broker-spec.md). Treat it as the source of
truth. A report should assume these controls are already in place:

| Control | Where |
|---|---|
| Caller authentication (Entra, v2 tokens, assignment-required) | Easy Auth, `iac/auth.bicep` |
| Authorization by app role to vendor key | `function-node/src/broker.js` |
| Credential scrub (canonicalize + **allowlist**, not denylist) | `function-node/src/credential-scrubber.js` |
| Key retrieval via system-assigned managed identity, scoped to individual secrets | `iac/keyvault.bicep` |
| No caller identity on the vendor leg; it is logged for attribution only | `function-node/src/broker.js` |
| Network isolation: public access disabled, ingress restricted to your CIDR | `iac/foundation.bicep` |

The operational procedures sit in three runbooks. Prohibited key locations, and what to do when a key
is suspected exposed, are in
[`clients/developer-security-runbook.md`](clients/developer-security-runbook.md). Grant, revoke, and
rotate are in [`identity/grant-revoke-runbook.md`](identity/grant-revoke-runbook.md). The quarterly
access review, the least-privilege checklist, and offboarding live in
[`observability/rbac-governance.md`](observability/rbac-governance.md).

## Never commit

Contributions are rejected on sight if they add any of the following. Check your diff before opening
a PR:

- A real vendor API key, Azure client secret, connection string, or SAS token, whether in code,
  tests, fixtures, `.env`, or a comment.
- A real tenant ID, subscription ID, object ID, or app registration ID. Use the placeholder GUIDs
  (`11111111-…` for tenant, `00000000-…` for client) documented in the README.
- Real hostnames or email addresses. Use `broker.contoso.com` and `contoso.com`.
- Build output (`bin/`, `obj/`, `node_modules/`, `*.zip`). These embed absolute build-machine paths.
