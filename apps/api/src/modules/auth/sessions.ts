import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { sessions, users } from "../../db/schema.js";
import { generateToken, hashToken } from "./tokens.js";

export type SessionKind = "web" | "extension";
export const EXTENSION_SCOPES = ["ingest", "read", "suggest"] as const;

export interface AuthContext {
  userId: string;
  sessionId: string;
  kind: SessionKind;
  scopes: string[];
  /** true when the credential came from the cookie (CSRF checks apply). */
  viaCookie: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function createSession(opts: {
  userId: string;
  kind: SessionKind;
  scopes?: string[];
  deviceLabel?: string | null;
  ttlDays: number;
}): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
  const token = generateToken(opts.kind === "web" ? "aimw" : "aime");
  const expiresAt = new Date(Date.now() + opts.ttlDays * DAY_MS);
  const [row] = await db
    .insert(sessions)
    .values({
      userId: opts.userId,
      tokenHash: hashToken(token),
      kind: opts.kind,
      scopes: opts.scopes ?? [],
      deviceLabel: opts.deviceLabel ?? null,
      expiresAt,
    })
    .returning({ id: sessions.id });
  return { token, sessionId: row!.id, expiresAt };
}

/** Resolves a token to a live session (not revoked, not expired, user not deleted). */
export async function resolveSession(token: string): Promise<Omit<AuthContext, "viaCookie"> | null> {
  const [row] = await db
    .select({
      id: sessions.id,
      userId: sessions.userId,
      kind: sessions.kind,
      scopes: sessions.scopes,
      lastSeenAt: sessions.lastSeenAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(eq(sessions.tokenHash, hashToken(token)), isNull(sessions.revokedAt), gt(sessions.expiresAt, sql`now()`), isNull(users.deletedAt)),
    )
    .limit(1);
  if (!row) return null;

  // Touch last_seen at most every 5 minutes to avoid a write per request.
  if (Date.now() - row.lastSeenAt.getTime() > 5 * 60 * 1000) {
    await db.update(sessions).set({ lastSeenAt: sql`now()` }).where(eq(sessions.id, row.id));
  }
  return { userId: row.userId, sessionId: row.id, kind: row.kind as SessionKind, scopes: row.scopes };
}

/** Revokes a session; the userId guard means users can only revoke their own. */
export async function revokeSession(sessionId: string, userId: string): Promise<boolean> {
  const res = await db
    .update(sessions)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });
  return res.length > 0;
}
