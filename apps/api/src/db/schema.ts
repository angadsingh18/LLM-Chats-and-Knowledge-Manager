import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** Postgres tsvector column (generated in the SQL migration, see rls.sql). */
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  /** Unused while sign-in is Google-only; kept nullable for a future email/password option. */
  passwordHash: text("password_hash"),
  /** Google's stable account id (`sub`); the identity key, not the email. */
  googleSub: text("google_sub").unique(),
  name: text("name"),
  avatarUrl: text("avatar_url"),
  createdAt: createdAt(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

/**
 * Login sessions (web cookie) and extension tokens. Only a SHA-256 hash of the secret token
 * is stored. NOT under RLS: it is read before a user is known. The aimanager_app role
 * has no grant on it, so it is only reachable outside withUser().
 */
export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    kind: text("kind").notNull(), // 'web' | 'extension'
    scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
    deviceLabel: text("device_label"),
    createdAt: createdAt(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/** Device-code pairing for the extension: pending → approved (by a logged-in web user) → consumed. */
export const pairingRequests = pgTable("pairing_requests", {
  id: id(),
  deviceCodeHash: text("device_code_hash").notNull().unique(),
  userCode: text("user_code").notNull().unique(),
  deviceLabel: text("device_label"),
  status: text("status").notNull().default("pending"), // pending | approved | consumed
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  createdAt: createdAt(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

/** Seeded registry, not user data (no RLS). */
export const providers = pgTable("providers", {
  id: text("id").primaryKey(), // 'chatgpt' | 'claude' | ...
  displayName: text("display_name").notNull(),
  capabilities: jsonb("capabilities").notNull().default({}),
});

export const providerAccounts = pgTable(
  "provider_accounts",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull().references(() => providers.id),
    label: text("label").notNull(),
    externalAccountHint: text("external_account_hint"),
    color: text("color"),
    createdAt: createdAt(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [index("provider_accounts_user_idx").on(t.userId)],
);

export const conversations = pgTable(
  "conversations",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    providerAccountId: uuid("provider_account_id")
      .notNull()
      .references(() => providerAccounts.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    title: text("title"),
    url: text("url"),
    source: text("source").notNull(), // extension | import | api | workspace | manual
    createdAtSource: timestamp("created_at_source", { withTimezone: true }),
    updatedAtSource: timestamp("updated_at_source", { withTimezone: true }),
    firstCapturedAt: createdAt(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).notNull().defaultNow(),
    messageCount: integer("message_count").notNull().default(0),
    contentHash: text("content_hash"),
    isPartial: boolean("is_partial").notNull().default(false),
    isBookmarked: boolean("is_bookmarked").notNull().default(false),
    reviewStatus: text("review_status").notNull().default("pending"),
    rawMetadata: jsonb("raw_metadata").notNull().default({}),
  },
  (t) => [
    // Idempotency key: the same provider conversation never duplicates.
    uniqueIndex("conversations_account_external_uq").on(t.providerAccountId, t.externalId),
    index("conversations_user_updated_idx").on(t.userId, t.updatedAtSource),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: id(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    externalId: text("external_id"),
    parentExternalId: text("parent_external_id"),
    role: text("role").notNull(), // user | assistant | system | tool
    modelName: text("model_name"),
    contentParts: jsonb("content_parts").notNull(),
    contentText: text("content_text").notNull(),
    contentHash: text("content_hash").notNull(),
    createdAtSource: timestamp("created_at_source", { withTimezone: true }),
    /** GENERATED ALWAYS AS (to_tsvector('simple', content_text)) STORED — added in custom SQL. */
    fts: tsvector("fts"),
    rawMetadata: jsonb("raw_metadata").notNull().default({}),
  },
  (t) => [uniqueIndex("messages_conv_ordinal_uq").on(t.conversationId, t.ordinal)],
);

export const attachments = pgTable("attachments", {
  id: id(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  mimeType: text("mime_type"),
  sizeBytes: integer("size_bytes"),
  storageKey: text("storage_key"),
});
