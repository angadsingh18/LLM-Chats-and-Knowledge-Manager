import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../../config.js";
import { type AuthContext, resolveSession } from "./sessions.js";

export const SESSION_COOKIE = "aim_session";

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function bearerToken(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1]! : null;
}

/**
 * Authentication preHandler factory.
 *  - Accepts `Authorization: Bearer …` (extension) or the session cookie (web).
 *  - Cookie-authenticated state-changing requests must carry an Origin equal to WEB_ORIGIN
 *    (CSRF defence in addition to SameSite=Lax).
 *  - `kind` restricts to web or extension credentials; `scope` requires an extension scope
 *    (web sessions hold all scopes implicitly).
 */
export function requireAuth(opts: { kind?: "web" | "extension"; scope?: string } = {}) {
  return async function authenticate(req: FastifyRequest, reply: FastifyReply) {
    const bearer = bearerToken(req);
    const cookie = req.cookies?.[SESSION_COOKIE] ?? null;
    const token = bearer ?? cookie;
    if (!token) return reply.code(401).send({ error: "unauthenticated" });

    const viaCookie = !bearer;
    if (viaCookie && !SAFE_METHODS.has(req.method) && req.headers.origin !== config.WEB_ORIGIN) {
      return reply.code(403).send({ error: "bad_origin" });
    }

    const session = await resolveSession(token);
    if (!session) return reply.code(401).send({ error: "unauthenticated" });

    if (opts.kind && session.kind !== opts.kind) return reply.code(403).send({ error: "wrong_credential_type" });
    if (opts.scope && session.kind === "extension" && !session.scopes.includes(opts.scope)) {
      return reply.code(403).send({ error: "insufficient_scope", scope: opts.scope });
    }
    req.auth = { ...session, viaCookie };
  };
}
