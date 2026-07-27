# Tessera Node broker client

`broker-client` is a small ESM client for calling a vendor API through Tessera
without distributing a vendor credential. It acquires a caller token for the
broker; the broker authorizes the caller and injects the vendor credential
server-side.

## Install

```bash
npm install broker-client @azure/identity
```

## Configure and call

`BROKER_BASE` is the route root, including `/api/broker`. `BROKER_SCOPE` is the
broker audience scope. Neither setting is a vendor credential.

```bash
export BROKER_BASE='https://<broker-host>/api/broker'
export BROKER_SCOPE='api://<broker-app-id>/.default'
```

```js
import { ninja, preflight } from 'broker-client';

const readiness = await preflight('<vendor-route>');
if (readiness.status !== 200) throw new Error(`broker authorization failed: ${readiness.correlationId}`);

const organizations = await ninja('/v2/organizations');
```

`preflight()` is read-only and returns only an HTTP status and correlation ID.
`ninja()` retries `429` responses only for `GET` and `HEAD`; writes are sent once
unless the caller supplies an explicit idempotency contract. Caller-supplied
credential-shaped headers are rejected.

## Development

```bash
npm test
```

The repository-level [Apache-2.0 license](../../LICENSE) applies.
