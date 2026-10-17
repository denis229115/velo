import { useId, useMemo, useRef, useState } from "react";
import { fuzzyMatch } from "@/utils/fuzzyMatch";

export interface ComboboxOption {
  id: string;
  label: string;
  detail?: string;
}

interface ComboboxProps {
  label: string;
  options: ComboboxOption[];
  /** Shown above the filtered list: Assign to me, Unassigned, and similar. */
  pinned?: ComboboxOption[];
  value: string | null;
  onChange: (id: string | null) => void;
  placeholder?: string;
}

/**
 * An editable combobox. Typing filters, arrows move the active option,
 * Enter selects it. The listbox is labelled by the same name as the input.
 */
export function Combobox({ label, options, pinned = [], value, onChange, placeholder = "Search" }: ComboboxProps) {
  const reactId = useId();
  const listId = `${reactId}-list`;
  const labelId = `${reactId}-label`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const items = useMemo(() => {
    const q = query.trim();
    const ranked = options
      .map((option) => ({ option, score: q ? (fuzzyMatch(option.label, q)?.score ?? 0) : 1 }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((row) => row.option);
    const pinnedIds = new Set(pinned.map((option) => option.id));
    const head = q ? pinned.filter((option) => fuzzyMatch(option.label, q)) : pinned;
    return [...head, ...ranked.filter((option) => !pinnedIds.has(option.id))];
  }, [options, pinned, query]);

  const selected = options.find((option) => option.id === value) ?? pinned.find((option) => option.id === value);
  const activeItem = items[active];
  const activeKey = activeItem ? optionKey(activeItem.id) : undefined;

  const choose = (id: string | null) => {
    onChange(id);
    setQuery("");
    setOpen(false);
  };

  return (
    <div className="min-w-0">
      <label id={labelId} htmlFor={`${reactId}-input`} className="text-meta text-text-tertiary">
        {label}
      </label>
      <input
        id={`${reactId}-input`}
        ref={inputRef}
        role="combobox"
        aria-labelledby={labelId}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && activeKey ? `${reactId}-opt-${activeKey}` : undefined}
        value={open ? query : (selected?.label ?? "")}
        placeholder={placeholder}
        className="mt-1 w-full rounded-[var(--radius-control-sm)] border border-separator bg-surface-subtle px-2 py-1.5 text-row text-text-primary outline-none"
        onFocus={() => {
          setOpen(true);
          setQuery("");
          setActive(0);
        }}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
            setActive((i) => Math.min(i + 1, Math.max(items.length - 1, 0)));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (event.key === "Enter") {
            event.preventDefault();
            const item = items[active];
            if (item) choose(item.id === "" ? null : item.id);
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            setQuery("");
          }
        }}
        onBlur={() => {
          window.setTimeout(() => setOpen(false), 120);
        }}
      />
      {open && (
        <ul id={listId} role="listbox" aria-label={label} className="material-pop mt-1 max-h-56 overflow-y-auto rounded-[var(--radius-menu)] py-1">
          {items.length === 0 ? (
            <li className="px-3 py-2 text-meta text-text-tertiary">No matches</li>
          ) : (
            items.map((option, index) => (
              <li
                key={optionKey(option.id)}
                id={`${reactId}-opt-${optionKey(option.id)}`}
                role="option"
                aria-selected={index === active}
                className={`px-3 py-1.5 text-row cursor-pointer ${index === active ? "bg-state-hover" : ""}`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(option.id === "" ? null : option.id);
                }}
                onMouseEnter={() => setActive(index)}
              >
                <span className="text-text-primary">{option.label}</span>
                {option.detail && <span className="block text-meta text-text-tertiary">{option.detail}</span>}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

function optionKey(id: string): string {
  return id === "" ? "none" : id;
}
