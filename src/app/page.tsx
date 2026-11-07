const DESIGN_TOKEN_SWATCHES = [
  { tokenName: "bg", swatchClassName: "bg-bg" },
  { tokenName: "card", swatchClassName: "bg-card" },
  { tokenName: "inner", swatchClassName: "bg-inner" },
  { tokenName: "text", swatchClassName: "bg-text" },
  { tokenName: "muted", swatchClassName: "bg-muted" },
  { tokenName: "lime", swatchClassName: "bg-lime" },
  { tokenName: "blue", swatchClassName: "bg-blue" },
  { tokenName: "orange", swatchClassName: "bg-orange" },
] as const;

export default function HomePage() {
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <section className="w-full max-w-md rounded-card border border-card-border bg-card p-8">
        <h1 className="text-2xl font-semibold">Pickleball Social Manager</h1>
        <p className="mt-2 text-muted">Design tokens</p>
        <ul className="mt-6 flex flex-wrap gap-3">
          {DESIGN_TOKEN_SWATCHES.map(({ tokenName, swatchClassName }) => (
            <li key={tokenName} className="flex flex-col items-center gap-1">
              <span
                aria-hidden="true"
                className={`size-8 rounded-full border border-inner-border ${swatchClassName}`}
              />
              <span className="text-xs text-muted">{tokenName}</span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
