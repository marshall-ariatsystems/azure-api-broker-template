# Application adapters

Adapters translate familiar application configuration into a local bridge URL plus the non-secret
`broker-managed` placeholder. The first adapters are OpenAI, Anthropic, and generic HTTP.

Adapters must never read, accept, generate, persist, log, or forward a usable vendor credential.

`presets.mjs` is the first executable adapter contract. It produces runtime-only environment values
for OpenAI, Anthropic, and generic HTTP applications. Its only allowed values are a loopback URL
that includes the configured vendor slug and the `broker-managed` placeholder.
