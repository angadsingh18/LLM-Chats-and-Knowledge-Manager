import { z } from "zod";
import { NormalizedConversation } from "./conversation";

export const CaptureSource = z.enum(["extension", "import", "api", "workspace", "manual"]);

export const CaptureBatch = z.object({
  providerId: z.string().min(1),
  /** The user's labelled account (provider_accounts.id) this batch belongs to. */
  providerAccountId: z.string().uuid(),
  source: CaptureSource,
  conversations: z.array(NormalizedConversation).min(1).max(200),
});
export type CaptureBatch = z.infer<typeof CaptureBatch>;

/** Response lets the extension update its local delta-sync state. */
export const CaptureResult = z.object({
  results: z.array(
    z.object({
      externalId: z.string(),
      conversationId: z.string().uuid(),
      newMessageCount: z.number().int().nonnegative(),
    }),
  ),
});
export type CaptureResult = z.infer<typeof CaptureResult>;
