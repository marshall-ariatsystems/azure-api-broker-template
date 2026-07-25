# Broker protocol

This is the provider-neutral contract boundary. A broker profile tells a local agent which approved
HTTPS broker to call, how to obtain an access token, and which public route slugs it can present. It
contains no vendor key, secret name, authorization role, injection rule, or vendor authentication
detail.

`broker-profile.schema.json` is the initial JSON Schema. The Azure reference maps its legacy
`BROKER_BASE`, `BROKER_SCOPE`, `BROKER_VENDOR`, and `BROKER_ROUTING_MODE` values onto this contract.

- `strict` consumes the configured local vendor slug and preserves the broker's one-role default.
- `named` preserves the slug for a broker explicitly configured for named, multi-role routing.
