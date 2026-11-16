/**
 * Capability tiers (P4-S4), from the device memory the browser reports
 * (`navigator.deviceMemory`, in GiB, rounded and capped at 8 by Chromium; absent in Firefox and
 * Safari). The tier sets how many results each source returns and whether recent result sets
 * are cached on the device.
 */

export type TierName = 'lite' | 'standard' | 'full';

export interface Tier {
  name: TierName;
  /** Results requested from each source per search. */
  perSource: number;
  /** Result sets kept in the OPFS cache; 0 turns the cache off. */
  cacheEntries: number;
}

export const TIERS: Readonly<Record<TierName, Tier>> = {
  lite: { name: 'lite', perSource: 5, cacheEntries: 0 },
  standard: { name: 'standard', perSource: 10, cacheEntries: 20 },
  full: { name: 'full', perSource: 20, cacheEntries: 50 },
};

/** The tier for `memoryGiB`; a browser that does not say gets the middle one. */
export function tierFor(memoryGiB: number | undefined): Tier {
  if (memoryGiB === undefined || !Number.isFinite(memoryGiB) || memoryGiB <= 0) {
    return TIERS.standard;
  }
  if (memoryGiB < 2) return TIERS.lite;
  if (memoryGiB < 8) return TIERS.standard;
  return TIERS.full;
}
