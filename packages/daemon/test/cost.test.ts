import { describe, expect, it } from 'vitest';
import { turnCost } from '../src/cost';

describe('turnCost', () => {
  it('is the step between the conversation\'s running totals, not the total itself', () => {
    expect(turnCost(46.08, 45.5, false)).toBeCloseTo(0.58, 10);
    expect(turnCost(0.2, null, false)).toBe(0.2); // the first turn of a new conversation
  });
  it('does not price the first turn after a restart unless the earlier total was remembered', () => {
    expect(turnCost(46.08, null, true)).toBeNull();
    expect(turnCost(46.5, 46.08, true)).toBeCloseTo(0.42, 10);
  });
  it('starts over when /clear resets the total, and ignores a missing total', () => {
    expect(turnCost(0.1, 46.08, false)).toBe(0.1);
    expect(turnCost(null, 5, false)).toBeNull();
    expect(turnCost(undefined, null, true)).toBeNull();
  });
});
