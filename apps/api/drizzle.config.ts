import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  // Direct (unpooled) connection for drizzle-kit; falls back to DATABASE_URL.
  dbCredentials: {
    url:
      process.env.DATABASE_URL_UNPOOLED ??
      process.env.DATABASE_URL ??
      "postgres://aimanager:aimanager@localhost:5432/aimanager",
  },
});
