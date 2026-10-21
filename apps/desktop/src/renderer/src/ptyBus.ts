/**
 * Routes PTY output to terminal views by pty id. Output that arrives before a view has registered
 * (the open() reply and the first data frame can race) is buffered and replayed.
 */
type DataCb = (data: string) => void;
type ExitCb = (code: number) => void;

const dataCbs = new Map<number, DataCb>();
const exitCbs = new Map<number, ExitCb>();
const early = new Map<number, string[]>();
const earlyExit = new Map<number, number>();

window.jarvis.onPtyData((id, data) => {
  const cb = dataCbs.get(id);
  if (cb) cb(data);
  else early.set(id, [...(early.get(id) ?? []), data]);
});

window.jarvis.onPtyExit((id, code) => {
  const cb = exitCbs.get(id);
  if (cb) cb(code);
  else earlyExit.set(id, code);
});

export function subscribePty(id: number, onData: DataCb, onExit: ExitCb): () => void {
  dataCbs.set(id, onData);
  exitCbs.set(id, onExit);
  for (const d of early.get(id) ?? []) onData(d);
  early.delete(id);
  const code = earlyExit.get(id);
  if (code !== undefined) {
    earlyExit.delete(id);
    onExit(code);
  }
  return () => {
    dataCbs.delete(id);
    exitCbs.delete(id);
  };
}
