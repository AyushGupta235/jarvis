import { describe, expect, it } from 'vitest';
import { synthesize } from '../src/main/synth';

describe('synthesize', () => {
  const peak = (b: Buffer) => { let m = 0; for (let i = 44; i < b.length; i += 2) m = Math.max(m, Math.abs(b.readInt16LE(i))); return m / 32767; };
  it('makes a valid mono 16-bit WAV that is audible but not clipped', () => {
    for (const kind of ['done', 'needs'] as const) {
      const w = synthesize(kind);
      expect(w.toString('ascii', 0, 4)).toBe('RIFF');
      expect(w.toString('ascii', 8, 16)).toBe('WAVEfmt ');
      expect(w.readUInt16LE(22)).toBe(1);
      expect(w.readUInt16LE(34)).toBe(16);
      expect(w.readUInt32LE(40)).toBe(w.length - 44);
      const p = peak(w);
      expect(p).toBeGreaterThan(0.2);
      expect(p).toBeLessThan(0.99);
      expect(w.length / 2 / 44100).toBeGreaterThan(0.5);
      expect(w.length / 2 / 44100).toBeLessThan(1.5);
    }
  });
  it('gives the two events different sounds', () => {
    expect(synthesize('done').equals(synthesize('needs'))).toBe(false);
  });
});
