/** While an inline diff is waiting, ⌘↵ accepts it instead of sending the draft. */
let claim: (() => void) | null = null;

export function claimComposerEnter(handler: () => void): () => void {
  claim = handler;
  return () => {
    if (claim === handler) claim = null;
  };
}

export function takeComposerEnter(): boolean {
  if (!claim) return false;
  claim();
  return true;
}
