/** Extension-side device-code pairing against the AI Manager API. */
export const API_BASE = "http://localhost:3001"; // dev; becomes a build-time env var for production
const TOKEN_KEY = "authToken";

export interface PairStart {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
  interval: number;
}

export async function getToken(): Promise<string | null> {
  const v = await chrome.storage.local.get(TOKEN_KEY);
  return (v[TOKEN_KEY] as string | undefined) ?? null;
}

export async function clearToken() {
  await chrome.storage.local.remove(TOKEN_KEY);
}

export async function startPairing(): Promise<PairStart> {
  const res = await fetch(`${API_BASE}/v1/auth/extension/pair/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceLabel: "Chrome extension" }),
  });
  if (!res.ok) throw new Error(`pair/start failed: ${res.status}`);
  return res.json();
}

/** Polls until the user approves in the web app (or the code expires). Stores the token on success. */
export async function waitForApproval(p: PairStart, signal: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + p.expiresIn * 1000;
  while (Date.now() < deadline && !signal.aborted) {
    const res = await fetch(`${API_BASE}/v1/auth/extension/pair/poll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceCode: p.deviceCode }),
    });
    if (res.status === 200) {
      const { token } = (await res.json()) as { token: string };
      await chrome.storage.local.set({ [TOKEN_KEY]: token });
      return true;
    }
    if (res.status === 410) return false; // expired or already used
    await new Promise((r) => setTimeout(r, p.interval * 1000));
  }
  return false;
}

/** Checks the stored token is still valid (it may have been revoked in the web app). */
export async function checkToken(token: string): Promise<{ email: string } | null> {
  const res = await fetch(`${API_BASE}/v1/auth/me`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  return (await res.json()).user;
}
