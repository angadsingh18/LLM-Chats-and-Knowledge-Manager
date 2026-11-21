import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useMe } from "../lib/useMe";
import { Login } from "./Login";

/**
 * Landing page at "/". Always shown first: signed out it is the sign-in card; signed in it shows
 * who you are with a button into the app (so opening the site never drops you straight into a page).
 */
export function Home() {
  const me = useMe();
  const qc = useQueryClient();
  const logout = useMutation({
    mutationFn: () => api("/v1/auth/logout", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });

  if (me.isLoading) return <div className="p-6 text-sm text-neutral-500">Loading…</div>;
  if (!me.data) return <Login />;

  const { user } = me.data;
  const first = user.name?.split(" ")[0] ?? user.email;

  return (
    <div className="flex h-screen items-center justify-center bg-neutral-50">
      <div className="w-80 rounded-lg border border-neutral-200 bg-white p-6 text-center">
        <h1 className="text-lg font-semibold">AI Manager</h1>
        <div className="mt-5 flex flex-col items-center">
          {user.avatarUrl ? (
            // Google avatar URLs can reject requests that carry a Referer, so don't send one.
            <img src={user.avatarUrl} alt="" referrerPolicy="no-referrer" className="h-14 w-14 rounded-full" />
          ) : (
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-neutral-200 text-lg font-medium text-neutral-600">
              {first.charAt(0).toUpperCase()}
            </div>
          )}
          <p className="mt-3 text-sm font-medium">Welcome back, {first}</p>
          <p className="text-xs text-neutral-500">Signed in as {user.email}</p>
        </div>
        <Link
          to="/inbox"
          className="mt-5 block rounded bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-700"
        >
          Open AI Manager
        </Link>
        <button onClick={() => logout.mutate()} disabled={logout.isPending} className="mt-3 text-xs text-neutral-500 hover:underline disabled:opacity-50">
          Not you? Sign out
        </button>
      </div>
    </div>
  );
}
