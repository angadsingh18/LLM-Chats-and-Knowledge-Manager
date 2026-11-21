import { Google, decodeIdToken, generateCodeVerifier, generateState } from "arctic";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { config } from "../../config.js";
import { db } from "../../db/client.js";
import { pairingRequests, sessions, users } from "../../db/schema.js";
import { SESSION_COOKIE, requireAuth } from "./guard.js";
import { EXTENSION_SCOPES, createSession, revokeSession } from "./sessions.js";
import { generateToken, generateUserCode, hashToken, normalizeUserCode } from "./tokens.js";

const OAUTH_STATE_COOKIE = "aim_oauth_state";
const OAUTH_VERIFIER_COOKIE = "aim_oauth_verifier";
const IS_PROD = config.NODE_ENV === "production";
const PAIR_TTL_SECONDS = 600;

const allowedEmails = new Set(
  (config.ALLOWED_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
);

function googleClient(): Google | null {
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) return null;
  const redirect = config.GOOGLE_REDIRECT_URI ?? `${config.WEB_ORIGIN}/v1/auth/google/callback`;
  return new Google(config.GOOGLE_CLIENT_ID, config.GOOGLE_CLIENT_SECRET, redirect);
}

const cookieBase = { httpOnly: true, sameSite: "lax" as const, secure: IS_PROD };

/**
 * Auth module: Google OAuth (authorization code + PKCE), server-side sessions with hashed
 * tokens, and device-code pairing for the extension.
 */
