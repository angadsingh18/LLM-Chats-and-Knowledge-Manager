import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useMe } from "../lib/useMe";
import { AccountsSection } from "./AccountsSection";

interface SessionRow {
  id: string;
  kind: "web" | "extension";
  deviceLabel: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

export function Settings() {
  const qc = useQueryClient();
  const me = useMe();
  const sessions = useQuery({ queryKey: ["sessions"], queryFn: () => api<{ sessions: SessionRow[] }>("/v1/auth/sessions") });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/v1/auth/sessions/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sessions"] }),
  });
  const logout = useMutation({
    mutationFn: () => api("/v1/auth/logout", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });

  return (
    <div className="max-w-2xl">
      <h1 className="text-xl font-semibold">Settings</h1>
      <p className="mt-1 text-sm text-neutral-500">Signed in as {me.data?.user.email}</p>

      <AccountsSection />

      <h2 className="mt-6 text-sm font-semibold">Signed-in devices</h2>
      <ul className="mt-2 divide-y divide-neutral-200 rounded border border-neutral-200 bg-white">
        {sessions.data?.sessions.map((s) => (
          <li key={s.id} className="flex items-center justify-between px-3 py-2 text-sm">
            <div>
              <div>
                {s.kind === "extension" ? "Browser extension" : "Web"} {s.current && <span className="text-neutral-400">(this device)</span>}
              </div>
              <div className="text-xs text-neutral-500">
                {s.deviceLabel ?? "Unknown device"} · last active {new Date(s.lastSeenAt).toLocaleString()}
              </div>
            </div>
            {!s.current && (
              <button onClick={() => revoke.mutate(s.id)} className="text-xs text-red-700 hover:underline">
                Revoke
              </button>
            )}
          </li>
        ))}
      </ul>

      <button onClick={() => logout.mutate()} className="mt-6 rounded border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100">
        Sign out
      </button>
    </div>
  );
}
