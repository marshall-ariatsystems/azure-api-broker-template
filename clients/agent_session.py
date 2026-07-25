#!/usr/bin/env python3
"""
Live multi-turn session through the key broker (proxy model — vendor key stays in Azure).

This is the "just start a session" test: every turn is a real LLM call routed
host -> broker -> OpenRouter, authenticated as your pi-agent identity, with the real
vendor key injected server-side. Per-turn latency is printed so you can feel the overhead.

Run:
    source clients/broker.env
    clients/.broker-venv/bin/python clients/agent_session.py            # default model
    clients/.broker-venv/bin/python clients/agent_session.py openai/gpt-4o     # pick a model

Ctrl-C / Ctrl-D to quit.
"""
import sys
import time

sys.path.insert(0, sys.path[0] or ".")
from broker_client import broker_openai, BROKER_API, BROKER_IP

DEFAULT_MODEL = "openai/gpt-4o-mini"


def main() -> int:
    model = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_MODEL
    client = broker_openai()
    messages = [{"role": "system", "content": "You are a concise, helpful assistant."}]

    print(f"live session -> {model}")
    print(f"via broker    {BROKER_API}  (pinned -> {BROKER_IP})")
    print("type a message; Ctrl-C to quit\n")

    turns, total_ms = 0, 0.0
    while True:
        try:
            user = input("you> ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if not user:
            continue
        messages.append({"role": "user", "content": user})
        t = time.perf_counter()
        try:
            r = client.chat.completions.create(model=model, messages=messages)
        except Exception as e:
            print(f"err> {e.__class__.__name__}: {e}\n")
            messages.pop()
            continue
        dt = (time.perf_counter() - t) * 1000
        reply = r.choices[0].message.content
        messages.append({"role": "assistant", "content": reply})
        turns += 1
        total_ms += dt
        print(f"ai>  {reply}")
        print(f"     [{dt:.0f} ms | {r.usage.total_tokens} tok | turn {turns}]\n")

    if turns:
        print(f"\n{turns} turns, avg {total_ms / turns:.0f} ms/turn")
    return 0


if __name__ == "__main__":
    sys.exit(main())
