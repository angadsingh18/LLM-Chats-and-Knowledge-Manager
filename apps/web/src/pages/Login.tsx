export function Login() {
  // Remember where the user was heading (e.g. /pair?code=…) so we can return after Google sign-in.
  const start = () => {
    try {
      sessionStorage.setItem("postLogin", location.pathname + location.search);
    } catch {
      /* storage unavailable: fall back to home */
    }
  };
  return (
    <div className="flex h-screen items-center justify-center bg-neutral-50">
      <div className="w-80 rounded-lg border border-neutral-200 bg-white p-6 text-center">
        <h1 className="text-lg font-semibold">AI Manager</h1>
        <p className="mt-1 text-sm text-neutral-500">Sign in to see your unified AI history.</p>
        {/* Full-page navigation: the API sets the OAuth cookies and redirects to Google. */}
        <a
          href="/v1/auth/google"
          onClick={start}
          className="mt-5 block rounded bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-700"
        >
          Continue with Google
        </a>
      </div>
    </div>
  );
}
