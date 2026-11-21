import type { PageAdapter } from "@ai-manager/provider-adapters";

/**
 * ChatGPT page adapter (STUB). Real selectors are written against saved HTML
 * fixtures in the adapter step; none are guessed here.
 */
export const chatgptAdapter: PageAdapter = {
  providerId: "chatgpt",
  matchesUrl: (u) => u.hostname === "chatgpt.com" || u.hostname === "chat.openai.com",
  detectAccount: () => null,
  extractConversation: () => null,
  isHealthy: () => false,
};
