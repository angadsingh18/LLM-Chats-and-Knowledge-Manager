/**
 * Auth integration check against the configured database, using Fastify's inject (no network port).
 * Run: pnpm --filter @ai-manager/api auth:check
 *
 * The live Google round trip is NOT covered (needs real credentials + a browser). Fake
 * credentials are injected so the redirect/state logic can be exercised.
 */
export {}; // make this file a module so top-level await typechecks

process.env.GOOGLE_CLIENT_ID ??= "fake-client-id.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ??= "fake-secret";

const { sql } = await import("drizzle-orm");
const { buildApp } = await import("../../app.js");
const { config } = await import("../../config.js");
const { db, pool } = await import("../../db/client.js");
const { users, sessions } = await import("../../db/schema.js");
const { createSession } = await import("./sessions.js");
const { SESSION_COOKIE } = await import("./guard.js");

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("ok  -", msg);
}

const app = await buildApp();
const ORIGIN = config.WEB_ORIGIN;
const stamp = Date.now();
const [user] = await db.insert(users).values({ email: `auth-${stamp}@test.local`, googleSub: `sub-${stamp}` }).returning();

try {
  // --- unauthenticated -----------------------------------------------------------------
  assert((await app.inject({ method: "GET", url: "/v1/auth/me" })).statusCode === 401, "no credential -> 401");
  assert(
    (await app.inject({ method: "GET", url: "/v1/auth/me", headers: { authorization: "Bearer aimw_bogus" } })).statusCode === 401,
    "garbage token -> 401",
  );

  // --- Google redirect + state checks (fake creds) --------------------------------------
  const g = await app.inject({ method: "GET", url: "/v1/auth/google" });
  const loc = String(g.headers.location);
  assert(g.statusCode === 302 && loc.startsWith("https://accounts.google.com/"), "GET /google redirects to Google");
  assert(loc.includes("code_challenge=") && loc.includes("code_challenge_method=S256"), "PKCE challenge present");
  assert(loc.includes(encodeURIComponent(`${ORIGIN}/v1/auth/google/callback`)), "redirect_uri goes through the web origin");
  const setCookies = ([] as string[]).concat(g.headers["set-cookie"] as string[]);
  assert(setCookies.some((c) => c.startsWith("aim_oauth_state=") && c.includes("HttpOnly")), "state cookie is HttpOnly");
  const bad = await app.inject({
    method: "GET",
    url: "/v1/auth/google/callback?code=abc&state=wrong",
    cookies: { aim_oauth_state: "right", aim_oauth_verifier: "v" },
  });
  assert(bad.statusCode === 400, "callback with mismatched state -> 400");
  assert((await app.inject({ method: "GET", url: "/v1/auth/google/callback?code=abc&state=x" })).statusCode === 400, "callback without state cookies -> 400");

  // --- web session -----------------------------------------------------------------------
  const web = await createSession({ userId: user!.id, kind: "web", ttlDays: 1, deviceLabel: "test-browser" });
  const cookies = { [SESSION_COOKIE]: web.token };
  const me = await app.inject({ method: "GET", url: "/v1/auth/me", cookies });
  assert(me.statusCode === 200 && me.json().user.email === `auth-${stamp}@test.local`, "web cookie session -> /me returns the user");
  assert(!JSON.stringify(me.json()).includes(web.token), "token is never echoed back");

  // CSRF: state-changing cookie request needs the right Origin.
  const noOrigin = await app.inject({ method: "POST", url: "/v1/auth/extension/pair/approve", cookies, payload: { userCode: "AAAA-AAAA" } });
  assert(noOrigin.statusCode === 403, "cookie POST without Origin -> 403 (CSRF)");
  const evil = await app.inject({
    method: "POST", url: "/v1/auth/extension/pair/approve", cookies, headers: { origin: "https://evil.example" }, payload: { userCode: "AAAA-AAAA" },
  });
  assert(evil.statusCode === 403, "cookie POST with foreign Origin -> 403 (CSRF)");

  // --- stored token is hashed ---------------------------------------------------------------
  const stored = await db.execute(sql`select token_hash from sessions where id = ${web.sessionId}`);
  const hash = (stored.rows[0] as { token_hash: string }).token_hash;
  assert(hash !== web.token && /^[0-9a-f]{64}$/.test(hash), "only a SHA-256 hash of the token is stored");

  // --- extension pairing ---------------------------------------------------------------------
  const start = await app.inject({ method: "POST", url: "/v1/auth/extension/pair/start", payload: { deviceLabel: "Chrome (test)" } });
  const pair = start.json() as { deviceCode: string; userCode: string; verificationUrl: string };
  assert(start.statusCode === 200 && /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(pair.userCode), "pair/start issues a user code");

  const pending = await app.inject({ method: "POST", url: "/v1/auth/extension/pair/poll", payload: { deviceCode: pair.deviceCode } });
  assert(pending.statusCode === 202, "poll before approval -> 202 pending");

  const unauthApprove = await app.inject({ method: "POST", url: "/v1/auth/extension/pair/approve", headers: { origin: ORIGIN }, payload: { userCode: pair.userCode } });
  assert(unauthApprove.statusCode === 401, "approve without login -> 401");

  const badCode = await app.inject({ method: "POST", url: "/v1/auth/extension/pair/approve", cookies, headers: { origin: ORIGIN }, payload: { userCode: "ZZZZ-ZZZZ" } });
  assert(badCode.statusCode === 404, "approve with unknown code -> 404");

  // Lower-case / no-dash input is normalised.
  const approve = await app.inject({
    method: "POST", url: "/v1/auth/extension/pair/approve", cookies, headers: { origin: ORIGIN },
    payload: { userCode: pair.userCode.replace("-", "").toLowerCase() },
  });
  assert(approve.statusCode === 200, "logged-in user approves the code");

  const polled = await app.inject({ method: "POST", url: "/v1/auth/extension/pair/poll", payload: { deviceCode: pair.deviceCode } });
  const ext = polled.json() as { status: string; token: string; scopes: string[] };
  assert(polled.statusCode === 200 && ext.status === "approved" && ext.token.startsWith("aime_"), "poll after approval returns an extension token");
  const again = await app.inject({ method: "POST", url: "/v1/auth/extension/pair/poll", payload: { deviceCode: pair.deviceCode } });
  assert(again.statusCode === 410, "token can be claimed only once (second poll -> 410)");

  // --- extension token: scopes and credential type ------------------------------------------------
  const bearer = { authorization: `Bearer ${ext.token}` };
  assert((await app.inject({ method: "GET", url: "/v1/auth/me", headers: bearer })).statusCode === 200, "extension token -> /me works");
  const ingest = await app.inject({ method: "POST", url: "/v1/ingest/captures", headers: bearer, payload: {} });
  assert(ingest.statusCode === 400, "extension token passes the ingest scope gate (reaches validation -> 400)");
  assert((await app.inject({ method: "POST", url: "/v1/ingest/captures", payload: {} })).statusCode === 401, "ingest without credential -> 401");
  assert((await app.inject({ method: "GET", url: "/v1/auth/sessions", headers: bearer })).statusCode === 403, "extension token cannot list/manage sessions (web only)");
  assert((await app.inject({ method: "POST", url: "/v1/auth/extension/pair/approve", headers: bearer, payload: { userCode: "AAAA-AAAA" } })).statusCode === 403, "extension token cannot approve pairings");

  // A token with a narrower scope is refused.
  const narrow = await createSession({ userId: user!.id, kind: "extension", scopes: ["read"], ttlDays: 1 });
  const nIngest = await app.inject({ method: "POST", url: "/v1/ingest/captures", headers: { authorization: `Bearer ${narrow.token}` }, payload: {} });
  assert(nIngest.statusCode === 403 && nIngest.json().error === "insufficient_scope", "read-only extension token refused on ingest (403)");

  // --- session management ---------------------------------------------------------------------------
  const list = await app.inject({ method: "GET", url: "/v1/auth/sessions", cookies });
  const rows = list.json().sessions as { id: string; current: boolean; kind: string }[];
  assert(list.statusCode === 200 && rows.some((r) => r.current && r.kind === "web") && rows.some((r) => r.kind === "extension"), "sessions list shows web (current) and extension sessions");

  const extSessionId = rows.find((r) => r.kind === "extension" && !r.current)!.id;
  const del = await app.inject({ method: "DELETE", url: `/v1/auth/sessions/${extSessionId}`, cookies, headers: { origin: ORIGIN } });
  assert(del.statusCode === 200, "user revokes an extension session");
  assert((await app.inject({ method: "GET", url: "/v1/auth/me", headers: bearer })).statusCode === 401, "revoked extension token -> 401 immediately");

  // Another user cannot revoke this user's session.
  const [other] = await db.insert(users).values({ email: `other-${stamp}@test.local`, googleSub: `sub2-${stamp}` }).returning();
  const otherWeb = await createSession({ userId: other!.id, kind: "web", ttlDays: 1 });
  const cross = await app.inject({
    method: "DELETE", url: `/v1/auth/sessions/${web.sessionId}`, cookies: { [SESSION_COOKIE]: otherWeb.token }, headers: { origin: ORIGIN },
  });
  assert(cross.statusCode === 404, "user cannot revoke someone else's session (404)");
  assert((await app.inject({ method: "GET", url: "/v1/auth/me", cookies })).statusCode === 200, "victim session still valid after cross-user attempt");

  // --- expiry ------------------------------------------------------------------------------------
  const expired = await createSession({ userId: user!.id, kind: "web", ttlDays: 1 });
  await db.update(sessions).set({ expiresAt: sql`now() - interval '1 minute'` }).where(sql`id = ${expired.sessionId}`);
  assert((await app.inject({ method: "GET", url: "/v1/auth/me", cookies: { [SESSION_COOKIE]: expired.token } })).statusCode === 401, "expired session -> 401");

  // --- logout --------------------------------------------------------------------------------------
  const out = await app.inject({ method: "POST", url: "/v1/auth/logout", cookies, headers: { origin: ORIGIN } });
  assert(out.statusCode === 200, "logout succeeds");
  assert((await app.inject({ method: "GET", url: "/v1/auth/me", cookies })).statusCode === 401, "session is dead after logout");

  // --- rate limiting -----------------------------------------------------------------------------------
  let limited = false;
  for (let i = 0; i < 15; i++) {
    const r = await app.inject({ method: "POST", url: "/v1/auth/extension/pair/start", payload: {} });
    if (r.statusCode === 429) { limited = true; break; }
  }
  assert(limited, "pair/start is rate limited (429)");

  // --- RLS boundary --------------------------------------------------------------------------------------
  const leak = await db.transaction(async (tx) => {
    await tx.execute(sql`set local role aimanager_app`);
    try { await tx.execute(sql`select email from users limit 1`); return false; } catch { return true; }
  });
  assert(leak, "RLS-bound app role cannot read the users table");

  await db.execute(sql`delete from users where id in (${user!.id}, ${other!.id})`);
  console.log("cleaned up test users");
  console.log("ALL AUTH CHECKS PASSED");
} catch (e) {
  console.error(e);
  await db.execute(sql`delete from users where email like ${"%-" + stamp + "@test.local"}`).catch(() => {});
  process.exitCode = 1;
} finally {
  await app.close();
  await pool.end();
}
