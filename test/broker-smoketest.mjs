#!/usr/bin/env node
// broker-smoketest.mjs — validate the cxkey key-broker from a Node runtime using
// DefaultAzureCredential, exactly the way your real app will authenticate.
//
// PREREQ (on a box on the broker's private on-prem/VPN ingress path):
//   az login                 # sign in as the user holding ONE vendor-key role
//   npm init -y && npm i @azure/identity
//   node broker-smoketest.mjs
//
// DefaultAzureCredential picks up: az login, VS Code, env vars, or a VM managed
// identity — so this same code works locally, on a prod VM, and in CI.
import { DefaultAzureCredential } from "@azure/identity";
import { lookup } from "node:dns/promises";

const APP_ID = "ce485d55-f7af-40a8-b9d3-12dd64252740";
const HOST = "func-broker-cxapi-csb2cscrdcdka3fy.centralus-01.azurewebsites.net";
const URL = `https://${HOST}/api/broker/anything`;
const SCOPE = `api://${APP_ID}/.default`; // /.default => v2 token
const EXPECT_PRIVATE_IP = "10.0.0.10";

let pass = 0, fail = 0;
const ok = (m) => { console.log(`  ✅ ${m}`); pass++; };
const bad = (m) => { console.log(`  ❌ ${m}`); fail++; };
const hr = () => console.log("-".repeat(64));
const decode = (jwt) => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());

hr(); console.log("1) DNS — are we on the private path?"); hr();
try {
  const { address } = await lookup(HOST);
  console.log(`  ${HOST} -> ${address}`);
  address === EXPECT_PRIVATE_IP
    ? ok(`resolves to the private endpoint (${EXPECT_PRIVATE_IP})`)
    : bad(`does NOT resolve to ${EXPECT_PRIVATE_IP} — likely off-VPN or DNS unwired; calls will fail`);
} catch (e) { bad(`DNS lookup failed: ${e.message}`); }

hr(); console.log("2) Acquire a v2 token via DefaultAzureCredential"); hr();
let token;
try {
  ({ token } = await new DefaultAzureCredential().getToken(SCOPE));
  const c = decode(token);
  console.log(`  token acquired (ver=${c.ver} aud=${c.aud})`);
  console.log(`  roles claim: ${JSON.stringify(c.roles ?? "<none>")}`);
  c.ver === "2.0" ? ok("v2 token") : bad(`expected v2 token, got ver=${c.ver}`);
} catch (e) { bad(`token acquisition failed: ${e.message}`); console.log("\nSUMMARY: aborted"); process.exit(1); }

async function call(headers) {
  const r = await fetch(URL, { headers, signal: AbortSignal.timeout(20000) });
  let body = null; try { body = await r.json(); } catch {}
  return { code: r.status, body };
}

hr(); console.log("Test A — valid token => 200 + server-side key injected"); hr();
try {
  const { code, body } = await call({ Authorization: `Bearer ${token}` });
  console.log(`  HTTP ${code}`);
  if (code === 200) {
    const key = body?.headers?.["X-Api-Key"] ?? body?.headers?.Authorization ?? "<none>";
    // Never print the credential itself — presence and length are enough evidence.
    console.log(`  injected credential echoed by vendor: ${key === "<none>" ? "<none>" : "<redacted>"}`);
    key !== "<none>" ? ok("broker injected a key server-side") : bad("no injected credential echoed");
  } else bad(`expected 200, got ${code}: ${JSON.stringify(body)?.slice(0, 300)}`);
} catch (e) { bad(`request failed: ${e.message}`); }

hr(); console.log("Test B — no token => 401 from Easy Auth"); hr();
try {
  const { code } = await call({});
  console.log(`  HTTP ${code}`);
  code === 401 ? ok("unauthenticated request rejected with 401") : bad(`expected 401, got ${code}`);
} catch (e) { bad(`request failed: ${e.message}`); }

hr(); console.log("Test D — smuggled x-api-key => stripped"); hr();
try {
  const { code, body } = await call({ Authorization: `Bearer ${token}`, "x-api-key": "attacker-supplied-key" });
  console.log(`  HTTP ${code}`);
  if (code === 200) {
    const key = body?.headers?.["X-Api-Key"] ?? "<none>";
    // Print only the verdict — this header may hold the real injected credential.
    console.log(`  vendor saw X-Api-Key: ${key === "attacker-supplied-key" ? "attacker-supplied-key (LEAK)" : "<redacted — not the attacker value>"}`);
    key !== "attacker-supplied-key" ? ok("smuggled key stripped/overwritten") : bad("attacker key leaked — scrub failed");
  } else console.log(`  (skipped strip-check; returned ${code})`);
} catch (e) { bad(`request failed: ${e.message}`); }

hr(); console.log(`SUMMARY: ${pass} passed, ${fail} failed`); hr();
process.exit(fail > 0 ? 1 : 0);
