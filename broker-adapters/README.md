# Application adapters

Adapters translate familiar application configuration into a local bridge URL plus the non-secret
`broker-managed` placeholder. The first adapters are OpenAI, Anthropic, and generic HTTP.

Adapters must never read, accept, generate, persist, log, or forward a usable vendor credential.
