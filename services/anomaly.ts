/**
 * Price Anomaly & Deal Detection Service
 * Evaluates listings against statistical baselines to identify genuine bargains.
 */

import { getDb } from '../lib/db';
import { calculateDeliveredCost } from './pricing';
import { compileProductMatchPolicy, ProductMatchPolicy } from './product-matcher';

export interface MarketBaseline {
  baselinePrice: number;
  sampleCount: number;
  source: 'sold' | 'active';
}

export interface DealDetectionSummary {
  searchId: number;
  baseline: MarketBaseline | null;
  activeDeals: number;
  expiredDeals: number;
  soldDeals: number;
  delistedDeals: number;
}

const MIN_BASELINE_COMPARABLES = 3;
const MIN_DEAL_DISCOUNT_PERCENT = 25; // 25% below market baseline
const MAX_DEAL_DISCOUNT_PERCENT = 85; // Discard suspicious extreme anomalies (>85% off)

/**
 * Calculates a statistical price baseline for a tracked search.
 * Strictly filters out any listings that do not match the tracked product.
 * Prefers sold listings (LH_Sold=1) as historical ground truth.
 * Falls back to active listings if sold listings have too few complete prices.
 */
export function calculateSearchBaseline(searchId: number, compiledMatch?: ProductMatchPolicy | null): MarketBaseline | null {
  const db = getDb();

  const searchRow = db
    .prepare(`SELECT query, category, negativeKeywords FROM trackedSearches WHERE id = ?`)
    .get(searchId) as { query: string; category: string; negativeKeywords: string | null } | undefined;
  const match = compiledMatch === undefined
    ? searchRow ? compileProductMatchPolicy(searchRow) : null
    : compiledMatch;

  const comparable = (isSold: 0 | 1, source: MarketBaseline['source']): MarketBaseline | null => {
    const rows = db.prepare(`
      SELECT l.currentPrice, l.postage, l.title
      FROM listings l
      JOIN searchListings sl ON l.id = sl.listingId
      WHERE sl.searchId = ? AND l.isSold = ? AND l.isActive = 1
    `).all(searchId, isSold) as { currentPrice: number; postage: number | null; title: string }[];
    const delivered = rows
      .filter((row) => !match || match(row.title).isMatch)
      .map((row) => Number.isFinite(row.currentPrice) && Number.isFinite(row.postage)
        ? calculateDeliveredCost(row.currentPrice, row.postage) : null)
      .filter((cost): cost is number => cost !== null && cost > 0)
      .sort((a, b) => a - b);
    return delivered.length >= MIN_BASELINE_COMPARABLES
      ? { baselinePrice: calculateExactMedian(delivered), sampleCount: delivered.length, source }
      : null;
  };

  return comparable(1, 'sold') ?? comparable(0, 'active');
}

/**
 * Evaluates all listings for a tracked search against the calculated baseline,
 * inserting or updating deals in dealsLog with appropriate lifecycle statuses.
 * Deal comparisons use the buyer's estimated delivered cost (including postage).
 * Listings with incomplete price (unknown postage / null delivered cost) are NEVER flagged as deals.
 */
export function detectDealsForSearch(searchId: number, compiledMatch?: ProductMatchPolicy): DealDetectionSummary {
  const db = getDb();
  // Standalone calls are atomic; ingestion calls nest as a savepoint on the same connection.
  return db.transaction(() => detectDealsInTransaction(searchId, compiledMatch)).immediate();
}

