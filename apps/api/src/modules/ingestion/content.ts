import { createHash } from "node:crypto";
import type { ContentPart } from "@ai-manager/schemas";

/**
 * Postgres `text` and `jsonb` reject the NUL character (\u0000). Provider data can contain it,
 * so every value is scrubbed before it reaches the database.
 */
export function scrub<T>(value: T): T {
  if (typeof value === "string") return value.replace(/\u0000/g, "") as T;
  if (value === null || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value).replace(/\\u0000/g, "")) as T;
}

/** Plain text derived from structured parts; this is what full-text search indexes. */
export function partsToText(parts: ContentPart[]): string {
  const out: string[] = [];
  for (const p of parts) {
    switch (p.type) {
      case "text":
      case "code":
        out.push(p.text);
        break;
      case "image":
        if (p.alt) out.push(p.alt);
        break;
      case "citation":
        if (p.title ?? p.url) out.push((p.title ?? p.url)!);
        break;
      default:
        break; // "other" parts carry opaque data; not indexed
    }
  }
  return out.join("\n");
}

/**
 * Hash used to detect whether a message changed between captures. Key order is stable because
 * the parts come out of Zod parsing, which emits keys in schema order.
 */
export function hashMessage(role: string, parts: ContentPart[]): string {
  return createHash("sha256").update(JSON.stringify({ role, parts })).digest("hex");
}
