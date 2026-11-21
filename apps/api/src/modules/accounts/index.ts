import { eq, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { withUser } from "../../db/client.js";
import { providerAccounts, providers } from "../../db/schema.js";
import { requireAuth } from "../auth/guard.js";

const Color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const IdParam = z.object({ id: z.string().uuid() });

const CreateBody = z.object({
  providerId: z.string().min(1).max(64),
  label: z.string().trim().min(1).max(80),
  externalAccountHint: z.string().trim().max(200).optional(),
  color: Color.optional(),
});
const PatchBody = z
  .object({
    label: z.string().trim().min(1).max(80),
    externalAccountHint: z.string().trim().max(200).nullable(),
    color: Color.nullable(),
    archived: z.boolean(),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, "empty patch");

/**
 * Labelled provider accounts ("ChatGPT - Personal", "Claude - Work"). Every query runs inside
 * withUser(), so row-level security scopes it to the caller; the explicit where-clauses are
 * only for correctness, not for isolation.
 */
export const accountsModule: FastifyPluginAsync = async (app) => {
  // The extension needs the list (read scope) to choose which account a capture belongs to.
  app.get("/", { preHandler: requireAuth({ scope: "read" }) }, async (req) => {
    const rows = await withUser(req.auth!.userId, (tx) =>
      tx
        .select({
          id: providerAccounts.id,
          providerId: providerAccounts.providerId,
          label: providerAccounts.label,
          externalAccountHint: providerAccounts.externalAccountHint,
          color: providerAccounts.color,
          createdAt: providerAccounts.createdAt,
          archivedAt: providerAccounts.archivedAt,
          conversationCount: sql<number>`(select count(*)::int from conversations c where c.provider_account_id = ${providerAccounts.id})`,
        })
        .from(providerAccounts)
        .orderBy(providerAccounts.createdAt),
    );
    return { accounts: rows };
  });

  app.post("/", { preHandler: requireAuth({ kind: "web" }) }, async (req, reply) => {
    const body = CreateBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", issues: body.error.issues });
    const userId = req.auth!.userId;

    const created = await withUser(userId, async (tx) => {
      const [p] = await tx.select({ id: providers.id }).from(providers).where(eq(providers.id, body.data.providerId));
      if (!p) return null;
      const [row] = await tx
        .insert(providerAccounts)
        .values({
          userId,
          providerId: body.data.providerId,
          label: body.data.label,
          externalAccountHint: body.data.externalAccountHint ?? null,
          color: body.data.color ?? null,
        })
        .returning();
      return row!;
    });
    if (!created) return reply.code(400).send({ error: "unknown_provider" });
    return reply.code(201).send({ account: created });
  });

  app.patch("/:id", { preHandler: requireAuth({ kind: "web" }) }, async (req, reply) => {
    const params = IdParam.safeParse(req.params);
    const body = PatchBody.safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_request" });
    const { archived, ...rest } = body.data;

    const [row] = await withUser(req.auth!.userId, (tx) =>
      tx
        .update(providerAccounts)
        .set({
          ...rest,
          ...(archived === undefined ? {} : { archivedAt: archived ? sql`now()` : null }),
        })
        .where(eq(providerAccounts.id, params.data.id))
        .returning(),
    );
    return row ? { account: row } : reply.code(404).send({ error: "not_found" });
  });

  // Hard delete: cascades to the account's conversations, messages and attachments.
  app.delete("/:id", { preHandler: requireAuth({ kind: "web" }) }, async (req, reply) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request" });
    const rows = await withUser(req.auth!.userId, (tx) =>
      tx.delete(providerAccounts).where(eq(providerAccounts.id, params.data.id)).returning({ id: providerAccounts.id }),
    );
    return rows.length > 0 ? { ok: true } : reply.code(404).send({ error: "not_found" });
  });
};
