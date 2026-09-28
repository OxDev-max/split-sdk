/**
 * Creator performance metrics and statistics.
 *
 * Aggregates on-chain data and event history to provide a single
 * typed response with creator performance metrics.
 */

/** Creator statistics and performance metrics. */
export interface CreatorStats {
  /** Total number of invoices created. */
  totalInvoices: number;
  /** Total amount raised across all invoices. */
  totalRaised: bigint;
  /** Total amount released to recipients. */
  totalReleased: bigint;
  /** Total amount refunded to payers. */
  totalRefunded: bigint;
  /** Percentage of invoices that were fully paid and released (0-100). */
  successRate: number;
  /** Average time in hours from invoice creation to first payment. */
  averageFundingTimeHours: number;
  /** Number of unique payers. */
  uniquePayerCount: number;
  /** Average rating from recipients (0-5 scale, if available). */
  averageRating: number;
}

/** Internal cache entry for creator stats. */
interface CachedCreatorStats {
  stats: CreatorStats;
  timestamp: number;
}

const CACHE_TTL_MS = 60_000; // 60 seconds
const creatorStatsCache = new Map<string, CachedCreatorStats>();

export function getCreatorStatsCache(creator: string): CreatorStats | null {
  const cached = creatorStatsCache.get(creator);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.stats;
  }
  creatorStatsCache.delete(creator);
  return null;
}

export function setCreatorStatsCache(creator: string, stats: CreatorStats): void {
  creatorStatsCache.set(creator, { stats, timestamp: Date.now() });
}

export function clearCreatorStatsCache(): void {
  creatorStatsCache.clear();
}
