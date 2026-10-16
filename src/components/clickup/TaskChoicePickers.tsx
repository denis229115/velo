import { useEffect, useId, useRef, useState } from "react";
import type { CreateTaskList } from "@/services/clickup/taskCreate";
import type { ClickUpMember } from "@/services/clickup/metadata";

const FIELD = "w-full rounded border border-separator bg-bg-tertiary px-2 py-1.5 text-sm text-text-primary disabled:opacity-60";
const PAGE_SIZE = 30;
const label = (list: CreateTaskList) => `${list.name} (${list.location})`;

function useDebounced(value: string) {
  const [query, setQuery] = useState(value);
  useEffect(() => { const timer = setTimeout(() => setQuery(value), 200); return () => clearTimeout(timer); }, [value]);
  return query;
}

export function ListPicker({ lists, value, disabled, onChange }: { lists: CreateTaskList[]; value: string; disabled: boolean; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [active, setActive] = useState(-1);
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const debouncedQuery = useDebounced(query);
  const filtering = query !== debouncedQuery;
  const search = debouncedQuery.trim().toLocaleLowerCase();
  const matches = lists.filter((l) => label(l).toLocaleLowerCase().includes(search));
  const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const choices = filtering ? [] : matches.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const selected = lists.find((l) => l.listId === value);
  useEffect(() => { setPage(0); setActive(-1); }, [search]);
  const choose = (list: CreateTaskList) => { onChange(list.listId); setOpen(false); setQuery(""); input.current?.focus(); };
  return <div onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) { setOpen(false); setQuery(""); } }}>
    <label htmlFor={`${id}-input`} className="block mb-1.5 text-sm text-text-secondary">List</label>
    <input ref={input} id={`${id}-input`} role="combobox" aria-autocomplete="list" aria-expanded={open && !disabled} aria-controls={`${id}-results`}
      aria-activedescendant={open && active >= 0 && choices[active] ? `${id}-${choices[active]!.listId}` : undefined}
      autoComplete="off" value={open ? query : selected ? label(selected) : ""} disabled={disabled}
      placeholder="Search lists, spaces or folders" className={FIELD}
      onClick={() => { if (!open) { setOpen(true); setQuery(""); } }}
      onChange={(e) => { setOpen(true); setQuery(e.target.value); setActive(-1); }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); setQuery(""); }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault(); setOpen(true);
          setActive((a) => {
            if (!choices.length) return -1;
            if (a < 0) return e.key === "ArrowDown" ? 0 : choices.length - 1;
            return (a + (e.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length;
          });
        }
        if (e.key === "Enter" && open) { e.preventDefault(); if (choices[active]) choose(choices[active]!); }
      }} />
    {open && !disabled && <div className="mt-1 border border-separator rounded bg-surface-overlay">
      <ul id={`${id}-results`} role="listbox" aria-label="Lists" aria-busy={filtering} className="max-h-48 overflow-y-auto">
        {choices.map((l, index) => <li key={l.listId} id={`${id}-${l.listId}`} role="option" aria-selected={value === l.listId}
          className={`px-2 py-2 text-sm cursor-pointer ${active === index ? "bg-bg-selected" : "hover:bg-bg-hover"}`}
          onMouseDown={(e) => e.preventDefault()} onMouseMove={() => setActive(index)} onClick={() => choose(l)}>{label(l)}</li>)}
      </ul>
      {filtering && <p role="status" className="p-2 text-meta text-text-secondary">Filtering lists…</p>}
      {!filtering && matches.length === 0 && <p role="status" className="p-2 text-meta text-text-secondary">No matching lists in the discovered set.</p>}
      <div className="flex items-center justify-between gap-2 p-2 text-meta text-text-secondary">
        <button type="button" disabled={currentPage === 0} onClick={() => { setPage(currentPage - 1); setActive(-1); }}>Previous lists</button>
        <span>{matches.length} results · Page {currentPage + 1} of {pages}</span>
        <button type="button" disabled={currentPage + 1 >= pages} onClick={() => { setPage(currentPage + 1); setActive(-1); }}>Next lists</button>
      </div>
    </div>}
    {selected && <p className="mt-1 text-meta text-text-secondary">Destination: {label(selected)}</p>}
  </div>;
}

/** Native checkboxes retain Space/Tab keyboard operation within the searchable dropdown. */
export function AssigneePicker({ members, selected, meUserId, disabled, onToggle }: { members: ClickUpMember[]; selected: string[]; meUserId: string | null; disabled: boolean; onToggle: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const id = useId();
  const search = useDebounced(query).trim().toLocaleLowerCase();
  const name = (m: ClickUpMember) => `${m.name}${m.userId === meUserId ? " (Me)" : ""}`;
  const matches = members.filter((m) => name(m).toLocaleLowerCase().includes(search));
  const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  useEffect(() => setPage(0), [search]);
  return <div onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }} onKeyDown={(e) => { if (e.key === "Escape" && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); document.getElementById(`${id}-button`)?.focus(); } }}>
    <button id={`${id}-button`} type="button" aria-label="Choose assignees" aria-expanded={open} aria-controls={`${id}-members`} disabled={disabled}
      className={`${FIELD} text-left`} onClick={() => setOpen((v) => !v)}>
      {members.filter((m) => selected.includes(m.userId)).map(name).join(", ") || "Choose assignees"}
    </button>
    {open && <div id={`${id}-members`} role="group" aria-label="List members" className="mt-1 rounded border border-separator p-2 space-y-2">
      <input aria-label="Search assignees" value={query} onChange={(e) => setQuery(e.target.value)} className={FIELD} />
      <div className="max-h-40 overflow-y-auto space-y-1">
        {matches.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map((m) => <label key={m.userId} className="flex items-center gap-2 py-1 text-sm">
          <input type="checkbox" checked={selected.includes(m.userId)} disabled={disabled} onChange={() => onToggle(m.userId)} />
          <span aria-hidden className="grid place-items-center size-6 shrink-0 rounded-full bg-accent-light text-accent text-micro">{m.name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase()}</span>
          {name(m)}
        </label>)}
      </div>
      {matches.length === 0 && <p role="status" className="text-meta text-text-secondary">{members.length === 0 ? "ClickUp returned no explicit members for this list." : "No matching list members."}</p>}
      {pages > 1 && <div className="flex justify-between text-meta">
        <button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous members</button>
        <span>Page {currentPage + 1} of {pages}</span>
        <button type="button" disabled={currentPage + 1 === pages} onClick={() => setPage(currentPage + 1)}>Next members</button>
      </div>}
    </div>}
    <p className="mt-1 text-micro text-text-tertiary">ClickUp returns explicit list members only; inherited Space, Folder or Team access is not included.</p>
  </div>;
}
