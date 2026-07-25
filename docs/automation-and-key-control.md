# Automation and key control

Design analysis: what has to give when an unattended application needs to work through the
broker, and what does not.

Status: analysis only. Nothing here is implemented. The open question at the end is unresolved
and blocks the rate limiter follow-up work.

---

## Contents

- [The framing that matters](#the-framing-that-matters)
- [The compromise ladder](#the-compromise-ladder)
- [Server-side signing](#server-side-signing)
- [What automation genuinely cannot do](#what-automation-genuinely-cannot-do)
- [The outHeaders invariant](#the-outheaders-invariant)
- [Availability](#availability)
- [Blast radius](#blast-radius)
- [Open question](#open-question)

---

## The framing that matters

"Broker control of the keys" is not one property. It is five, and automation pressures them at
very different prices.

| | Property |
|---|---|
| P1 | Key never resides on the caller |
| P2 | Key never transits to the caller |
| P3 | Revocation is central and instant (role assignment, not rotation) |
| P4 | Every use is attributed to an identity |
| P5 | Use is rate-bounded per identity |

P1 and P2 are what the README sells. P3, P4, and P5 are where the operational value actually
lives: they are the reason grant and revoke stops being a fleet-wide key rotation.

This split is the whole answer to the automation question. P1 and P2 can be traded in scoped,
time-boxed, observable ways while P3, P4, and P5 survive intact. Knowing which property a given
compromise actually costs tells you whether it is cheap or load-bearing.

---

## The compromise ladder

Cheapest to most expensive in security terms.

| Tier | Compromise | Cost |
|---|---|---|
| T0 | Pure proxy, header injection | None. Covers plain REST with header, bearer, or basic auth. |
| T1 | Burst or token-bucket quota, per-identity tiers | Structurally free. |
| T2 | Per-vendor header allowlist, narrower credential-name set for bodies | Some smuggling surface. |
| T2.5 | Per-vendor server-side signer modules | Per-vendor maintenance. P1 and P2 fully intact. |
| T3 | Multi-role identity | **Already taken.** See `MULTI_ROLE_VENDOR_ROUTING`. Costs blast radius on token compromise. |
| T4 | Broker mints a short-lived vendor-scoped token and hands it to the app | Breaks P1 and P2. Keeps P3 (TTL), P4 (minted under an identity), P5 (mint is rate-limited). |
| T5 | Break-glass checkout of the real key | Keeps only the audit record of the checkout event. |

Note that the broker already does T4 internally. `oauth2cc` mode mints a vendor access token via
client_credentials and injects it server-side (`getOauthToken` in `broker.js`). Exposing that
mint to the caller rather than consuming it in-process is a configuration surface on existing
machinery, not new machinery.

T4 degrades the properties it appears to preserve, in ways worth stating plainly:

- **P3 goes from instant to eventual.** Revocation becomes "wait for the TTL." A 15-minute
  token means a 15-minute window where a revoked identity still has live vendor access.
- **P4 goes coarse.** Today every vendor call is logged. After a mint you log the mint, and the
  vendor serves N calls the broker never sees. Audit granularity drops from per-request to
  per-checkout, which is the opposite of what you want during an incident.
- **P5 stops binding the thing you care about.** Rate-limiting mints does not rate-limit vendor
  calls. One mint plus a runaway loop is unbounded vendor spend.

---

## Server-side signing

T2.5 is the tier that matters most for automation, and it is easy to miss.

Signing *is* authentication. The broker holds the key and sees the full request, so it can
compute the vendor's signature at call time: SigV4, HMAC over body, Stripe-style, and similar.
No credential leaves Azure. Per-request audit and quota are unchanged. The generic proxy becomes
a proxy plus per-vendor signer plugins.

This also covers two cases that look like gaps but are not:

- **Presigned URLs.** The broker mints the presigned URL server-side and returns the URL. It
  embeds a signature, not the key. That is a scoped, TTL-bounded capability with P1 and P2
  preserved, which is strictly better than T4, and it is the right answer for direct
  browser-to-vendor upload.
- **Streaming and SSE.** The current code buffers via `arrayBuffer()`, but that is an
  implementation choice rather than an architectural limit. Node can stream through.

### What T2.5 costs

- **Per-vendor maintenance.** Each signing scheme, versioned. SigV4 is stable. Smaller vendors
  churn theirs.
- **Opaque failure modes.** A signature mismatch returns a flat 403 with no diagnostic. A
  canonicalization bug is indistinguishable from a wrong key, and it fails 100% of the time
  rather than intermittently.
- **Full body buffering becomes mandatory.** Payload-hash schemes need the complete body, so
  signing and streaming are mutually exclusive per request.

### What it does not cost

An earlier version of this analysis claimed the header allowlist collides with signature
canonicalization, forcing an ordering tradeoff. It does not. Recorded here so it is not
re-derived.

The current pipeline in `broker.js`:

```
314  allowlist filter    -> outHeaders      all caller-driven mutation done
317  build vendor URL                       path and query final
337  inject credential   -> outHeaders      broker's own material
358  fetch(url, headers: outHeaders, body)
```

Strip, finalize URL, inject, dispatch. That is already the order a signer needs: everything
signable is final before the credential-bearing header is computed. A signer plugin drops in at
roughly line 345 in place of the static injection, with final method, URL, query, headers, and
buffered body all available.

The order that is correct for the broker's own reasons (validate caller input first, add secrets
last, keep the secret-touching step adjacent to dispatch so it cannot leak into logging or error
paths in between) is the same order signing wants. There is no tradeoff to make.

---

## What automation genuinely cannot do

Smaller than it first appears, once T2.5 is on the table.

1. **SDKs that hardcode the vendor hostname and sign locally**, with no custom-endpoint support.
   Rare. Otherwise you point the SDK at the broker with dummy credentials and let the broker
   sign.
2. **Inbound webhook signature verification.** The broker is not in that path; the receiver
   needs the shared secret to verify. Solvable with a broker verify endpoint, at the cost of a
   round trip per webhook.
3. **Non-HTTP protocols.** gRPC, raw TCP, proprietary binary.

Separately, the **bootstrap problem** does not go away: the application must authenticate as
something. Honest framing:

- Azure-hosted, or OIDC-federated (GitHub Actions, Kubernetes workload identity): managed
  identity, genuinely zero secret. N to 0.
- Off-Azure with a client secret or certificate (the `clients/setup-pi.sh` case): one Entra
  credential instead of N vendor keys. N to 1, not N to 0. The gain is real (central revocation,
  scoped, auditable, no direct vendor access) but it is not the same claim.

---

## The outHeaders invariant

Prep work, independent of whether signer plugins are ever built. `outHeaders` is currently final
after injection by instinct rather than by enforcement. Cheap to pin now, expensive later: a
post-injection mutation added months from now stays harmless until plugins land, then breaks
every signed vendor with an undiagnosable 403.

- [ ] Comment at the injection site (`broker.js` ~337-345) declaring the invariant: `outHeaders`
      is final after injection, nothing may write to it before `fetch`, and why.
- [ ] Test asserting no write between injection and dispatch. Either freeze and assert dispatch
      still succeeds, or Proxy-wrap in test and fail on any `set` after the injection step.
- [ ] Fix the one existing violation first: the `oauth2cc` 401 re-mint (`broker.js` ~367)
      patches `outHeaders['authorization']` after dispatch and retries. Harmless for a bearer
      token, since nothing is signed over it. A signer must re-run the signer on retry rather
      than swap the header, because the timestamp is inside the signature and will have moved.
- [ ] Only then consider `Object.freeze(outHeaders)` post-injection as a runtime guard.

Ordering matters: the freeze cannot land until the retry path stops mutating in place.

---

## Availability

The broker is in the hot path for every vendor call, so its dependencies are now serial with the
vendor's own availability.

Per-request external dependencies:

```
Entra -> Easy Auth -> Function instance
      -> Table Storage    (quota)            UNCACHED, every request
      -> Key Vault        (secret)           5 min cache
      -> vendor token ep  (oauth2cc only)    cached to expiry minus 60s
      -> vendor
```

The quota store is the only uncached external call on the request path. Storage is
`Standard_LRS` at a 99.9% SLA. Key Vault is 99.99% and sits behind a 5-minute cache. Functions is
99.95%.

**This means the least-available component sits uncached in front of the most-available one, and
`RATE_LIMIT_FAIL_MODE` defaults to `closed`.** A storage blip takes down all automation rather
than degrading enforcement. This was introduced alongside the quota work, not inherited.

### Beyond the open/closed binary

The current lever is brick-everything or enforce-nothing. A third shape exists:

**Local-first, write-behind.** Count in memory, enforce locally, flush deltas to Table
asynchronously. The request path never blocks on storage, and a Table outage degrades enforcement
instead of stopping traffic. Plus a **degraded cap** rather than fail-open: when the store is
unreachable, tighten the local limit to `limit / maxInstances` so the worst case stays bounded.

What makes this more plausible here than usual: `alwaysReadyInstanceCount: 1` and
`maximumInstanceCount: 10`. At low concurrency most traffic lands on one instance, so in-memory
counting is nearly exact, and the distributed store is only load-bearing during scale-out.

### Why local-first is not a strict improvement

1. **Multi-instance undercount is the main case, not an edge case.** Ten instances each locally
   allowing 60/min is 600/min against a 60/min intent. The degraded-cap divisor addresses the
   outage case but not normal operation, because an instance does not know the live instance
   count.
2. **Ephemeral instances lose deltas.** Flex scales aggressively and in-flight counts die with
   the instance. The undercount is systematic and biased toward exactly the high-traffic periods
   when scale-out happens.
3. **The write-behind window is an abuse window.** A burst inside the flush interval is locally
   approved before Table ever sees it.
4. **It puts reconciliation logic inside a security control.** The current implementation is dumb
   but obviously correct while the store is up. Two sources of truth is where subtle enforcement
   bugs live.
5. **The one-always-ready argument rests on a config default, not an invariant.** Someone sets it
   to 3 and the reasoning silently degrades with no signal.

Local-first buys availability and sells enforcement precision. It is a different trade, not a
better one.

---

## Blast radius

The same centralization property, viewed from the security side rather than the availability
side.

The broker uses a single system-assigned managed identity that can read every vendor secret.
Before the broker, compromising one application leaked one vendor key. With it, compromising the
broker leaks all of them. The Key Vault RBAC in `iac/keyvault.bicep` is per-secret scoped, but it
is one identity holding all of those scopes, so the scoping buys nothing against broker
compromise specifically.

Separate function apps per vendor would fix it, at roughly the cost multiple that the README's
~$40/month positioning is built on.

---

## Open question

**What is the quota actually for?** The two plausible answers point in opposite directions, so it
is worth deciding explicitly rather than splitting the difference.

- **Abuse control**, meaning stop a compromised identity from draining a vendor account.
  Precision matters, undercount is a real failure. Keep the counter authoritative and
  centralized, and fix availability by making Storage more available (ZRS or GZRS instead of LRS)
  rather than by weakening the counter.
- **Cost and blast limiting**, meaning stop a runaway loop from burning spend. Approximate is
  fine, since 600/min still catches the runaway that would otherwise have done 100k. Availability
  wins, and local-first is clearly right.

This blocks the rate limiter follow-up. Until it is answered, `RATE_LIMIT_FAIL_MODE` stays at
`closed` and the availability regression above stands.
