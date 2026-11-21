import type { CaptureBatch, CaptureResult } from "@ai-manager/schemas";
import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { attachments, conversations, messages, providerAccounts } from "../../db/schema.js";
import { hashMessage, partsToText, scrub } from "./content.js";

export class IngestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
  }
}

// 11 bound parameters per message row; 500 rows stays far below Postgres' 65,535 limit.
const MESSAGE_CHUNK = 500;

/**
 * Idempotent write of a capture batch. MUST run inside withUser(): row-level security then
 * guarantees the account (and everything written under it) belongs to the caller.
 *
 *  - conversations: upsert on (provider_account_id, external_id)
 *  - messages:      upsert on (conversation_id, ordinal); rows are rewritten only when the
 *                   content hash differs, so re-sending the same capture changes nothing
 *  - nothing is ever deleted, so a partial capture can never shrink a stored conversation
 */
export async function ingestBatch(tx: Db, userId: string, batch: CaptureBatch): Promise<CaptureResult> {
  const [account] = await tx
    .select({ id: providerAccounts.id, providerId: providerAccounts.providerId, archivedAt: providerAccounts.archivedAt })
    .from(providerAccounts)
    .where(eq(providerAccounts.id, batch.providerAccountId));
  // Another user's account is invisible under RLS, so it looks exactly like a missing one.
  if (!account) throw new IngestError(404, "account_not_found");
  if (account.archivedAt) throw new IngestError(409, "account_archived");
  if (account.providerId !== batch.providerId) throw new IngestError(400, "provider_mismatch");

  const results: CaptureResult["results"] = [];

  for (const c of batch.conversations) {
    if (c.providerId !== batch.providerId) throw new IngestError(400, "provider_mismatch");
    if (new Set(c.messages.map((m) => m.ordinal)).size !== c.messages.length) {
      throw new IngestError(400, "duplicate_ordinal");
    }

    const [conv] = await tx
      .insert(conversations)
      .values({
        userId,
        providerAccountId: account.id,
        externalId: c.externalId,
        title: c.title === undefined ? null : scrub(c.title),
        url: c.url ?? null,
        source: batch.source,
        createdAtSource: c.createdAtSource ? new Date(c.createdAtSource) : null,
        updatedAtSource: c.updatedAtSource ? new Date(c.updatedAtSource) : null,
        isPartial: c.partial,
        rawMetadata: scrub(c.rawMetadata),
      })
      .onConflictDoUpdate({
        target: [conversations.providerAccountId, conversations.externalId],
        set: {
          // A capture that lacks a field must not erase what an earlier capture stored.
          title: sql`coalesce(excluded.title, conversations.title)`,
          url: sql`coalesce(excluded.url, conversations.url)`,
          createdAtSource: sql`coalesce(excluded.created_at_source, conversations.created_at_source)`,
          updatedAtSource: sql`coalesce(excluded.updated_at_source, conversations.updated_at_source)`,
          // Stays partial only while every capture so far has been partial.
          isPartial: sql`conversations.is_partial and excluded.is_partial`,
          rawMetadata: sql`excluded.raw_metadata`,
          lastSyncedAt: sql`now()`,
        },
      })
      .returning({ id: conversations.id });

    let newMessageCount = 0;
    const rows = c.messages.map((m) => {
      const parts = scrub(m.contentParts);
      return {
        userId,
        conversationId: conv!.id,
        ordinal: m.ordinal,
        externalId: m.externalId ?? null,
        parentExternalId: m.parentExternalId ?? null,
        role: m.role,
        modelName: m.modelName ?? null,
        contentParts: parts,
        contentText: partsToText(parts),
        contentHash: hashMessage(m.role, parts),
        createdAtSource: m.createdAtSource ? new Date(m.createdAtSource) : null,
        rawMetadata: scrub(m.rawMetadata),
      };
    });
    const attachmentsByOrdinal = new Map(c.messages.map((m) => [m.ordinal, m.attachments]));

    for (let i = 0; i < rows.length; i += MESSAGE_CHUNK) {
      const written = await tx
        .insert(messages)
        .values(rows.slice(i, i + MESSAGE_CHUNK))
        .onConflictDoUpdate({
          target: [messages.conversationId, messages.ordinal],
          set: {
            externalId: sql`excluded.external_id`,
            parentExternalId: sql`excluded.parent_external_id`,
            role: sql`excluded.role`,
            modelName: sql`excluded.model_name`,
            contentParts: sql`excluded.content_parts`,
            contentText: sql`excluded.content_text`,
            contentHash: sql`excluded.content_hash`,
            createdAtSource: sql`excluded.created_at_source`,
            rawMetadata: sql`excluded.raw_metadata`,
          },
          // Unchanged rows are skipped entirely (and therefore not returned).
          setWhere: sql`messages.content_hash is distinct from excluded.content_hash`,
        })
        // xmax = 0 is true only for a freshly inserted row, false for one rewritten by the upsert.
        .returning({ id: messages.id, ordinal: messages.ordinal, inserted: sql<boolean>`(xmax = 0)` });

      newMessageCount += written.filter((w) => w.inserted).length;

      // Attachments of an inserted or rewritten message are replaced wholesale.
      if (written.length > 0) {
        await tx.delete(attachments).where(
          inArray(
            attachments.messageId,
            written.map((w) => w.id),
          ),
        );
        const attRows = written.flatMap((w) =>
          (attachmentsByOrdinal.get(w.ordinal) ?? []).map((a) => ({
            userId,
            messageId: w.id,
            filename: scrub(a.filename),
            mimeType: a.mimeType ?? null,
            sizeBytes: a.sizeBytes ?? null,
          })),
        );
        if (attRows.length > 0) await tx.insert(attachments).values(attRows);
      }
    }

    // Denormalised counters/hash, recomputed from stored rows (not from this batch alone).
    await tx.execute(sql`
      update conversations set
        message_count = s.n,
        content_hash = s.h,
        last_synced_at = now()
      from (
        select count(*)::int as n,
               encode(digest(string_agg(content_hash, '' order by ordinal), 'sha256'), 'hex') as h
        from messages where conversation_id = ${conv!.id}
      ) s
      where conversations.id = ${conv!.id}
    `);

    results.push({ externalId: c.externalId, conversationId: conv!.id, newMessageCount });
  }

  return { results };
}
