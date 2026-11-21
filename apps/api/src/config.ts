import { z } from "zod";

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(3001),
  /** Pooled Neon URL (PgBouncer) used for app traffic. */
  DATABASE_URL: z.string().url(),
  /** Direct Neon URL; used only by migrations/tooling. */
  DATABASE_URL_UNPOOLED: z.string().url().optional(),
  WEB_ORIGIN: z.string().url().default("http://localhost:5173"),

  /** Google OAuth client. If unset, the Google login routes answer 503 "not configured". */
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  /** Defaults to WEB_ORIGIN + /v1/auth/google/callback so login goes through the web origin (same-origin cookies). */
  GOOGLE_REDIRECT_URI: z.string().url().optional(),
  /** Optional comma-separated allowlist of emails permitted to sign in (private beta guard). */
  ALLOWED_EMAILS: z.string().optional(),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  EXTENSION_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(90),
});

/** Fails fast at boot if configuration is missing or malformed. */
export const config = Env.parse(process.env);
