import type { ReactNode } from "react";
import { fuzzyMatch } from "@/utils/fuzzyMatch";

export function HighlightedText({ text, query }: { text: string; query: string }) {
  const hit = query.trim() ? fuzzyMatch(text, query) : null;
  if (!hit || hit.ranges.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let cursor = 0;
  hit.ranges.forEach(([start, end], index) => {
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(
      <mark key={index} className="bg-transparent text-accent font-medium">
        {text.slice(start, end)}
      </mark>,
    );
    cursor = end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}