export const authModule: FastifyPluginAsync = async (app) => {
  const strict = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

  // ---- Google OAuth -------------------------------------------------------------------
  app.get("/google", strict, async (_req, reply) => {
    const google = googleClient();
    if (!google) return reply.code(503).send({ error: "google_not_configured" });

    const state = generateState();
    const verifier = generateCodeVerifier();
    const url = google.createAuthorizationURL(state, verifier, ["openid", "email", "profile"]);
    const opts = { ...cookieBase, path: "/v1/auth/google", maxAge: 600 };
    reply.setCookie(OAUTH_STATE_COOKIE, state, opts).setCookie(OAUTH_VERIFIER_COOKIE, verifier, opts);
    return reply.redirect(url.toString());
  });

  app.get("/google/callback", strict, async (req, reply) => {
    const google = googleClient();
    if (!google) return reply.code(503).send({ error: "google_not_configured" });

    const q = z.object({ code: z.string().min(1), state: z.string().min(1) }).safeParse(req.query);
    const state = req.cookies[OAUTH_STATE_COOKIE];
    const verifier = req.cookies[OAUTH_VERIFIER_COOKIE];
    reply.clearCookie(OAUTH_STATE_COOKIE, { path: "/v1/auth/google" });
    reply.clearCookie(OAUTH_VERIFIER_COOKIE, { path: "/v1/auth/google" });
    if (!q.success || !state || !verifier || q.data.state !== state) {
      return reply.code(400).send({ error: "invalid_oauth_state" });
    }

    let claims: { sub?: string; email?: string; email_verified?: boolean; name?: string; picture?: string };
    try {
      const tokens = await google.validateAuthorizationCode(q.data.code, verifier);
      claims = decodeIdToken(tokens.idToken()) as typeof claims;
    } catch {
      return reply.code(400).send({ error: "oauth_exchange_failed" });
    }
    // The ID token came straight from Google over TLS in the code exchange, so decoding (without
    // re-verifying the signature) is acceptable here; we still insist on a verified email.
    if (!claims.sub || !claims.email || claims.email_verified !== true) {
      return reply.code(403).send({ error: "email_not_verified" });
    }
    const email = claims.email.toLowerCase();
    if (allowedEmails.size > 0 && !allowedEmails.has(email)) {
      return reply.code(403).send({ error: "not_allowed" });
    }

    // Identity key is Google's `sub`, not the email (emails can change/be reassigned).
    const [user] = await db
      .insert(users)
      .values({ email, googleSub: claims.sub, name: claims.name ?? null, avatarUrl: claims.picture ?? null })
      .onConflictDoUpdate({
        target: users.googleSub,
        set: { email, name: claims.name ?? null, avatarUrl: claims.picture ?? null },
      })
      .returning({ id: users.id });

    const session = await createSession({
      userId: user!.id,
      kind: "web",
      scopes: [],
      deviceLabel: req.headers["user-agent"]?.slice(0, 120) ?? null,
      ttlDays: config.SESSION_TTL_DAYS,
    });
    reply.setCookie(SESSION_COOKIE, session.token, { ...cookieBase, path: "/", expires: session.expiresAt });
    return reply.redirect(config.WEB_ORIGIN);
  });

  // ---- Session endpoints ---------------------------------------------------------------
  app.get("/me", { preHandler: requireAuth() }, async (req) => {
    const auth = req.auth!;
    const [u] = await db
      .select({ id: users.id, email: users.email, name: users.name, avatarUrl: users.avatarUrl })
      .from(users)
      .where(eq(users.id, auth.userId));
    return { user: u, credential: { kind: auth.kind, scopes: auth.scopes } };
  });

  app.post("/logout", { preHandler: requireAuth({ kind: "web" }) }, async (req, reply) => {
    await revokeSession(req.auth!.sessionId, req.auth!.userId);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/sessions", { preHandler: requireAuth({ kind: "web" }) }, async (req) => {
    const rows = await db
      .select({
        id: sessions.id,
        kind: sessions.kind,
        deviceLabel: sessions.deviceLabel,
        createdAt: sessions.createdAt,
        lastSeenAt: sessions.lastSeenAt,
        expiresAt: sessions.expiresAt,
      })
      .from(sessions)
      .where(and(eq(sessions.userId, req.auth!.userId), isNull(sessions.revokedAt), gt(sessions.expiresAt, sql`now()`)));
    return { sessions: rows.map((r) => ({ ...r, current: r.id === req.auth!.sessionId })) };
  });

  app.delete("/sessions/:id", { preHandler: requireAuth({ kind: "web" }) }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const ok = await revokeSession(id, req.auth!.userId);
    return ok ? { ok: true } : reply.code(404).send({ error: "not_found" });
  });

  // ---- Extension device-code pairing ----------------------------------------------------
  // 1. The extension calls /start (no auth) and shows the user code / opens the verification URL.
  // 2. The user, logged in on the web app, confirms the code via /approve.
  // 3. The extension polls /poll with its secret device code and receives a scoped token once.
  app.post("/extension/pair/start", strict, async (req) => {
    const body = z.object({ deviceLabel: z.string().max(80).optional() }).parse(req.body ?? {});
    const deviceCode = generateToken("aimd");
    const userCode = generateUserCode();
    await db.insert(pairingRequests).values({
      deviceCodeHash: hashToken(deviceCode),
      userCode,
      deviceLabel: body.deviceLabel ?? null,
      expiresAt: new Date(Date.now() + PAIR_TTL_SECONDS * 1000),
    });
    return {
      deviceCode,
      userCode,
      verificationUrl: `${config.WEB_ORIGIN}/pair?code=${userCode}`,
      expiresIn: PAIR_TTL_SECONDS,
      interval: 3,
    };
  });

  app.post(
    "/extension/pair/approve",
    { preHandler: requireAuth({ kind: "web" }), config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { userCode } = z.object({ userCode: z.string().min(4).max(20) }).parse(req.body);
      const updated = await db
        .update(pairingRequests)
        .set({ status: "approved", userId: req.auth!.userId })
        .where(
          and(
            eq(pairingRequests.userCode, normalizeUserCode(userCode)),
            eq(pairingRequests.status, "pending"),
            gt(pairingRequests.expiresAt, sql`now()`),
          ),
        )
        .returning({ deviceLabel: pairingRequests.deviceLabel });
      if (updated.length === 0) return reply.code(404).send({ error: "invalid_or_expired_code" });
      return { ok: true, deviceLabel: updated[0]!.deviceLabel };
    },
  );

  app.post("/extension/pair/poll", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { deviceCode } = z.object({ deviceCode: z.string().min(10).max(200) }).parse(req.body);
    const hash = hashToken(deviceCode);
    const [row] = await db.select().from(pairingRequests).where(eq(pairingRequests.deviceCodeHash, hash));
    if (!row || row.status === "consumed" || row.expiresAt.getTime() < Date.now()) {
      return reply.code(410).send({ status: "expired" });
    }
    if (row.status === "pending") return reply.code(202).send({ status: "pending" });

    // Approved: atomically claim it so the token can be issued exactly once.
    const claimed = await db
      .update(pairingRequests)
      .set({ status: "consumed" })
      .where(and(eq(pairingRequests.id, row.id), eq(pairingRequests.status, "approved")))
      .returning({ id: pairingRequests.id });
    if (claimed.length === 0 || !row.userId) return reply.code(410).send({ status: "expired" });

    const session = await createSession({
      userId: row.userId,
      kind: "extension",
      scopes: [...EXTENSION_SCOPES],
      deviceLabel: row.deviceLabel,
      ttlDays: config.EXTENSION_TOKEN_TTL_DAYS,
    });
    return { status: "approved", token: session.token, expiresAt: session.expiresAt, scopes: EXTENSION_SCOPES };
  });
};
