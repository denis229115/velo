import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Set on <html> when the window shows native vibrancy behind the frame and sidebar. */
export const NATIVE_VIBRANCY_CLASS = "native-vibrancy";

/** Asks the backend whether this window has native vibrancy (macOS main window only). */
export async function isNativeVibrancyActive(): Promise<boolean> {
  try {
    return (await invoke<boolean>("native_vibrancy_active")) === true;
  } catch {
    return false;
  }
}

/**
 * Turns on the transparent frame and sidebar tokens when the backend applied
 * native vibrancy, and keeps the window appearance in step with the app theme
 * so the native material is light or dark to match the sidebar text.
 */
export function useNativeVibrancy(isDark: boolean): void {
  const [active, setActive] = useState(false);

  useEffect(() => {
    let cancelled = false;
    isNativeVibrancyActive().then((value) => {
      if (!cancelled) setActive(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle(NATIVE_VIBRANCY_CLASS, active);
    return () => root.classList.remove(NATIVE_VIBRANCY_CLASS);
  }, [active]);

  useEffect(() => {
    if (!active) return;
    getCurrentWindow()
      .setTheme(isDark ? "dark" : "light")
      .catch(() => {});
  }, [active, isDark]);
}
