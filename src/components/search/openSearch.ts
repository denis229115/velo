/** Opens the command palette, which also searches mail. */
export function openSearch() {
  window.dispatchEvent(new Event("velo-toggle-command-palette"));
}
