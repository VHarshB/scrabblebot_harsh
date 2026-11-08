export function mayBid(
  seen: Set<string>,
  key: string,
  status: string,
  deadlineMicros: bigint,
  now = Date.now(),
): boolean {
  return (
    !seen.has(key) &&
    status === "Open" &&
    deadlineMicros > BigInt(now + 50) * 1000n
  );
}
export function reconnectDelay(attempt: number): number {
  return Math.min(30000, 1000 * 2 ** Math.min(10, Math.max(0, attempt)));
}
export function tournamentId(value: string | undefined): bigint | undefined {
  if (!value) return undefined;
  if (!/^[1-9][0-9]*$/.test(value))
    throw new Error("TOURNAMENT_ID must be a positive integer");
  return BigInt(value);
}
export function mayPractice(
  entries: { status: string; eliminated: boolean }[],
): boolean {
  return !entries.some(
    (e) => !e.eliminated && ["Swiss", "Bracket", "Final"].includes(e.status),
  );
}
