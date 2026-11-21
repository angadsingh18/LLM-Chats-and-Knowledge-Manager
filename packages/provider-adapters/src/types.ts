import type { NormalizedConversation } from "@ai-manager/schemas";

/** What a content script hands to the service worker before normalization. */
export interface RawCapture {
  providerId: string;
  pageUrl: string;
  capturedAt: string;
  /** Provider-specific payload; only that provider's normalizer interprets it. */
  payload: unknown;
}

export interface AccountHint {
  externalAccountHint?: string;
}

/**
 * Runs inside the browser page (content script). Knows one provider's DOM.
 * Must never throw into the host page; return null when nothing is extractable.
 */
export interface PageAdapter {
  providerId: string;
  matchesUrl(url: URL): boolean;
  detectAccount(doc: Document): AccountHint | null;
  extractConversation(doc: Document): RawCapture | null;
  /** Health check: does extraction currently yield a plausible conversation? */
  isHealthy(doc: Document): boolean;
}

/** Runs on the backend. Converts one provider's data to the common schema. */
export interface Normalizer {
  providerId: string;
  normalize(raw: RawCapture): NormalizedConversation;
  /** Optional: parse a user-uploaded export file into conversations. */
  parseExport?(file: Uint8Array): AsyncIterable<NormalizedConversation>;
}