function detectDealsInTransaction(searchId: number, compiledMatch?: ProductMatchPolicy): DealDetectionSummary {
  const db = getDb();
  const searchRow = db
    .prepare(`SELECT query, category, negativeKeywords FROM trackedSearches WHERE id = ?`)
    .get(searchId) as { query: string; category: string; negativeKeywords: string | null } | undefined;
  const match = compiledMatch ?? (searchRow ? compileProductMatchPolicy(searchRow) : null);
  const baseline = calculateSearchBaseline(searchId, match);

  const summary: DealDetectionSummary = {
    searchId,
    baseline,
    activeDeals: 0,
    expiredDeals: 0,
    soldDeals: 0,
    delistedDeals: 0,
  };

  if (!baseline || baseline.baselinePrice <= 0) {
    const expired = db.prepare(`
      UPDATE dealsLog SET status = 'EXPIRED', isActive = 0
      WHERE searchId = ? AND status = 'ACTIVE'
    `).run(searchId);
    summary.expiredDeals = expired.changes;
    return summary;
  }

  // Fetch all listings for this search
  const listings = db
    .prepare(
      `SELECT l.id, l.title, l.currentPrice, l.postage, l.estimatedDeliveredCost, l.isSold, l.isActive
       FROM listings l
       JOIN searchListings sl ON l.id = sl.listingId
       WHERE sl.searchId = ?`
    )
    .all(searchId) as {
    id: number;
    title: string;
    currentPrice: number;
    postage: number | null;
    estimatedDeliveredCost: number | null;
    isSold: number;
    isActive: number;
  }[];

  const upsertDeal = db.prepare(`
    INSERT INTO dealsLog (
      listingId, searchId, listingPrice, postage, estimatedDeliveredCost,
      baselineMarketPrice, discountPercentage, dealType, status, isActive
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 'BELOW_MARKET', 'ACTIVE', 1)
    ON CONFLICT(searchId, listingId) DO UPDATE SET
      listingPrice = excluded.listingPrice,
      postage = excluded.postage,
      estimatedDeliveredCost = excluded.estimatedDeliveredCost,
      baselineMarketPrice = excluded.baselineMarketPrice,
      discountPercentage = excluded.discountPercentage,
      status = 'ACTIVE',
      isActive = 1,
      flaggedAt = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `);

  const updateDealStatus = db.prepare(`
    UPDATE dealsLog
    SET status = ?, isActive = 0
    WHERE searchId = ? AND listingId = ? AND status = 'ACTIVE'
  `);

  for (const item of listings) {
    // 0. Ensure listing strictly matches the tracked product
    if (match && !match(item.title).isMatch) {
      const res = updateDealStatus.run('DELISTED', searchId, item.id);
      if (res.changes > 0) summary.delistedDeals++;
      continue;
    }

    // 1. If listing is sold, mark any existing active deal as SOLD
    if (item.isSold === 1) {
      const res = updateDealStatus.run('SOLD', searchId, item.id);
      if (res.changes > 0) summary.soldDeals++;
      continue;
    }

    // 2. If listing is delisted / inactive, mark as DELISTED
    if (item.isActive === 0) {
      const res = updateDealStatus.run('DELISTED', searchId, item.id);
      if (res.changes > 0) summary.delistedDeals++;
      continue;
    }

    // 3. Delivered Cost & Incomplete Price Check:
    // "Do not flag a deal from an incomplete price."
    // If postage is unknown (null) or delivered cost is incomplete, DO NOT flag as a deal.
    const deliveredCost = Number.isFinite(item.currentPrice) && Number.isFinite(item.postage)
      ? calculateDeliveredCost(item.currentPrice, item.postage)
      : null;

    if (deliveredCost === null || Number.isNaN(deliveredCost) || deliveredCost <= 0) {
      // Incomplete price: expire deal if previously active
      const res = updateDealStatus.run('EXPIRED', searchId, item.id);
      if (res.changes > 0) summary.expiredDeals++;
      continue;
    }

    // 4. Active listing with complete price: Calculate discount based on buyer's delivered cost
    const discount =
      ((baseline.baselinePrice - deliveredCost) / baseline.baselinePrice) * 100;
    const roundedDiscount = Math.round(discount * 10) / 10;

    // Check if it qualifies as a valid deal (between 25% and 85% off)
    if (
      roundedDiscount >= MIN_DEAL_DISCOUNT_PERCENT &&
      roundedDiscount <= MAX_DEAL_DISCOUNT_PERCENT
    ) {
      upsertDeal.run(
        item.id,
        searchId,
        item.currentPrice,
        item.postage,
        deliveredCost,
        baseline.baselinePrice,
        roundedDiscount
      );
      summary.activeDeals++;
    } else {
      // If previously flagged as active deal, expire it
      const res = updateDealStatus.run('EXPIRED', searchId, item.id);
      if (res.changes > 0) summary.expiredDeals++;
    }
  }

  return summary;
}

/**
 * Pure helper function to calculate the exact mathematical median of sorted numbers.
 */
export function calculateExactMedian(sortedNumbers: number[]): number {
  if (sortedNumbers.length === 0) return 0;
  const mid = Math.floor(sortedNumbers.length / 2);
  if (sortedNumbers.length % 2 !== 0) {
    return sortedNumbers[mid];
  }
  return Math.round(((sortedNumbers[mid - 1] + sortedNumbers[mid]) / 2) * 100) / 100;
}
