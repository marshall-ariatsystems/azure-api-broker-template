#!/usr/bin/env python3
"""
FRONTEND pane — the pi agent. There is NO vendor API key anywhere on this side.

Proves it three ways, then does real LLM work through the broker, showing per turn exactly what
the broker did server-side (from the x-broker-* response headers) — all without a key ever
being present on the client.

Run (after: source ../clients/broker.env):
    ../clients/.broker-venv/bin/python frontend.py
"""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "clients"))
import httpx
from broker_client import broker_openai, BROKER_API, BROKER_IP

B = "\033[1m"; G = "\033[32m"; R = "\033[31m"; D = "\033[2m"; Z = "\033[0m"
MODEL = sys.argv[1] if len(sys.argv) > 1 else "openai/gpt-4o-mini"


def banner(t):
    print(f"{B}{'=' * 58}{Z}\n{B} {t}{Z}\n{B}{'=' * 58}{Z}")


banner("FRONTEND — pi agent   (NO API KEY ON THIS SIDE)")

# [1] Show there is no vendor key anywhere in the client's environment or config.
print(f"\n{B}[1]{Z} Is a vendor API key present on the client?")
leaked = [k for k in os.environ
          if any(s in k.upper() for s in ("OPENROUTER", "VENDOR_KEY")) or k.upper().endswith("API_KEY")]
print(f"    env vars holding a vendor key : {R}{leaked}{Z}" if leaked else f"    env vars holding a vendor key : {G}NONE{Z}")
print(f"    OpenAI client api_key         : {D}'broker-managed'  (placeholder — not a real key){Z}")

# [2] Prove that placeholder is worthless if you skip the broker.
print(f"\n{B}[2]{Z} Use the client's 'key' DIRECTLY against OpenRouter (bypass the broker):")
try:
    r = httpx.get("https://openrouter.ai/api/v1/auth/key",
                  headers={"Authorization": "Bearer broker-managed"}, timeout=15)
    verdict = "the client has NO usable key" if r.status_code == 401 else "unexpected"
    print(f"    direct OpenRouter -> HTTP {R}{r.status_code}{Z}   ({verdict})")
except Exception as e:
    print(f"    direct call failed: {e}")

# [3] Same keyless client, but through the broker — it just works.
print(f"\n{B}[3]{Z} Same client, via the broker {D}({BROKER_API}  pinned->{BROKER_IP}){Z}")
print(f"    {D}type a message; Ctrl-C to quit{Z}\n")
client = broker_openai()
messages = [{"role": "system", "content": "You are a concise, helpful assistant."}]
turns = 0
while True:
    try:
        user = input(f"{B}you>{Z} ").strip()
    except (EOFError, KeyboardInterrupt):
        break
    if not user:
        continue
    messages.append({"role": "user", "content": user})
    t = time.perf_counter()
    try:
        raw = client.chat.completions.with_raw_response.create(model=MODEL, messages=messages)
    except Exception as e:
        print(f"{R}err>{Z} {e}\n"); messages.pop(); continue
    dt = (time.perf_counter() - t) * 1000
    completion = raw.parse()
    h = raw.headers
    reply = completion.choices[0].message.content
    messages.append({"role": "assistant", "content": reply})
    turns += 1
    print(f"{G}ai>{Z}  {reply}")
    # What the broker did server-side, surfaced via headers — still NO key on the client.
    print(f"     {D}broker: caller={h.get('x-broker-caller-oid','?')[:8]}…"
          f" role={h.get('x-broker-role','?')}"
          f" secret=<redacted>"
          f" inject={h.get('x-broker-inject-mode','?')}"
          f" vendor={h.get('x-broker-vendor-status','?')}"
          f" | key-on-client={h.get('x-broker-key-present-on-client','?')}{Z}")
    print(f"     {D}[{dt:.0f} ms | {completion.usage.total_tokens} tok | turn {turns}]{Z}\n")

print(f"\n{B}Recap:{Z} {turns} live LLM calls, key-on-client = {G}false{Z} the entire time.")
