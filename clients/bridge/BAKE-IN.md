# Stateless bridge integration

Start the bridge with an invocation-only HTTPS discovery URL and point the application at its fixed loopback endpoint. The application receives only its generated compatibility URL and `broker-managed` placeholder.

```sh
node /opt/broker-bridge/broker-bridge.mjs run --broker https://broker.example/discovery --preset generic -- "$@"
```

The serving process owns its in-memory authenticated session. A process restart loses that session; the calling application must complete the external public-login precondition again. The bridge is loopback-only and does not create local configuration, token, profile, or credential state.
