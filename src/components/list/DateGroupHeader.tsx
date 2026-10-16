/** Sticky "Today" / "Yesterday" / date label above a run of list rows. */
export function DateGroupHeader({ label }: { label: string }) {
  return (
    <div
      role="presentation"
      className="no-select sticky top-0 z-[1] px-4 h-7 flex items-center text-meta font-medium text-text-tertiary bg-surface-list/95 border-b border-border-secondary"
    >
      {label}
    </div>
  );
}
