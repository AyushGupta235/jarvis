import { closeSync, openSync, readSync, statSync } from 'node:fs';

/**
 * Reads complete lines appended to a file since `offset`. Returns the new offset (just past the last
 * complete line) so partial trailing lines are re-read next time.
 */
export function readNewLines(path: string, offset: number, maxBytes = 8 << 20): { lines: string[]; offset: number; size: number } {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { lines: [], offset, size: 0 };
  }
  if (size < offset) offset = 0; // file was rewritten
  if (size === offset) return { lines: [], offset, size };
  const len = Math.min(size - offset, maxBytes);
  const buf = Buffer.alloc(len);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, len, offset);
  } finally {
    closeSync(fd);
  }
  const lastNl = buf.lastIndexOf(10);
  if (lastNl < 0) {
    // One line longer than maxBytes: skip it rather than stall forever.
    return len === maxBytes ? { lines: [], offset: offset + len, size } : { lines: [], offset, size };
  }
  const text = buf.subarray(0, lastNl).toString('utf8');
  return { lines: text.split('\n'), offset: offset + lastNl + 1, size };
}
