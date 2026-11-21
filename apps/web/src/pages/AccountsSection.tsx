import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, api } from "../lib/api";

interface Account {
  id: string;
  providerId: string;
  label: string;
  color: string | null;
  archivedAt: string | null;
  conversationCount: number;
}

const PROVIDERS = [
  { id: "chatgpt", name: "ChatGPT" },
  { id: "claude", name: "Claude" },
];
const providerName = (id: string) => PROVIDERS.find((p) => p.id === id)?.name ?? id;

/** Labelled provider accounts, e.g. "ChatGPT - Personal". Backed by /v1/accounts. */
export function AccountsSection() {
  const qc = useQueryClient();
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api<{ accounts: Account[] }>("/v1/accounts") });
  const refresh = () => qc.invalidateQueries({ queryKey: ["accounts"] });

  const [providerId, setProviderId] = useState(PROVIDERS[0]!.id);
  const [label, setLabel] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const create = useMutation({
    mutationFn: () => api("/v1/accounts", { method: "POST", body: { providerId, label: label.trim() } }),
    onSuccess: () => {
      setLabel("");
      return refresh();
    },
  });
  const patch = useMutation({
    mutationFn: (v: { id: string; body: Record<string, unknown> }) => api(`/v1/accounts/${v.id}`, { method: "PATCH", body: v.body }),
    onSuccess: () => {
      setEditingId(null);
      return refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/v1/accounts/${id}`, { method: "DELETE" }),
    onSuccess: refresh,
  });

  const saveRename = (a: Account) => {
    const next = draft.trim();
    if (!next || next === a.label) return setEditingId(null);
    patch.mutate({ id: a.id, body: { label: next } });
  };
  const confirmDelete = (a: Account) => {
    const n = a.conversationCount;
    const detail = n > 0 ? ` This also permanently deletes its ${n} stored conversation${n === 1 ? "" : "s"}.` : "";
    if (window.confirm(`Delete "${a.label}"?${detail}`)) remove.mutate(a.id);
  };

  const error = [create, patch, remove].find((m) => m.error)?.error;

  return (
    <section>
      <h2 className="mt-6 text-sm font-semibold">Connected accounts</h2>
      <p className="mt-1 text-xs text-neutral-500">
        Label each AI account you use (for example, a personal and a work ChatGPT) so their chats stay separate.
      </p>

      <ul className="mt-2 divide-y divide-neutral-200 rounded border border-neutral-200 bg-white">
        {accounts.isLoading && <li className="px-3 py-2 text-sm text-neutral-500">Loading…</li>}
        {accounts.data?.accounts.length === 0 && <li className="px-3 py-2 text-sm text-neutral-500">No accounts yet. Add one below.</li>}
        {accounts.data?.accounts.map((a) => (
          <li key={a.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
            <div className="min-w-0 flex-1">
              {editingId === a.id ? (
                <input
                  autoFocus
                  value={draft}
                  maxLength={80}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveRename(a);
                    if (e.key === "Escape") setEditingId(null);
                  }}
                  className="w-full rounded border border-neutral-300 px-2 py-1 text-sm"
                />
              ) : (
                <div className={a.archivedAt ? "text-neutral-400" : ""}>
                  {a.label} {a.archivedAt && <span className="text-xs">(archived)</span>}
                </div>
              )}
              <div className="text-xs text-neutral-500">
                {providerName(a.providerId)} · {a.conversationCount} conversation{a.conversationCount === 1 ? "" : "s"}
              </div>
            </div>
            <div className="flex shrink-0 gap-3 text-xs">
              {editingId === a.id ? (
                <>
                  <button onClick={() => saveRename(a)} className="text-blue-700 hover:underline">Save</button>
                  <button onClick={() => setEditingId(null)} className="text-neutral-500 hover:underline">Cancel</button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => {
                      setEditingId(a.id);
                      setDraft(a.label);
                    }}
                    className="text-blue-700 hover:underline"
                  >
                    Rename
                  </button>
                  <button onClick={() => patch.mutate({ id: a.id, body: { archived: !a.archivedAt } })} className="text-neutral-600 hover:underline">
                    {a.archivedAt ? "Unarchive" : "Archive"}
                  </button>
                  <button onClick={() => confirmDelete(a)} className="text-red-700 hover:underline">Delete</button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>

      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (label.trim()) create.mutate();
        }}
      >
        <select value={providerId} onChange={(e) => setProviderId(e.target.value)} className="rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm">
          {PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <input
          value={label}
          maxLength={80}
          onChange={(e) => setLabel(e.target.value)}
          placeholder='Label, e.g. "Personal"'
          className="min-w-0 flex-1 rounded border border-neutral-300 px-2 py-1.5 text-sm"
        />
        <button disabled={!label.trim() || create.isPending} className="rounded border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 disabled:opacity-50">
          Add account
        </button>
      </form>
      {error && (
        <p className="mt-2 text-xs text-red-700">
          {error instanceof ApiError ? `Request failed (${error.status})` : "Something went wrong"}
        </p>
      )}
    </section>
  );
}
