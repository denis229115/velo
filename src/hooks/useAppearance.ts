import { useEffect, useState } from "react";
import { useUIStore } from "@/stores/uiStore";
import { getThemeById } from "@/constants/themes";
import { useNativeVibrancy } from "./useNativeVibrancy";

const DARK_QUERY = "(prefers-color-scheme: dark)";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const update = () => setMatches(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [query]);
  return matches;
}

/** Whether the app is currently dark: the manual override, or macOS appearance for "system". */
export function useIsDarkTheme(): boolean {
  const theme = useUIStore((s) => s.theme);
  const systemDark = useMediaQuery(DARK_QUERY);
  return theme === "dark" || (theme === "system" && systemDark);
}

/** Applies the theme, accent preset, motion preference and native vibrancy to <html>. Mount once per window. */
export function useAppearance(): void {
  const isDark = useIsDarkTheme();
  const colorTheme = useUIStore((s) => s.colorTheme);
  const reduceMotionSetting = useUIStore((s) => s.reduceMotion);
  const systemReducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);
  const reduceMotion = reduceMotionSetting || systemReducedMotion;

  useNativeVibrancy(isDark);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
  }, [isDark]);

  useEffect(() => {
    document.documentElement.classList.toggle("reduce-motion", reduceMotion);
  }, [reduceMotion]);

  useEffect(() => {
    const root = document.documentElement;
    const colors = isDark ? getThemeById(colorTheme).dark : getThemeById(colorTheme).light;
    root.style.setProperty("--color-accent", colors.accent);
    root.style.setProperty("--color-accent-hover", colors.accentHover);
    root.style.setProperty("--color-accent-light", colors.accentLight);
    root.style.setProperty("--color-bg-selected", colors.bgSelected);
    root.style.setProperty("--color-sidebar-active", colors.sidebarActive);
  }, [colorTheme, isDark]);
}
