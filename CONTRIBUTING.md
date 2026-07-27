# Contributing

Thanks for helping. This is a template repository: it owns the broker code and the mechanism.
Instance repos created from it own identity, branding, and releases. **Fix bugs here, not in
instance repos.** A fix made in an instance repo never reaches anyone else.

## Before you start

Read [`spec/azure-api-key-broker-spec.md`](spec/azure-api-key-broker-spec.md). It is the source of
truth, not the code. If the code disagrees with the spec, that is a bug in the code. The one
exception is a deliberate spec change, in which case say so in the PR and change both.

Only one broker implementation is supported:

| | |
|---|---|
| `function-node/` | Node 22, Flex Consumption. The only supported production runtime. |

A change to broker behavior requires updates to `function-node/`. Doc-only, IaC-only, and client-only changes are exempt.

## Reporting

Security vulnerabilities do not go in the issue tracker. See [SECURITY.md](SECURITY.md).

For a bug, include the component, what you expected, what happened, and the spec section it
contradicts if you know it. Redact tenant IDs, object IDs, and hostnames from any logs you paste.

For a feature, describe the operator problem first. Features that require a caller to hold a vendor
credential, in any form, will be declined.

## Development setup

```bash
git clone <your-fork>
cd tessera-api-broker

# Node broker
cd function-node && npm install && cd ..

# Admin console (localhost-only)
cd admin-ui && npm install && cd ..
```

No Azure credentials are needed to build, test, or run the checks below. Nothing in this repo
provisions live resources.

## Testing

```bash
# Runtime and package syntax checks
npm test --prefix function-node
npm test --prefix clients/bridge
npm test --prefix clients/node
python3 -m py_compile clients/broker_client.py clients/broker_config.py clients/broker_preflight.py
dotnet build clients/dotnet/NinjaBrokerClient.csproj --no-restore --nologo -v q
```

The public distribution repository contains runtime and deployment material. Keep development tests
and internal validation evidence in the private engineering repository.

## Coding standards

Placeholders, never real values: `11111111-1111-1111-1111-111111111111` for tenant,
`00000000-0000-0000-0000-000000000000` for client ID, `broker.contoso.com` for hostname. They are
grep-findable, and the smoke bars check for them.

No absolute paths. Resolve from the script or repo root; an absolute path leaks the build machine's
directory structure.

Allowlist, never denylist, for anything touching credential locations. A denylist is a bug even when
it currently passes.

Azure-touching artifacts use the `az` CLI only. No Azure MCP server references, and a smoke bar
enforces that.

**Never mutate pre-existing network infrastructure.** The template adds one delegated subnet and
references your VNet read-only. No IaC resource, runbook step, or `az` command may touch existing
peering, gateways, routes, appliances, or tunnels. A negative-match scan enforces this, and it is
the rule people talk themselves out of first.

Comments explain *why*, and they are kept accurate. A stale comment is a defect.

## Commits and pull requests

Conventional commits:

```
feat: add oauth2cc refresh-ahead to the Node broker
fix: reject vendor-named route when the role claim is absent
docs: correct the Key Vault RBAC scope in the sysadmin guide
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.

In the PR description, state:

1. What changed and why.
2. The spec section it implements or corrects.
3. Whether the Node broker, bridge, or a shipped client surface was updated (or why it was not).
4. That the published runtime/package validation commands pass.

Run `git diff --cached` before you commit and confirm no key, real GUID, real hostname, or build
output is in it. See the "Never commit" list in [SECURITY.md](SECURITY.md).

## License

By contributing you agree your contributions are licensed under the
[Apache License 2.0](LICENSE), the same license as the project.
