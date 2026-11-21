import type { ReactNode } from "react";

export function Placeholder({ title, note, children }: { title: string; note: string; children?: ReactNode }) {
  return (
    <div>
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="mt-1 text-sm text-neutral-500">{note}</p>
      <div className="mt-4">{children}</div>
    </div>
  );
}
