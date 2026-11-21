import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ApiError, api } from "../lib/api";

/** Approves the code shown by the extension, linking that browser to this account. */
export function Pair() {
  const [params] = useSearchParams();
  const [code, setCode] = useState(params.get("code") ?? "");
  const approve = useMutation({
    mutationFn: () => api<{ ok: true; deviceLabel: string | null }>("/v1/auth/extension/pair/approve", { method: "POST", body: { userCode: code } }),
  });

  return (
    <div className="max-w-md">
      <h1 className="text-xl font-semibold">Connect the browser extension</h1>
      <p className="mt-1 text-sm text-neutral-500">
        Check that this code matches the one shown in the extension. The extension will be able to send captured
        conversations to your account, and you can revoke it any time in Settings.
      </p>
      <input
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="XXXX-XXXX"
        className="mt-4 w-full rounded border border-neutral-300 px-3 py-2 font-mono text-lg tracking-widest"
      />
      <button
        onClick={() => approve.mutate()}
        disabled={!code || approve.isPending || approve.isSuccess}
        className="mt-3 rounded bg-neutral-900 px-3 py-2 text-sm text-white disabled:opacity-50"
      >
        Approve
      </button>
      {approve.isSuccess && <p className="mt-3 text-sm text-green-700">Approved. You can return to the extension.</p>}
      {approve.isError && (
        <p className="mt-3 text-sm text-red-700">
          {approve.error instanceof ApiError && approve.error.status === 404 ? "That code is invalid or expired." : "Something went wrong."}
        </p>
      )}
    </div>
  );
}
