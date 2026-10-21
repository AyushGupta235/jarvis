/** Subsequence match with bonuses for word starts and contiguous runs. Returns -1 for no match. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return 0;
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let run = 0;
  for (const ch of q) {
    const idx = t.indexOf(ch, ti);
    if (idx < 0) return -1;
    const prev = idx > 0 ? t[idx - 1] : ' ';
    const boundary = prev === undefined || /[\s/\-_.]/.test(prev);
    run = idx === ti ? run + 1 : 0;
    score += 1 + (boundary ? 3 : 0) + run * 2 - Math.min(idx - ti, 5) * 0.2;
    ti = idx + 1;
  }
  return score;
}

export function fuzzyFilter<T>(items: T[], query: string, key: (t: T) => string): T[] {
  if (!query.trim()) return items;
  return items
    .map((item, i) => ({ item, i, s: fuzzyScore(query, key(item)) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.item);
}
