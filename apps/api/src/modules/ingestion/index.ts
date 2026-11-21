import { CaptureBatch } from "@ai-manager/schemas";
import type { FastifyPluginAsync } from "fastify";
import { withUser } from "../../db/client.js";
import { requireAuth } from "../auth/guard.js";
import { IngestError, ingestBatch } from "./upsert.js";

/**
 * Ingestion module. Every capture path (extension, import, API) funnels through the same
 * validated, idempotent write in upsert.ts.
 */
export const ingestionModule: FastifyPluginAsync = async (app) => {
  app.post(
    "/captures",
    { preHandler: requireAuth({ scope: "ingest" }), config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const parsed = CaptureBatch.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_capture", issues: parsed.error.issues });

      const userId = req.auth!.userId;
      try {
        return await withUser(userId, (tx) => ingestBatch(tx, userId, parsed.data));
      } catch (e) {
        if (e instanceof IngestError) return reply.code(e.status).send({ error: e.code });
        throw e;
      }
    },
  );
};
