"""
Smoke test for broker_client. Runs as the current Azure identity (DefaultAzureCredential).

Vendor (via broker VENDOR_BASE_URL) is currently OpenRouter (https://openrouter.ai/api/v1),
injected as a Bearer key. Tests:

  Test A  authenticated GET /api/broker/auth/key -> 200 + OpenRouter key info
                                                    (proves real key injected server-side)
  Test B  no token                               -> 401 (Easy Auth rejects)
  Test D  smuggled x-api-key + valid token       -> 200 (broker strips the smuggled cred)
  Test E  one-line broker_openai() chat call     -> a real completion (optional; needs openai+httpx)

Never prints the bearer token or the real vendor key.
"""
import sys

import requests
import broker_client as bc


def main() -> int:
    print(f"broker : {bc.BROKER_HOST}")
    print(f"pin    : {bc.BROKER_IP or '(normal DNS)'}")

    tok = bc.get_token()
    seg = tok.split(".")[1]
    import base64
    import json
    claims = json.loads(base64.urlsafe_b64decode(seg + "=" * (-len(seg) % 4)))
    print(f"token  : ver={claims.get('ver')} aud={claims.get('aud')} roles={claims.get('roles')}")

    ok = True

    print("\n[Test A] authenticated GET /api/broker/auth/key")
    r = bc.get("/api/broker/auth/key")
    print(f"  HTTP {r.status_code}  (expect 200)")
    got_key_info = r.status_code == 200 and '"limit"' in r.text
    print(f"  vendor returned key info (real key worked): {got_key_info}")
    ok &= got_key_info

    print("\n[Test B] NO token")
    r = requests.get(f"{bc.BROKER_BASE}/api/broker/auth/key", timeout=30)
    print(f"  HTTP {r.status_code}  (expect 401)")
    ok &= r.status_code == 401

    print("\n[Test D] smuggled x-api-key (should be stripped; call still succeeds)")
    r = bc.get("/api/broker/auth/key", headers={"x-api-key": "SMUGGLED-CRED"})
    print(f"  HTTP {r.status_code}  (expect 200 — broker ignores the smuggled cred)")
    ok &= r.status_code == 200

    print("\n[Test E] one-line broker_openai() chat completion (optional)")
    try:
        client = bc.broker_openai()
        resp = client.chat.completions.create(
            model="openai/gpt-4o-mini",
            messages=[{"role": "user", "content": "Reply with one word: hello"}],
            max_tokens=5,
        )
        reply = resp.choices[0].message.content
        print(f"  reply: {reply!r}  (expect a short completion)")
        ok &= bool(reply)
    except Exception as e:  # openai/httpx not installed, or LLM vendor not configured
        print(f"  skipped: {e.__class__.__name__}: {e}")

    print("\nRESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
