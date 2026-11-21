export function ProviderBadge({ provider, account }: { provider: string; account?: string }) {
  return (
    <span style={{ fontSize: 12, padding: "2px 6px", borderRadius: 4, background: "#eee" }}>
      {provider}
      {account ? ` · ${account}` : ""}
    </span>
  );
}
