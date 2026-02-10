export function nowIso(): string {
  return new Date().toISOString();
}

export function hrTimeMs(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}
