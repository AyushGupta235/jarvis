import { describe, expect, it } from 'vitest';
import { fuzzyFilter, fuzzyScore } from '../src/renderer/src/fuzzy';

const base = '/var/folders/x/T/jarvis-e2e-abc/repos/';

describe('fuzzy', () => {
  it('ranks a name match far above a scattered path match', () => {
    const atlas = fuzzyScore('atlas', `atlas main ${base}atlas`);
    const borealis = fuzzyScore('atlas', `borealis main ${base}borealis`);
    expect(atlas).toBeGreaterThan(borealis * 3);
  });
  it('filters out non-matches and keeps order for an empty query', () => {
    const items = ['api-server', 'eval-harness', 'web-dashboard'];
    expect(fuzzyFilter(items, '', (x) => x)).toEqual(items);
    expect(fuzzyFilter(items, 'wd', (x) => x)).toEqual(['web-dashboard']);
    expect(fuzzyFilter(items, 'eh', (x) => x)[0]).toBe('eval-harness');
  });
});
