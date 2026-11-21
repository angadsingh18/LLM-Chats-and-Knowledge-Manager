/**
 * Accounts + ingestion + conversations integration check against the configured database,
 * using Fastify's inject. Run: pnpm --filter @ai-manager/api ingest:check
 */
export {}; // make this file a module so top-level await typechecks

process.env.GOOGLE_CLIENT_ID ??= "fake-client-id.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ??= "fake-secret";

const { sql } = await import("drizzle-orm");
const { buildApp } = await import("../../app.js");
const { config } = await import("../../config.js");
const { db, pool } = await import("../../db/client.js");
const { users } = await import("../../db/schema.js");
const { createSession } = await import("../auth/sessions.js");
const { SESSION_COOKIE } = await import("../auth/guard.js");

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("ok  -", msg);
}

const app = await buildApp();
const ORIGIN = config.WEB_ORIGIN;
const stamp = Date.now();
const [alice] = await db.insert(users).values({ email: `alice-${stamp}@test.local`, googleSub: `ia-${stamp}` }).returning();
const [bob] = await db.insert(users).values({ email: `bob-${stamp}@test.local`, googleSub: `ib-${stamp}` }).returning();

try {
  const aWeb = await createSession({ userId: alice!.id, kind: "web", ttlDays: 1 });
  const bWeb = await createSession({ userId: bob!.id, kind: "web", ttlDays: 1 });
  const aExt = await createSession({ userId: alice!.id, kind: "extension", scopes: ["ingest", "read"], ttlDays: 1 });
  const aExtReadOnly = await createSession({ userId: alice!.id, kind: "extension", scopes: ["read"], ttlDays: 1 });
  const A = { cookies: { [SESSION_COOKIE]: aWeb.token }, headers: { origin: ORIGIN } };
  const B = { cookies: { [SESSION_COOKIE]: bWeb.token }, headers: { origin: ORIGIN } };
  const extHeaders = { authorization: `Bearer ${aExt.token}` };

  // --- accounts ------------------------------------------------------------------------------
  assert((await app.inject({ method: "GET", url: "/v1/accounts" })).statusCode === 401, "accounts: no credential -> 401");
  const bad = await app.inject({ method: "POST", url: "/v1/accounts", ...A, payload: { providerId: "nope", label: "x" } });
  assert(bad.statusCode === 400 && bad.json().error === "unknown_provider", "accounts: unknown provider -> 400");
  assert((await app.inject({ method: "POST", url: "/v1/accounts", ...A, payload: { providerId: "chatgpt", label: "" } })).statusCode === 400, "accounts: empty label -> 400");
  assert((await app.inject({ method: "POST", url: "/v1/accounts", cookies: A.cookies, payload: { providerId: "chatgpt", label: "x" } })).statusCode === 403, "accounts: cookie POST without Origin -> 403 (CSRF)");
  assert(
    (await app.inject({ method: "POST", url: "/v1/accounts", headers: extHeaders, payload: { providerId: "chatgpt", label: "x" } })).statusCode === 403,
    "accounts: extension token cannot create accounts (web only)",
  );

  const mk = async (who: typeof A, providerId: string, label: string) => {
    const r = await app.inject({ method: "POST", url: "/v1/accounts", ...who, payload: { providerId, label, color: "#10a37f" } });
    assert(r.statusCode === 201, `accounts: create "${label}"`);
    return r.json().account as { id: string };
  };
  const gpt = await mk(A, "chatgpt", "ChatGPT - Personal");
  const claude = await mk(A, "claude", "Claude - Work");
  const bobGpt = await mk(B, "chatgpt", "Bob's ChatGPT");

  const list = await app.inject({ method: "GET", url: "/v1/accounts", headers: extHeaders });
  assert(list.statusCode === 200 && list.json().accounts.length === 2, "accounts: extension (read scope) lists only the owner's 2 accounts");
  assert(!JSON.stringify(list.json()).includes(bobGpt.id), "accounts: other user's account not visible");

  const rename = await app.inject({ method: "PATCH", url: `/v1/accounts/${claude.id}`, ...A, payload: { label: "Claude - Work (renamed)" } });
  assert(rename.statusCode === 200 && rename.json().account.label === "Claude - Work (renamed)", "accounts: rename");
  assert((await app.inject({ method: "PATCH", url: `/v1/accounts/${bobGpt.id}`, ...A, payload: { label: "hijack" } })).statusCode === 404, "accounts: cannot rename another user's account (404)");
  assert((await app.inject({ method: "PATCH", url: `/v1/accounts/${claude.id}`, ...A, payload: {} })).statusCode === 400, "accounts: empty patch -> 400");

  // --- ingestion: validation and authorisation -------------------------------------------------
  const conv = (externalId: string, over: Record<string, unknown> = {}) => ({
    providerId: "chatgpt",
    externalId,
    title: "Postgres indexing tips",
    url: "https://chatgpt.com/c/" + externalId,
    updatedAtSource: "2026-01-02T10:00:00.000Z",
    messages: [
      { ordinal: 0, role: "user", contentParts: [{ type: "text", text: "How do GIN indexes work in Postgres?" }], createdAtSource: "2026-01-02T09:59:00.000Z" },
      {
        ordinal: 1, role: "assistant", modelName: "gpt-4o",
        contentParts: [
          { type: "text", text: "A GIN index maps each lexeme to the rows containing it." },
          { type: "code", text: "create index on t using gin (fts);", language: "sql" },
        ],
        attachments: [{ filename: "diagram.png", mimeType: "image/png", sizeBytes: 1234 }],
      },
    ],
    ...over,
  });
  const batch = (accountId: string, conversations: unknown[], providerId = "chatgpt") => ({
    providerId, providerAccountId: accountId, source: "extension", conversations,
  });
  const post = (payload: unknown, headers: Record<string, string> = extHeaders) =>
    app.inject({ method: "POST", url: "/v1/ingest/captures", headers, payload: payload as object });

  assert(
    (await app.inject({ method: "POST", url: "/v1/ingest/captures", headers: { authorization: `Bearer ${aExtReadOnly.token}` }, payload: batch(gpt.id, [conv("c1")]) })).statusCode === 403,
    "ingest: read-only token refused (403)",
  );
  const foreign = await post(batch(bobGpt.id, [conv("c1")]));
  assert(foreign.statusCode === 404 && foreign.json().error === "account_not_found", "ingest: another user's account looks nonexistent (404, RLS)");
  const mismatch = await post(batch(claude.id, [conv("c1")], "chatgpt"));
  assert(mismatch.statusCode === 400 && mismatch.json().error === "provider_mismatch", "ingest: provider/account mismatch -> 400");
  const dupOrd = await post(batch(gpt.id, [conv("dup", { messages: [
    { ordinal: 0, role: "user", contentParts: [{ type: "text", text: "a" }] },
    { ordinal: 0, role: "assistant", contentParts: [{ type: "text", text: "b" }] },
  ] })]));
  assert(dupOrd.statusCode === 400 && dupOrd.json().error === "duplicate_ordinal", "ingest: duplicate ordinals -> 400");
  assert((await post({ ...batch(gpt.id, []) })).statusCode === 400, "ingest: empty batch -> 400");

  // --- ingestion: idempotency ----------------------------------------------------------------------
  const first = await post(batch(gpt.id, [conv("c1")]));
  assert(first.statusCode === 200 && first.json().results[0].newMessageCount === 2, "ingest: first capture inserts 2 messages");
  const convId = first.json().results[0].conversationId as string;

  const again = await post(batch(gpt.id, [conv("c1")]));
  assert(again.statusCode === 200 && again.json().results[0].newMessageCount === 0, "ingest: identical re-send adds 0 messages");
  assert(again.json().results[0].conversationId === convId, "ingest: same conversation id on re-send (no duplicate row)");
  const counts = await db.execute(sql`select (select count(*)::int from conversations where provider_account_id = ${gpt.id}) c, (select count(*)::int from messages where conversation_id = ${convId}) m, (select count(*)::int from attachments a join messages m on m.id = a.message_id where m.conversation_id = ${convId}) a`);
  const cr = counts.rows[0] as { c: number; m: number; a: number };
  assert(cr.c === 1 && cr.m === 2 && cr.a === 1, "ingest: still exactly 1 conversation, 2 messages, 1 attachment");

  // Same externalId under a different account is a different conversation.
  const other = await post(batch(claude.id, [conv("c1", { providerId: "claude" })], "claude"));
  assert(other.statusCode === 200 && other.json().results[0].conversationId !== convId, "ingest: same externalId under another account is separate");

  // New message appended + edited message rewritten.
  const grown = conv("c1");
  grown.messages.push({ ordinal: 2, role: "user", contentParts: [{ type: "text", text: "Thanks, what about trigram indexes?" }] } as never);
  (grown.messages[1] as { contentParts: unknown[] }).contentParts = [{ type: "text", text: "A GIN index maps each lexeme to a posting list." }];
  const g = await post(batch(gpt.id, [grown]));
  assert(g.statusCode === 200 && g.json().results[0].newMessageCount === 1, "ingest: only the genuinely new message counts as new");
  const detailAfter = (await app.inject({ method: "GET", url: `/v1/conversations/${convId}`, ...A })).json();
  assert(detailAfter.messages.length === 3 && detailAfter.conversation.messageCount === 3, "ingest: message_count recomputed from stored rows");
  assert(detailAfter.messages[1].contentText.includes("posting list"), "ingest: edited message content was updated");

  // Partial capture never shrinks the stored thread and doesn't erase fields.
  const partial = await post(batch(gpt.id, [{ providerId: "chatgpt", externalId: "c1", partial: true, messages: [
    { ordinal: 2, role: "user", contentParts: [{ type: "text", text: "Thanks, what about trigram indexes?" }] },
  ] }]));
  assert(partial.statusCode === 200 && partial.json().results[0].newMessageCount === 0, "ingest: partial re-capture adds nothing");
  const afterPartial = (await app.inject({ method: "GET", url: `/v1/conversations/${convId}`, ...A })).json();
  assert(afterPartial.messages.length === 3 && afterPartial.conversation.title === "Postgres indexing tips" && afterPartial.conversation.isPartial === false,
    "ingest: partial capture keeps messages, title and completeness");

  // NUL characters (rejected by Postgres) are scrubbed instead of crashing the batch.
  const nul = await post(batch(gpt.id, [conv("nul", { title: "bad\u0000title", messages: [
    { ordinal: 0, role: "user", contentParts: [{ type: "text", text: "he\u0000llo" }] },
  ] })]));
  assert(nul.statusCode === 200, "ingest: NUL characters are scrubbed");

  // Large conversation exercises chunked inserts.
  const big = conv("big", { title: "Big thread", messages: Array.from({ length: 1200 }, (_, i) => ({
    ordinal: i, role: i % 2 ? "assistant" : "user", contentParts: [{ type: "text", text: `message number ${i} about zebra${i % 7}` }],
  })) });
  const bigRes = await post(batch(gpt.id, [big]));
  assert(bigRes.statusCode === 200 && bigRes.json().results[0].newMessageCount === 1200, "ingest: 1200-message conversation (chunked) inserted");

  // --- conversations: list / search / isolation ----------------------------------------------------------
  const all = await app.inject({ method: "GET", url: "/v1/conversations", ...A });
  assert(all.statusCode === 200 && all.json().conversations.length === 4, "list: owner sees their 4 conversations");
  const bobList = await app.inject({ method: "GET", url: "/v1/conversations", ...B });
  assert(bobList.json().conversations.length === 0, "list: other user sees none of them");
  assert((await app.inject({ method: "GET", url: `/v1/conversations/${convId}`, ...B })).statusCode === 404, "detail: other user gets 404");
  assert((await app.inject({ method: "PATCH", url: `/v1/conversations/${convId}`, ...B, payload: { isBookmarked: true } })).statusCode === 404, "patch: other user cannot bookmark (404)");

  const byAcct = await app.inject({ method: "GET", url: `/v1/conversations?providerAccountId=${claude.id}`, ...A });
  assert(byAcct.json().conversations.length === 1, "list: filter by account");

  const byContent = await app.inject({ method: "GET", url: "/v1/conversations?q=trigram", headers: extHeaders });
  const bc = byContent.json().conversations as { id: string; snippet: string }[];
  assert(byContent.statusCode === 200 && bc.length >= 1 && bc.some((c) => c.id === convId), "search: finds a conversation by message content");
  assert(bc.find((c) => c.id === convId)!.snippet.includes("[["), "search: snippet highlights the match with [[ ]]");
  const byTitle = await app.inject({ method: "GET", url: "/v1/conversations?q=" + encodeURIComponent("Big thr"), ...A });
  assert(byTitle.json().conversations.some((c: { title: string }) => c.title === "Big thread"), "search: partial title match works");
  const none = await app.inject({ method: "GET", url: "/v1/conversations?q=xyzzynomatch", ...A });
  assert(none.json().conversations.length === 0, "search: no match -> empty");
  const wild = await app.inject({ method: "GET", url: "/v1/conversations?q=" + encodeURIComponent("%"), ...A });
  assert(wild.statusCode === 200 && wild.json().conversations.length === 0, "search: LIKE wildcards are matched literally");
  const bobSearch = await app.inject({ method: "GET", url: "/v1/conversations?q=trigram", ...B });
  assert(bobSearch.json().conversations.length === 0, "search: never returns another user's content");

  // Keyset pagination: pages of 2 cover everything exactly once.
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 5; i++) {
    const page = await app.inject({ method: "GET", url: `/v1/conversations?limit=2${cursor ? "&cursor=" + cursor : ""}`, ...A });
    const body = page.json() as { conversations: { id: string }[]; nextCursor: string | null };
    seen.push(...body.conversations.map((c) => c.id));
    cursor = body.nextCursor;
    if (!cursor) break;
  }
  assert(seen.length === 4 && new Set(seen).size === 4, "list: cursor pagination returns each conversation exactly once");
  assert((await app.inject({ method: "GET", url: "/v1/conversations?cursor=garbage", ...A })).statusCode === 400, "list: bad cursor -> 400");

  const bm = await app.inject({ method: "PATCH", url: `/v1/conversations/${convId}`, ...A, payload: { isBookmarked: true } });
  assert(bm.statusCode === 200 && bm.json().isBookmarked === true, "patch: bookmark");
  const bmList = await app.inject({ method: "GET", url: "/v1/conversations?bookmarked=true", ...A });
  assert(bmList.json().conversations.length === 1, "list: bookmarked filter");

  // --- archive blocks ingestion; delete cascades ----------------------------------------------------------------
  await app.inject({ method: "PATCH", url: `/v1/accounts/${claude.id}`, ...A, payload: { archived: true } });
  const arch = await post(batch(claude.id, [conv("c2", { providerId: "claude" })], "claude"));
  assert(arch.statusCode === 409 && arch.json().error === "account_archived", "ingest: archived account refuses captures (409)");

  assert((await app.inject({ method: "DELETE", url: `/v1/accounts/${bobGpt.id}`, ...A })).statusCode === 404, "accounts: cannot delete another user's account (404)");
  assert((await app.inject({ method: "DELETE", url: `/v1/accounts/${gpt.id}`, ...A })).statusCode === 200, "accounts: delete");
  const left = await db.execute(sql`select (select count(*)::int from conversations where provider_account_id = ${gpt.id}) c, (select count(*)::int from messages where conversation_id = ${convId}) m`);
  const lr = left.rows[0] as { c: number; m: number };
  assert(lr.c === 0 && lr.m === 0, "accounts: delete cascades to conversations and messages");

  await db.execute(sql`delete from users where id in (${alice!.id}, ${bob!.id})`);
  console.log("cleaned up test users");
  console.log("ALL INGESTION CHECKS PASSED");
} catch (e) {
  console.error(e);
  await db.execute(sql`delete from users where email like ${"%-" + stamp + "@test.local"}`).catch(() => {});
  process.exitCode = 1;
} finally {
  await app.close();
  await pool.end();
}
