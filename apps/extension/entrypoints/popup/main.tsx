import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { checkToken, clearToken, getToken, startPairing, waitForApproval, type PairStart } from "../../lib/pairing";

type State =
  | { kind: "loading" }
  | { kind: "signed-out" }
  | { kind: "pairing"; pair: PairStart }
  | { kind: "connected"; email: string }
  | { kind: "error"; message: string };

function Popup() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    (async () => {
      const token = await getToken();
      if (!token) return setState({ kind: "signed-out" });
      const user = await checkToken(token);
      if (user) setState({ kind: "connected", email: user.email });
      else {
        await clearToken(); // revoked or expired
        setState({ kind: "signed-out" });
      }
    })().catch(() => setState({ kind: "error", message: "Cannot reach the AI Manager API." }));
    return () => abort.current?.abort();
  }, []);

  const connect = async () => {
    try {
      const pair = await startPairing();
      setState({ kind: "pairing", pair });
      chrome.tabs.create({ url: pair.verificationUrl });
      abort.current = new AbortController();
      // NOTE: polling lives in the popup, so it stops if the popup is closed. Moving it to the
      // service worker (alarms) is a planned improvement.
      const ok = await waitForApproval(pair, abort.current.signal);
      if (ok) {
        const token = await getToken();
        const user = token ? await checkToken(token) : null;
        setState(user ? { kind: "connected", email: user.email } : { kind: "signed-out" });
      } else setState({ kind: "signed-out" });
    } catch {
      setState({ kind: "error", message: "Could not start pairing. Is the API running?" });
    }
  };

  return (
    <div style={{ width: 280, padding: 12, fontFamily: "system-ui, sans-serif", fontSize: 13 }}>
      <strong>AI Manager</strong>
      {state.kind === "loading" && <p>Loading…</p>}
      {state.kind === "signed-out" && (
        <>
          <p style={{ color: "#666" }}>Not connected to your account.</p>
          <button onClick={connect}>Connect</button>
        </>
      )}
      {state.kind === "pairing" && (
        <p>
          Confirm this code in the tab that just opened:
          <br />
          <code style={{ fontSize: 20, letterSpacing: 2 }}>{state.pair.userCode}</code>
        </p>
      )}
      {state.kind === "connected" && (
        <>
          <p>Connected as {state.email}</p>
          <button
            onClick={async () => {
              await clearToken();
              setState({ kind: "signed-out" });
            }}
          >
            Disconnect
          </button>
        </>
      )}
      {state.kind === "error" && <p style={{ color: "#b00" }}>{state.message}</p>}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Popup />);
