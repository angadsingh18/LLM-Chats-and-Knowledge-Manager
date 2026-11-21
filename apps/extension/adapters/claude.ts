import type { PageAdapter } from "@ai-manager/provider-adapters";

/** Claude page adapter (STUB); see chatgpt.ts. */
export const claudeAdapter: PageAdapter = {
  providerId: "claude",
  matchesUrl: (u) => u.hostname === "claude.ai",
  detectAccount: () => null,
  extractConversation: () => null,
  isHealthy: () => false,
};
