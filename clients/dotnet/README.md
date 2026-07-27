# Tessera broker client

This release is a self-contained .NET client for calling a vendor API through
Tessera. It contains no vendor credential. The caller authenticates to the
broker with Microsoft Entra; the broker authorizes the request and injects the
vendor credential server-side.

## Configure

Set these non-secret values before running the executable:

```bash
export BROKER_BASE='https://<broker-host>/api/broker'
export BROKER_SCOPE='api://<broker-app-id>/.default'
```

On developer machines, authenticate with `az login`. In CI or services, use a
workload identity supported by `DefaultAzureCredential` and grant that identity
the broker role for the intended route.

## Run

```bash
./broker-client /v2/organizations
./broker-client /v2/webhook PUT '{"url":"https://example.invalid"}'
```

The client retries `429` responses only for `GET` and `HEAD`; writes are sent
once. Before an operational workflow, use `PreflightAsync("<vendor-route>")`
from the `NinjaBrokerClient` API to perform an authenticated, no-side-effect
authorization check and retain only its status and correlation ID.

Verify the downloaded archive against the `SHA256SUMS` file published beside it.
The archive includes this guide and the Apache-2.0 license.
