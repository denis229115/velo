/** Marks sample data wherever it is shown, so it is never mistaken for real data. */
export function SampleBadge() {
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[0.65rem] font-semibold uppercase tracking-wider border border-warning/40 bg-warning/10 text-warning">
      Sample
    </span>
  );
}
