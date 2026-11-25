// Pure helper for the public bag counter. No Deno or Node specific APIs.

export const TARGET_BAGS = 600;
export const BAG_PENCE = 4000; // £40 sponsors one winter bag

/** One bag for every full £40 of each paid one-off gift. Monthly gifts are not counted. */
export function bagsFromPence(amounts: number[]): number {
  let bags = 0;
  for (const p of amounts) {
    if (Number.isFinite(p) && p >= BAG_PENCE) bags += Math.floor(p / BAG_PENCE);
  }
  return bags;
}

export function buildCountResponse(amounts: number[]): { sponsored: number; target: number } {
  return { sponsored: bagsFromPence(amounts), target: TARGET_BAGS };
}
