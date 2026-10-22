export type SoundKind = 'done' | 'needs';

interface Note {
  /** Hz */
  f: number;
  /** start, seconds */
  at: number;
  /** length, seconds */
  len: number;
  gain: number;
}

/**
 * Jarvis's own sounds, drawn as sample data so there is no asset to ship: a bright rising marimba arpeggio when an agent
 * finishes, and a lower double knock when it needs you. Each note is a struck bar: a few inharmonic partials that
 * die away at different speeds.
 */
const SOUNDS: Record<SoundKind, Note[]> = {
  done: [
    { f: 659.25, at: 0, len: 0.42, gain: 0.8 },
    { f: 880, at: 0.1, len: 0.46, gain: 0.8 },
    { f: 1318.5, at: 0.2, len: 0.7, gain: 0.9 },
  ],
  needs: [
    { f: 523.25, at: 0, len: 0.3, gain: 0.9 },
    { f: 523.25, at: 0.17, len: 0.3, gain: 0.9 },
    { f: 392, at: 0.38, len: 0.55, gain: 0.95 },
  ],
};

const RATE = 44100;

export function synthesize(kind: SoundKind): Buffer {
  const notes = SOUNDS[kind];
  const total = Math.max(...notes.map((n) => n.at + n.len)) + 0.1;
  const samples = new Float32Array(Math.ceil(total * RATE));
  for (const n of notes) {
    const start = Math.floor(n.at * RATE);
    const count = Math.floor(n.len * RATE);
    for (let i = 0; i < count && start + i < samples.length; i++) {
      const t = i / RATE;
      // Struck bar: fundamental plus partials at 2.76x and 5.40x that fade faster.
      const tone =
        Math.sin(2 * Math.PI * n.f * t) * Math.exp(-t * 7) +
        0.35 * Math.sin(2 * Math.PI * n.f * 2.76 * t) * Math.exp(-t * 14) +
        0.12 * Math.sin(2 * Math.PI * n.f * 5.4 * t) * Math.exp(-t * 28);
      const attack = Math.min(1, i / (0.004 * RATE));
      samples[start + i]! += tone * attack * n.gain * 0.45;
    }
  }
  const data = Buffer.alloc(44 + samples.length * 2);
  data.write('RIFF', 0);
  data.writeUInt32LE(36 + samples.length * 2, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(RATE, 24);
  data.writeUInt32LE(RATE * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32767), 44 + i * 2);
  return data;
}

