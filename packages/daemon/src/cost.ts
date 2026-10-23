/**
 * What one turn cost, from the SDK's running totals. `total_cost_usd` on a result is the cost of the whole conversation
 * so far (carried across restarts, reset by /clear), not of that turn, so a turn's cost is the step from the last total.
 * `resumed`: this host picked a conversation up from its transcript, so its first total includes earlier turns and the
 * step is unknown unless the previous total was remembered.
 */
export function turnCost(total: number | null | undefined, last: number | null, resumed: boolean): number | null {
  if (total == null) return null;
  if (last == null) return resumed ? null : total;
  if (total >= last) return total - last;
  return total; // the total fell: /clear started the count over
}
