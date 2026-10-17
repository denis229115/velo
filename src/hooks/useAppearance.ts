import { useEffect, useState } from "react";
import { useUIStore } from "@/stores/uiStore";
import { getThemeById } from "@/constants/themes";
import { isMacPlatform } from "@/utils/shortcutLabel";
import { useNativeVibrancy } from "./useNativeVibrancy";

const DARK_QUERY = "(prefers-color-scheme: dark)";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const REDUCED_TRANSPARENCY_QUERY = "(prefers-reduced-transparency: reduce)";
const MORE_CONTRAST_QUERY = "(prefers-contrast: more)";

function syncPlatformClass(): void {
  document.documentElement.classList.toggle("platform-mac", isMacPlatform());
}

if (typeof document !== "undefined") syncPlatformClass();

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
  const systemReducedTransparency = useMediaQuery(REDUCED_TRANSPARENCY_QUERY);
  const systemMoreContrast = useMediaQuery(MORE_CONTRAST_QUERY);
  const reduceMotion = reduceMotionSetting || systemReducedMotion;

  useNativeVibrancy(isDark);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
  }, [isDark]);

  useEffect(() => {
    syncPlatformClass();
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("reduce-motion", reduceMotion);
  }, [reduceMotion]);

  useEffect(() => {
    document.documentElement.classList.toggle("reduce-transparency", systemReducedTransparency);
  }, [systemReducedTransparency]);

  useEffect(() => {
    document.documentElement.classList.toggle("increase-contrast", systemMoreContrast);
  }, [systemMoreContrast]);

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
