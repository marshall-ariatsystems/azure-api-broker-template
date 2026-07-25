# Broker demo: "no key on the client, key injected in Azure"

A two-pane live demo that shows both halves at once:

- **LEFT (backend)** is the Azure broker's server-side audit log. For every call it shows the
  caller identity, app role, which Key Vault secret was selected, the inject mode, and the vendor
  status. **The real vendor key is never logged and never leaves Azure.**
- **RIGHT (frontend)** is the pi agent, which holds **no API key at all**. It proves the point by
  trying its placeholder "key" directly against the vendor (→ 401), then does real LLM work through
  the broker. That works, because the broker injects the real key server-side.

## Run it

```bash
# one-time: bootstrap the client identity (creates venv + broker.env)
clients/setup-pi.sh          # then put the pi-agent client secret in clients/broker.env

# launch the two-pane demo (tmux)
demo/run-demo.sh             # or: demo/run-demo.sh openai/gpt-4o
```

Type into the right pane. Each turn prints the reply, the broker's server-side actions (from the
`x-broker-*` response headers), and latency. Watch matching `[broker] ALLOW …` lines appear in the
left pane. App Insights lags ~15–60s, so they trail slightly.

Prefer separate terminals? Run each by hand:
```bash
# terminal 1 (backend)
demo/backend-watch.sh
# terminal 2 (frontend)
source clients/broker.env && clients/.broker-venv/bin/python demo/frontend.py
```

## Talking points

1. **No key on the client.** `[1]` shows no vendor key in the env; the OpenAI client's `api_key` is
   the literal placeholder `broker-managed`.
2. **The client can't reach the vendor on its own.** `[2]` uses that placeholder directly against
   OpenRouter and gets a **401**. So any success *must* be the broker.
3. **It just works through the broker.** `[3]` gets real completions, and each turn's
   `broker: caller=… role=… secret=vendor-key-a inject=bearer vendor=200 key-on-client=false`
   line is the server telling you what it did, minus the key.
4. **Independent proof on the backend.** The left pane is Azure's own audit log, not the client's
   word for it. Same events, same "no key," from the server side.
5. **Fast enough.** Broker overhead is ~70–100 ms/call; the rest is the model. See the latency
   numbers in the session notes.

## What surfaces the backend story
- `function-node/src/broker.js` logs one `[broker] ALLOW/DENY …` line per request (redacted) and,
  when `DEMO_MODE=1`, adds `x-broker-*` response headers. Names and status only, never the key value.
- `DEMO_MODE` is an app setting; turn it off to drop the demo headers for production.
