import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

/**
 * Applies the SQL files in ./drizzle in lexical order, tracking applied files.
 * Minimal runner so hand-written SQL (RLS, generated tsvector) runs alongside
 * drizzle-kit's generated migrations.
 *
 * Uses the DIRECT (unpooled) Neon URL: migrations rely on session state, which
 * PgBouncer transaction pooling does not preserve.
 */
async function main() {
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL_UNPOOLED or DATABASE_URL must be set");
  const client = new pg.Client({ connectionString: url });
  await client.connect();

  const dir = join(process.cwd(), "drizzle");
  await client.query(`create table if not exists _migrations (name text primary key, applied_at timestamptz default now())`);
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const done = await client.query("select 1 from _migrations where name=$1", [f]);
    if (done.rowCount) continue;
    console.log("applying", f);
    // Drizzle-kit separates statements with this marker; run each one, all-or-nothing per file.
    const sqlText = readFileSync(join(dir, f), "utf8");
    await client.query("begin");
    try {
      for (const stmt of sqlText.split("--> statement-breakpoint")) {
        if (stmt.trim()) await client.query(stmt);
      }
      await client.query("insert into _migrations(name) values($1)", [f]);
      await client.query("commit");
    } catch (e) {
      await client.query("rollback");
      throw e;
    }
  }
  await client.end();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
