import type { Normalizer, PageAdapter } from "./types";

const pageAdapters = new Map<string, PageAdapter>();
const normalizers = new Map<string, Normalizer>();

export function registerPageAdapter(a: PageAdapter) {
  pageAdapters.set(a.providerId, a);
}
export function registerNormalizer(n: Normalizer) {
  normalizers.set(n.providerId, n);
}
export function findPageAdapter(url: URL): PageAdapter | undefined {
  for (const a of pageAdapters.values()) if (a.matchesUrl(url)) return a;
  return undefined;
}
export function getNormalizer(providerId: string): Normalizer | undefined {
  return normalizers.get(providerId);
}
export function listProviderIds(): string[] {
  return [...new Set([...pageAdapters.keys(), ...normalizers.keys()])];
}
