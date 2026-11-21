import { eq, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { withUser } from "../../db/client.js";
import { attachments, conversations, messages } from "../../db/schema.js";
import { requireAuth } from "../auth/guard.js";

const ListQuery = z.object({
  q: z.string().trim().min(1).max(200).optional(),
  providerAccountId: z.string().uuid().optional(),
  providerId: z.string().min(1).max(64).optional(),
  bookmarked: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().max(200).optional(),
});
const IdParam = z.object({ id: z.string().uuid() });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TS_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9:.]+(Z|[+-][0-9:]+)?$/;

/** Cursor = the previous page's last (sort timestamp as full-precision text, id). */
function encodeCursor(ts: string, id: string) {
  return Buffer.from(`${ts}|${id}`).toString("base64url");
}
function decodeCursor(c: string): { ts: string; id: string } | null {
  const [ts, id] = Buffer.from(c, "base64url").toString().split("|");
  return ts && id && TS_RE.test(ts) && UUID_RE.test(id) ? { ts, id } : null;
}

/** Escapes LIKE wildcards so user input is matched literally. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (m) => "\\" + m);

interface ListRow {
  id: string;
  provider_account_id: string;
  provider_id: string;
  account_label: string;
  title: string | null;
  url: string | null;
  message_count: number;
  is_partial: boolean;
  is_bookmarked: boolean;
  created_at_source: Date | null;
  updated_at_source: Date | null;
  last_synced_at: Date;
  sort_ts: string;
  snippet: string | null;
}

/** Conversation list/search/detail. All queries run inside withUser() (row-level security). */
export const conversationsModule: FastifyPluginAsync = async (app) => {
  app.get("/", { preHandler: requireAuth({ scope: "read" }) }, async (req, reply) => {
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_query", issues: parsed.error.issues });
    const { q, providerAccountId, providerId, bookmarked, limit, cursor } = parsed.data;

    const decoded = cursor ? decodeCursor(cursor) : null;
    if (cursor && !decoded) return reply.code(400).send({ error: "invalid_cursor" });

    const sortKey = sql`coalesce(c.updated_at_source, c.created_at)`;
    const tsq = q ? sql`websearch_to_tsquery('simple', ${q})` : null;

    const conds = [sql`true`];
    if (providerAccountId) conds.push(sql`c.provider_account_id = ${providerAccountId}`);
    if (providerId) conds.push(sql`pa.provider_id = ${providerId}`);
    if (bookmarked) conds.push(sql`c.is_bookmarked = ${bookmarked === "true"}`);
    if (q && tsq) {
      conds.push(sql`(
        c.title ilike ${"%" + likeEscape(q) + "%"}
        or exists (select 1 from messages m where m.conversation_id = c.id and m.fts @@ ${tsq})
      )`);
    }
    if (decoded) conds.push(sql`(${sortKey}, c.id) < (${decoded.ts}::timestamptz, ${decoded.id}::uuid)`);

    // Best-matching message excerpt; matches are wrapped in [[ ]] (never HTML: content is untrusted).
    const snippetJoin = tsq
      ? sql`left join lateral (
          select ts_headline('simple', m.content_text, ${tsq}, 'StartSel=[[, StopSel=]], MaxFragments=1, MaxWords=25, MinWords=8') as snippet
          from messages m
          where m.conversation_id = c.id and m.fts @@ ${tsq}
          order by ts_rank(m.fts, ${tsq}) desc
          limit 1
        ) snip on true`
      : sql``;

    const rows = await withUser(req.auth!.userId, async (tx) => {
      const res = await tx.execute(sql`
        select c.id, c.provider_account_id, pa.provider_id, pa.label as account_label,
               c.title, c.url, c.message_count, c.is_partial, c.is_bookmarked,
               c.created_at_source, c.updated_at_source, c.last_synced_at,
               (${sortKey})::text as sort_ts,
               ${tsq ? sql`snip.snippet` : sql`null`} as snippet
        from conversations c
        join provider_accounts pa on pa.id = c.provider_account_id
        ${snippetJoin}
        where ${sql.join(conds, sql` and `)}
        order by ${sortKey} desc, c.id desc
        limit ${limit + 1}
      `);
      return res.rows as unknown as ListRow[];
    });

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      conversations: page.map((r) => ({
        id: r.id,
        providerAccountId: r.provider_account_id,
        providerId: r.provider_id,
        accountLabel: r.account_label,
        title: r.title,
        url: r.url,
        messageCount: r.message_count,
        isPartial: r.is_partial,
        isBookmarked: r.is_bookmarked,
        createdAtSource: r.created_at_source,
        updatedAtSource: r.updated_at_source,
        lastSyncedAt: r.last_synced_at,
        snippet: r.snippet,
      })),
      nextCursor: rows.length > limit && last ? encodeCursor(last.sort_ts, last.id) : null,
    };
  });

  app.get("/:id", { preHandler: requireAuth({ scope: "read" }) }, async (req, reply) => {
    const params = IdParam.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request" });
    const id = params.data.id;

    const out = await withUser(req.auth!.userId, async (tx) => {
      const [conv] = await tx.select().from(conversations).where(eq(conversations.id, id));
      if (!conv) return null;
      const msgs = await tx
        .select({
          id: messages.id,
          ordinal: messages.ordinal,
          role: messages.role,
          modelName: messages.modelName,
          contentParts: messages.contentParts,
          contentText: messages.contentText,
          createdAtSource: messages.createdAtSource,
        })
        .from(messages)
        .where(eq(messages.conversationId, id))
        .orderBy(messages.ordinal);
      const atts = await tx
        .select({
          messageId: attachments.messageId,
          filename: attachments.filename,
          mimeType: attachments.mimeType,
          sizeBytes: attachments.sizeBytes,
        })
        .from(attachments)
        .innerJoin(messages, eq(messages.id, attachments.messageId))
        .where(eq(messages.conversationId, id));
      return { conv, msgs, atts };
    });
    if (!out) return reply.code(404).send({ error: "not_found" });

    return {
      conversation: out.conv,
      messages: out.msgs.map((m) => ({
        ...m,
        attachments: out.atts.filter((a) => a.messageId === m.id).map(({ messageId: _m, ...a }) => a),
      })),
    };
  });

  app.patch("/:id", { preHandler: requireAuth({ kind: "web" }) }, async (req, reply) => {
    const params = IdParam.safeParse(req.params);
    const body = z.object({ isBookmarked: z.boolean() }).safeParse(req.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_request" });
    const [row] = await withUser(req.auth!.userId, (tx) =>
      tx
        .update(conversations)
        .set({ isBookmarked: body.data.isBookmarked })
        .where(eq(conversations.id, params.data.id))
        .returning({ id: conversations.id, isBookmarked: conversations.isBookmarked }),
    );
    return row ?? reply.code(404).send({ error: "not_found" });
  });
};
