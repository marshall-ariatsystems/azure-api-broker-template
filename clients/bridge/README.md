# broker-bridge

`broker-bridge` is a per-run loopback compatibility bridge. It is given an HTTPS broker discovery URL at invocation time; discovery and authenticated session state remain in memory only for the serving process lifetime.

The serving process performs Authorization Code with PKCE before it listens. The invocation carries public bootstrap metadata with the discovery URL (`oidc_issuer`, `oidc_client_id`, and `oidc_audience`; `oidc_scopes` is optional). It opens the system browser without printing an authorization URL or token. After a bridge restart there is no session, and requests receive `login required; run broker-bridge login`.

```bash
cd clients/bridge
npm run serve -- --broker 'https://broker.example/discovery?oidc_issuer=https%3A%2F%2Fid.example&oidc_client_id=broker-bridge&oidc_audience=api%3A%2F%2Fbroker'
npm run run -- --broker 'https://broker.example/discovery?oidc_issuer=https%3A%2F%2Fid.example&oidc_client_id=broker-bridge&oidc_audience=api%3A%2F%2Fbroker' --preset openai -- node app.mjs
```

The bridge always listens on `http://127.0.0.1:8079`. `run` supplies the application only a loopback base URL and the harmless `broker-managed` placeholder, then stops the bridge when the application exits. It does not inherit credential-shaped caller environment values.

Use `--preset openai`, `anthropic`, or `generic`; `--set NAME=VALUE` is limited to the generated loopback URL or `broker-managed`. Public bootstrap values, login state, PKCE material, and credentials are never written locally.

## Distribution

Build a local distributable with `npm run bundle && npm run package`. SEA packaging requires an official fuse-bearing Node host; on systems using a shared-libnode build, set `NODE_SEA_BINARY=/path/to/official/node` (RD-001 gap 4).

Verify a downloaded release against its `SHA256SUMS`. Generate local artifact evidence with `node scripts/release-evidence.mjs`; it writes `_directives/ED/ED-V007-002-artifact-evidence.json`. Signing, provenance attestation, and multi-platform publication happen in the `bridge-v*` tag pipeline (`.github/workflows/release-bridge.yml`). The artifact stores no credential or product state, and none is needed to verify it.
