import { createHash, randomBytes, randomInt } from "node:crypto";

/** Random bearer secret. The prefix makes leaked tokens easy to spot in secret scanners. */
export function generateToken(prefix: "aimw" | "aime" | "aimd"): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

/** Only this hash is stored. Tokens are high-entropy, so a fast hash is appropriate (no salt/KDF needed). */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// No 0/O/1/I/L so the code is easy to read aloud and type.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** Short code the user types/confirms during extension pairing, e.g. "K7QM-X2PD" (~40 bits). */
export function generateUserCode(): string {
  const pick = () => ALPHABET[randomInt(ALPHABET.length)]!;
  const s = Array.from({ length: 8 }, pick).join("");
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export function normalizeUserCode(input: string): string {
  const s = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : input.toUpperCase();
}
