import { z } from "zod";

/** Provider ids are open strings so new providers need no schema change. */
export const ProviderId = z.string().min(1).max(64);

export const MessageRole = z.enum(["user", "assistant", "system", "tool"]);
export type MessageRole = z.infer<typeof MessageRole>;

/** Structured message content; `content_text` is derived from these. */
export const ContentPart = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("code"), text: z.string(), language: z.string().optional() }),
  z.object({ type: z.literal("image"), ref: z.string().optional(), alt: z.string().optional() }),
  z.object({ type: z.literal("citation"), url: z.string().optional(), title: z.string().optional() }),
  z.object({ type: z.literal("other"), raw: z.unknown() }),
]);
export type ContentPart = z.infer<typeof ContentPart>;

export const NormalizedAttachment = z.object({
  filename: z.string(),
  mimeType: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
});

export const NormalizedMessage = z.object({
  externalId: z.string().optional(),
  parentExternalId: z.string().optional(),
  ordinal: z.number().int().nonnegative(),
  role: MessageRole,
  modelName: z.string().optional(),
  contentParts: z.array(ContentPart).min(1),
  createdAtSource: z.string().datetime().optional(),
  attachments: z.array(NormalizedAttachment).default([]),
  rawMetadata: z.record(z.unknown()).default({}),
});
export type NormalizedMessage = z.infer<typeof NormalizedMessage>;

/** The provider-independent conversation shape every ingestion path produces. */
export const NormalizedConversation = z.object({
  providerId: ProviderId,
  externalId: z.string().min(1),
  title: z.string().optional(),
  url: z.string().url().optional(),
  createdAtSource: z.string().datetime().optional(),
  updatedAtSource: z.string().datetime().optional(),
  /** true when only part of the thread was visible (virtualized DOM) */
  partial: z.boolean().default(false),
  messages: z.array(NormalizedMessage),
  rawMetadata: z.record(z.unknown()).default({}),
});
export type NormalizedConversation = z.infer<typeof NormalizedConversation>;
