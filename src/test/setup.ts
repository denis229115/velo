import "@testing-library/jest-dom/vitest";

// jsdom has no matchMedia; default to "no OS preference" (light, motion allowed).
// Theme tests override it with mockSystemPreferences().
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
