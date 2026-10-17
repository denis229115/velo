export interface FuzzyHit {
  score: number;
  /** [start, end) slices of `text` that matched. */
  ranges: Array<[number, number]>;
}

/**
 * Subsequence match with a bonus when the query is a substring or starts a word.
 * Returns null when the query is not contained in order.
 */
export function fuzzyMatch(text: string, query: string): FuzzyHit | null {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 1, ranges: [] };
  const lower = text.toLowerCase();
  const at = lower.indexOf(q);
  if (at >= 0) {
    const wordStart = at === 0 || /\s/.test(text[at - 1] ?? "");
    return { score: (wordStart ? 200 : 120) - at, ranges: [[at, at + q.length]] };
  }

  const indexes: number[] = [];
  let qi = 0;
  for (let i = 0; i < lower.length && qi < q.length; i++) {
    if (lower[i] === q[qi]) {
      indexes.push(i);
      qi += 1;
    }
  }
  if (qi < q.length || indexes.length === 0) return null;

  const ranges: Array<[number, number]> = [];
  let start = indexes[0]!;
  let prev = start;
  let score = 0;
  for (const index of indexes) {
    if (index === 0 || /\s/.test(text[index - 1] ?? "")) score += 4;
    else score += 1;
  }
  for (let k = 1; k < indexes.length; k++) {
    const index = indexes[k]!;
    if (index === prev + 1) {
      prev = index;
      score += 2;
    } else {
      ranges.push([start, prev + 1]);
      start = prev = index;
    }
  }
  ranges.push([start, prev + 1]);
  return { score, ranges };
}

export function commandRank(label: string, category: string, query: string, recencyIndex: number): number {
  const labelHit = fuzzyMatch(label, query);
  const categoryHit = fuzzyMatch(category, query);
  const best = Math.max(labelHit?.score ?? 0, categoryHit?.score ?? 0);
  if (best <= 0) return 0;
  const boost = recencyIndex >= 0 ? 40 - recencyIndex : 0;
  return best + boost;
}
