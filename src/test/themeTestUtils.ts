import themeCss from "@/styles/theme.css?raw";

/** Loads the real theme stylesheet into jsdom so computed styles reflect it. */
export function injectThemeCss(): void {
  if (document.getElementById("theme-css-under-test")) return;
  const style = document.createElement("style");
  style.id = "theme-css-under-test";
  style.textContent = themeCss;
  document.head.appendChild(style);
}

/** Reads a theme token as the screen would resolve it on <html>. */
export function readToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
}

interface MediaState {
  dark: boolean;
  reducedMotion: boolean;
}

/** Controllable window.matchMedia that mimics the OS appearance settings. */
export function mockSystemPreferences(initial: Partial<MediaState> = {}) {
  const state: MediaState = { dark: false, reducedMotion: false, ...initial };
  const listeners = new Map<string, Set<() => void>>();

  const matches = (query: string) => {
    if (query.includes("prefers-color-scheme: dark")) return state.dark;
    if (query.includes("prefers-reduced-motion: reduce")) return state.reducedMotion;
    return false;
  };

  window.matchMedia = ((query: string) => {
    const set = listeners.get(query) ?? new Set();
    listeners.set(query, set);
    return {
      get matches() {
        return matches(query);
      },
      media: query,
      onchange: null,
      addEventListener: (_: string, cb: () => void) => set.add(cb),
      removeEventListener: (_: string, cb: () => void) => set.delete(cb),
      addListener: (cb: () => void) => set.add(cb),
      removeListener: (cb: () => void) => set.delete(cb),
      dispatchEvent: () => true,
    };
  }) as unknown as typeof window.matchMedia;

  return {
    set(next: Partial<MediaState>) {
      Object.assign(state, next);
      for (const set of listeners.values()) for (const cb of set) cb();
    },
  };
}

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function parseColor(value: string): Rgba {
  const v = value.trim().toLowerCase();
  const hex = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (hex?.[1]) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: 1,
    };
  }
  const fn = v.match(/^rgba?\(([^)]+)\)$/);
  if (fn?.[1]) {
    const [r = 0, g = 0, b = 0, a = 1] = fn[1].split(",").map((p) => parseFloat(p));
    return { r, g, b, a };
  }
  throw new Error(`Unparseable colour: "${value}"`);
}

function composite(top: Rgba, bottom: Rgba): Rgba {
  return {
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1,
  };
}

function luminance({ r, g, b }: Rgba): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2 relative luminance of a colour (composited over `backdrop` if translucent). */
export function relativeLuminance(color: string, backdrop = "#ffffff"): number {
  return luminance(composite(parseColor(color), parseColor(backdrop)));
}

/** WCAG 2 contrast ratio; translucent layers are composited bottom-up over `backdrop`. */
export function contrastRatio(fg: string, bg: string, backdrop = "#ffffff"): number {
  const bgSolid = composite(parseColor(bg), parseColor(backdrop));
  const fgSolid = composite(parseColor(fg), bgSolid);
  const [hi, lo] = [luminance(fgSolid), luminance(bgSolid)].sort((a, b) => b - a) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The value a property is declared with for an element, from the last matching
 * stylesheet rule. For properties whose var() values jsdom cannot compute
 * (margins, border colours); rules are taken in source order.
 */
export function declaredStyle(el: Element, property: string): string {
  let value = "";
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules)) {
      if (rule instanceof CSSStyleRule && el.matches(rule.selectorText)) {
        const v = rule.style.getPropertyValue(property);
        if (v) value = v.trim();
      }
    }
  }
  return value;
}
