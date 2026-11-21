import { sql } from "drizzle-orm";
import { conversations, messages, providerAccounts, users } from "./schema.js";
import { db, pool, withUser } from "./client.js";

/**
 * End-to-end database check against the configured DATABASE_URL (pooled).
 * Creates two throwaway users, proves RLS isolation + full-text search, then cleans up.
 */
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("ok  -", msg);
}

async function main() {
  const ping = await db.execute(sql`select current_user as u, version() as v`);
  console.log("connected as", (ping.rows[0] as { u: string }).u);

  const ext = await db.execute(sql`select extname from pg_extension where extname in ('vector','pg_trgm','pgcrypto')`);
  const names = (ext.rows as { extname: string }[]).map((r) => r.extname).sort();
  assert(names.join() === "pg_trgm,pgcrypto,vector", `extensions present: ${names.join(", ")}`);

  const prov = await db.execute(sql`select count(*)::int as n from providers`);
  assert((prov.rows[0] as { n: number }).n >= 4, "providers seeded");

  const stamp = Date.now();
  const [a] = await db.insert(users).values({ email: `a-${stamp}@test.local` }).returning();
  const [b] = await db.insert(users).values({ email: `b-${stamp}@test.local` }).returning();
  try {
    // User A writes through RLS.
    await withUser(a!.id, async (tx) => {
      const [acct] = await tx
        .insert(providerAccounts)
        .values({ userId: a!.id, providerId: "chatgpt", label: "ChatGPT – Test" })
        .returning();
      const [conv] = await tx
        .insert(conversations)
        .values({ userId: a!.id, providerAccountId: acct!.id, externalId: "ext-1", title: "RL environments", source: "import" })
        .returning();
      await tx.insert(messages).values({
        userId: a!.id,
        conversationId: conv!.id,
        ordinal: 0,
        role: "user",
        contentParts: [{ type: "text", text: "domain randomization for sim-to-real" }],
        contentText: "domain randomization for sim-to-real",
        contentHash: "h0",
      });
    });

    const asA = await withUser(a!.id, (tx) => tx.select().from(conversations));
    assert(asA.length === 1, "user A sees own conversation");

    const asB = await withUser(b!.id, (tx) => tx.select().from(conversations));
    assert(asB.length === 0, "user B sees NOTHING of user A (RLS isolation)");

    // User B cannot insert a row claiming to be user A.
    let blocked = false;
    try {
      await withUser(b!.id, async (tx) => {
        const accts = await tx.select().from(providerAccounts);
        void accts;
        await tx.insert(providerAccounts).values({ userId: a!.id, providerId: "claude", label: "spoof" });
      });
    } catch {
      blocked = true;
    }
    assert(blocked, "user B cannot write rows as user A (WITH CHECK)");

    // No user context set at all => fail closed.
    const noCtx = await db.transaction(async (tx) => {
      await tx.execute(sql`set local role aimanager_app`);
      return tx.select().from(conversations);
    });
    assert(noCtx.length === 0, "no user context returns zero rows (fail closed)");

    // Full-text search over the generated tsvector column.
    const hits = await withUser(a!.id, (tx) =>
      tx.execute(sql`select ordinal from messages where fts @@ websearch_to_tsquery('simple', 'randomization')`),
    );
    assert(hits.rows.length === 1, "full-text search finds the message");
  } finally {
    // Cascades remove accounts/conversations/messages.
    await db.execute(sql`delete from users where id in (${a!.id}, ${b!.id})`);
    console.log("cleaned up test users");
  }
  await pool.end();
  console.log("ALL CHECKS PASSED");
}

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => {});
  process.exit(1);
});
