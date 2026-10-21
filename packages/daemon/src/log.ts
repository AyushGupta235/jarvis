export function log(...args: unknown[]): void {
  const ts = new Date().toISOString();
  console.log(ts, ...args);
}
export function logError(...args: unknown[]): void {
  const ts = new Date().toISOString();
  console.error(ts, 'ERROR', ...args);
}
