# Zero-touch bake-in

When **you control the app's repo and deployment**, bake the broker integration in so the developer
does nothing: no key in `.env`, no OAuth code, no manual bridge to run. The app ships already talking
to the broker, and its **runtime identity** (not a key) is what unlocks the vendor.

Two patterns. Pick A for a mixed-language fleet, B for a single-stack app you want dependency-light.

---

## Pattern A: bundled sidecar (language-agnostic)

Ship `broker-bridge.mjs` in the image, start it beside the app, and point the app's vendor base URLs
at loopback. It behaves the same for Python, Node, .NET, or anything else that reads a base URL.

**Same-container (entrypoint).** Start the bridge, then the app:

```dockerfile
# ... your app image ...
COPY clients/bridge /opt/broker-bridge
RUN cd /opt/broker-bridge && npm ci --omit=dev
ENV BROKER_BASE=https://<function-app>.azurewebsites.net/api/broker \
    BROKER_SCOPE=api://<broker-client-id>/.default \
    BRIDGE_PORT=8079
# Bake the repoint into the app's own config:
ENV VENDOR_BASE_URL=http://127.0.0.1:8079/<slug>/v1
# NO vendor key in the image.
COPY entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
```

```sh
#!/bin/sh
# entrypoint.sh — bridge in the background, app in the foreground.
node /opt/broker-bridge/broker-bridge.mjs &
until curl -sf http://127.0.0.1:8079/_bridge/health >/dev/null; do sleep 0.2; done
exec "$@"          # your app's normal start command
```

**Sidecar container (compose / K8s).** Same idea, with the bridge as its own service on the pod's
loopback; the app container sets `VENDOR_BASE_URL=http://127.0.0.1:8079/<slug>/…`. Both containers
share `localhost` in K8s, so there's no service wiring to do.

## Pattern B: in-code client (no extra process)

Wire the broker call straight into the app's HTTP layer using the native client this template ships.
No sidecar. Set the SDK's base URL to `BROKER_BASE/<slug>` and attach an Entra bearer per request:

- Node: `clients/node/ninja-client.mjs` uses `DefaultAzureCredential` with a cached token; generalize
  the path to `/<slug>/…`.
- Python: `clients/broker_client.py`.
- .NET: `clients/dotnet/`.

Most vendor SDKs accept a `baseURL`/`endpoint` option plus a request hook. Point the first at the
broker, add the token in the second, and that's the integration. The vendor key never exists
client-side.

---

## The one wiring step (per app, done by you and invisible to the developer)

`DefaultAzureCredential` needs a runtime identity that holds the vendor role. If the app runs in
Azure (Container Apps, App Service, AKS, a VM), enable a **managed identity** on it and assign that
identity the vendor role. That's the clean production path: no secrets anywhere. On a headless or
non-Azure host, put an SP or federated credential in the environment and `DefaultAzureCredential`
picks it up.

Assign the role to that identity (keep key→identity 1:1) using the onboarding script:

```bash
# principalId = the app's managed identity (or SP) object id
ASSIGNEE_OBJECT_ID=<app-mi-principal-id> ASSIGNEE_TYPE=ServicePrincipal \
VENDOR_NAME=<Vendor> INJECT=oauth2cc BASE_URL=… TOKEN_URL=… \
VENDOR_CLIENT_ID=… VENDOR_CLIENT_SECRET=… \
./cicd/onboard-vendor.sh
```

After that, deploys really are zero-touch. The app authenticates as itself and the broker injects the
vendor credential. Rotating or revoking access becomes one change in the tenant, and the client app
never needs another code push for it.
