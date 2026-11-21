import { useEffect } from "react";
import { Link, NavLink, Navigate, Outlet, Route, Routes, useNavigate } from "react-router-dom";
import { ProviderBadge } from "@ai-manager/ui";
import { useMe } from "./lib/useMe";
import { Home } from "./pages/Home";
import { Login } from "./pages/Login";
import { Pair } from "./pages/Pair";
import { Placeholder } from "./pages/Placeholder";
import { Settings } from "./pages/Settings";

const NAV = [
  { to: "/inbox", label: "Inbox" },
  { to: "/chats", label: "All Chats" },
  { to: "/import", label: "Import" },
  { to: "/settings", label: "Settings" },
];

/** Sidebar layout for every signed-in page. Signed-out visitors get the sign-in card instead. */
function Shell() {
  const me = useMe();
  if (me.isLoading) return <div className="p-6 text-sm text-neutral-500">Loading…</div>;
  if (!me.data) return <Login />;

  return (
    <div className="flex h-screen bg-neutral-50 text-neutral-900">
      <aside className="w-56 shrink-0 border-r border-neutral-200 bg-white p-3">
        <Link to="/" className="mb-4 block px-2 text-sm font-semibold hover:underline">
          AI Manager
        </Link>
        <nav className="flex flex-col gap-1">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) =>
                `rounded px-2 py-1.5 text-sm ${isActive ? "bg-neutral-100 font-medium" : "text-neutral-600 hover:bg-neutral-50"}`
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="flex-1 overflow-auto p-6">
        <Outlet />
      </main>
    </div>
  );
}

export function App() {
  const me = useMe();
  const navigate = useNavigate();

  // After Google sign-in the API redirects to "/"; resume where the user was headed (e.g. /pair?code=…).
  useEffect(() => {
    if (!me.data) return;
    try {
      const dest = sessionStorage.getItem("postLogin");
      if (dest) {
        sessionStorage.removeItem("postLogin");
        navigate(dest, { replace: true });
      }
    } catch {
      /* ignore */
    }
  }, [me.data, navigate]);

  return (
    <Routes>
      {/* "/" is always the landing page, whether or not you're signed in. */}
      <Route path="/" element={<Home />} />
      <Route element={<Shell />}>
        <Route path="/inbox" element={<Placeholder title="Inbox" note="Review queue arrives in Phase 2." />} />
        <Route
          path="/chats"
          element={
            <Placeholder title="All Chats" note="Unified dashboard (Phase 1).">
              <ProviderBadge provider="chatgpt" account="Personal" />
            </Placeholder>
          }
        />
        <Route path="/import" element={<Placeholder title="Import" note="Upload provider exports (Phase 1)." />} />
        <Route path="/pair" element={<Pair />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
