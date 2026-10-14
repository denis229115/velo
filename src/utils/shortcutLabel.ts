export type ShortcutPlatform = "mac" | "windows" | "linux";

/** Platform Velo is running on, from the webview's user agent. */
export function detectPlatform(): ShortcutPlatform {
  const ua = navigator.userAgent;
  if (ua.includes("Macintosh")) return "mac";
  if (ua.includes("Windows")) return "windows";
  return "linux";
}

export function isMacPlatform(): boolean {
  return detectPlatform() === "mac";
}

const MAC_MODIFIER_LABELS: Record<string, string> = {
  Ctrl: "Cmd",
  Cmd: "Cmd",
  CmdOrCtrl: "Cmd",
  Alt: "Option",
};

/**
 * The label to display for a key binding such as "Ctrl+Shift+L".
 * Bindings are stored with Ctrl/Alt; on macOS they are shown as Cmd/Option.
 * Other platforms show the binding unchanged. Every place that displays a
 * shortcut must go through this function.
 */
export function formatShortcut(
  binding: string,
  platform: ShortcutPlatform = detectPlatform(),
): string {
  if (platform !== "mac" || !binding.includes("+")) return binding;
  // The final segment is the key itself, which may be "+".
  const key = binding.endsWith("+") ? "+" : binding.slice(binding.lastIndexOf("+") + 1);
  const modifiers = binding.slice(0, binding.length - key.length).split("+").filter(Boolean);
  return [...modifiers.map((m) => MAC_MODIFIER_LABELS[m] ?? m), key].join("+");
}
