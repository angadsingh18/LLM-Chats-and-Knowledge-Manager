import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { sql } from "drizzle-orm";
import Fastify from "fastify";
import { config } from "./config.js";
import { db } from "./db/client.js";
import { accountsModule } from "./modules/accounts/index.js";
import { authModule } from "./modules/auth/index.js";
import { conversationsModule } from "./modules/conversations/index.js";
import { ingestionModule } from "./modules/ingestion/index.js";
import { providersModule } from "./modules/providers/index.js";

export async function buildApp() {
  const app = Fastify({
    // Never log request bodies: they contain conversation content.
    logger: { level: config.NODE_ENV === "production" ? "info" : "debug", redact: ["req.headers.authorization"] },
    bodyLimit: 10 * 1024 * 1024,
  });

  // Extension requests come from a chrome-extension:// origin and use Bearer tokens (no cookies),
  // so CORS only needs to cover the web origin; extension host_permissions bypass CORS.
  await app.register(cors, { origin: [config.WEB_ORIGIN], credentials: true });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  app.get("/health", async () => ({ status: "ok" }));
  // Verifies the Neon connection (pooled URL) end to end.
  app.get("/health/db", async (_req, reply) => {
    try {
      const r = await db.execute(sql`select 1 as ok`);
      return { status: "ok", db: (r.rows[0] as { ok: number }).ok === 1 };
    } catch {
      return reply.code(503).send({ status: "error", db: false });
    }
  });

  // Each module is an encapsulated Fastify plugin = a boundary we can extract later.
  await app.register(authModule, { prefix: "/v1/auth" });
  await app.register(providersModule, { prefix: "/v1" });
  await app.register(accountsModule, { prefix: "/v1/accounts" });
  await app.register(ingestionModule, { prefix: "/v1/ingest" });
  await app.register(conversationsModule, { prefix: "/v1/conversations" });

  return app;
}
