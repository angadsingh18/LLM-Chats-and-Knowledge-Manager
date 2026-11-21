import type { FastifyPluginAsync } from "fastify";
import { listProviderIds } from "@ai-manager/provider-adapters";

/** Providers registry + labelled account CRUD (account CRUD pending auth). */
export const providersModule: FastifyPluginAsync = async (app) => {
  app.get("/providers", async () => ({ providers: listProviderIds() }));
};
