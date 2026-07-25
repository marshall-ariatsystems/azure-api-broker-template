# Developer security runbook

> The hard requirement (spec §0): real vendor API keys **never leave Azure**. They must not appear in local source code, GitHub repository secrets, GitHub Actions logs, browser developer tools, `.env` files, local configuration files, request URLs, client headers, or client logs.

## Prohibited locations for the vendor key (never do any of these)

- Local source code. No hardcoded keys, no commented-out keys.
- `.env` files. The only thing in `clients/sample.env` is the broker host + tenant + App ID URI.
- GitHub repository secrets or Codespaces secrets.
- GitHub Actions logs, job outputs, or step summaries.
- Browser developer tools / network tab. The broker returns only the vendor response.
- Request URLs or query strings. The broker scrubs these (spec §6.3), and you must never add one.
- Client headers. `Authorization: Bearer` carries YOUR Entra token, never a vendor key.
- Local configuration files, shell history, or `~/.azure`. Your `az` token is fine; a vendor key is not.
- Any developer device, ever.

## What you DO hold

- Your **Entra identity** (via `az login`).
- A short-lived **v2 access token** for `api://<brokerClientId>/.default`, acquired per session.
- The broker **hostname** (`broker.contoso.com`), **tenant id**, and **App ID URI**, which are non-sensitive identifiers.

## The golden rule

> You authenticate with your own identity; the broker injects the vendor key server-side. You never read, store, or transmit the vendor key. If you ever find yourself wanting to "just grab the key for a quick test", stop. You don't have it, and you don't need it. Call the broker.

## If you suspect a key is exposed

1. Tell the admin immediately.
2. The admin rotates the key (`identity/grant-revoke-runbook.md` §6) and revokes the role that selected it.
3. The broker's 5-min cache TTL (or immediate Event Grid cache-bust) picks up the new value.

## Caller attribution (spec §6.4)

The broker logs your `oid`/`azp` and request-id in Application Insights **for attribution only**. These are NEVER forwarded to the vendor: no `x-broker-caller-*` header, no caller bearer on the vendor leg. The vendor sees only the broker's request.
