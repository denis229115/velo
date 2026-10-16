import { formatKeyBinding } from "@/components/list/Kbd";

/** Tooltip text such as "Compose (C)" or "Search (Cmd+K)" for a registry binding. */
export function shortcutTooltip(label: string, binding: string | undefined): string {
  const keys = binding ? formatKeyBinding(binding).join("+") : "";
  return keys ? `${label} (${keys})` : label;
}
