/**
 * Data Ingestion & Upsert Pipeline
 * Handles deduplication, price fluctuation detection, price history tracking,
 * and deal detection trigger inside atomic SQLite transactions.
 */

import { getDb } from '../lib/db';
import { RawScrapedItem, IngestionResult } from '../lib/types';
import { compileProductMatchPolicy } from './product-matcher';
import { detectDealsForSearch } from './anomaly';
import { calculateDeliveredCost } from './pricing';

export interface ReconciliationResult {
  searchId: number;
  delistedListings: number;
  delistedDeals: number;
}

export interface VerifiedEndedListing {
  externalId: string;
  evidence: 'ended-item-page';
}

/**
 * Delists only listings whose individual item pages were verified as ended.
 * Missing from a search page is never sufficient evidence.
 */
export function reconcileListings(
  searchId: number,
  verifiedEndedListings: VerifiedEndedListing[],
  platform = 'ebay'
): ReconciliationResult {
  const db = getDb();

  const reconcileTx = db.transaction(() => {
    const endedIds = new Set(verifiedEndedListings
      .filter((listing) => listing.evidence === 'ended-item-page')
      .map((listing) => listing.externalId));
    if (endedIds.size === 0) {
      return { delistedListings: 0, delistedDeals: 0 };
    }

    // Resolve only positively verified IDs, under both platform and search association.
    const findActive = db.prepare(`
      SELECT l.id FROM listings l
      WHERE l.platform = ? AND l.externalId = ? AND l.isSold = 0 AND l.isActive = 1
        AND EXISTS (SELECT 1 FROM searchListings sl WHERE sl.searchId = ? AND sl.listingId = l.id)
    `);
    const markInactiveStmt = db.prepare(`
      UPDATE listings
      SET isActive = 0,
          lastSeenAt = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      WHERE id = ? AND isSold = 0 AND isActive = 1
    `);

    // Activity is global, so verified ended evidence delists deals in all associated searches.
    const markDealDelistedStmt = db.prepare(`
      UPDATE dealsLog
      SET status = 'DELISTED',
          isActive = 0
      WHERE listingId = ? AND status = 'ACTIVE'
    `);

    let delistedDeals = 0;
    let delistedListings = 0;
    for (const externalId of endedIds) {
      const listing = findActive.get(platform, externalId, searchId) as { id: number } | undefined;
      if (!listing || markInactiveStmt.run(listing.id).changes === 0) continue;
      delistedListings++;
      const res = markDealDelistedStmt.run(listing.id);
      delistedDeals += res.changes;
    }

    return {
      delistedListings,
      delistedDeals,
    };
  });

  const res = reconcileTx();

  return {
    searchId,
    delistedListings: res.delistedListings,
    delistedDeals: res.delistedDeals,
  };
}

export function ingestScrapedListings(
  searchId: number,
  rawItems: RawScrapedItem[]
): IngestionResult {
  const db = getDb();

  // Policy reads, observations and derived deals share one database snapshot.
  const processBatch = db.transaction(() => {
    const searchRow = db
      .prepare(`SELECT query, category, negativeKeywords FROM trackedSearches WHERE id = ?`)
      .get(searchId) as { query: string; category: string; negativeKeywords: string | null } | undefined;

    let filteredOutliers = 0;
    const validItems: RawScrapedItem[] = [];

    const match = compileProductMatchPolicy({
      query: searchRow?.query || '', category: searchRow?.category || '',
      negativeKeywords: searchRow?.negativeKeywords ?? null,
    });
    for (const item of rawItems) {
      const check = match(item.title);
      if (!check.isMatch) {
        filteredOutliers++;
      } else {
        validItems.push(item);
      }
    }

    let newItems = 0;
    let updatedItems = 0;
    let priceChanges = 0;

    const findExisting = db.prepare(`
      SELECT id, currentPrice, isSold, isActive
      FROM listings
      WHERE platform = ? AND externalId = ?
    `);

    const insertListing = db.prepare(`
      INSERT INTO listings (
        searchId, platform, externalId, title, currentPrice,
        currency, url, imageUrl, location, sellerName, isSold, isActive,
        postage, estimatedDeliveredCost
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `);

    const updateListing = db.prepare(`
      UPDATE listings
      SET title = ?,
          currentPrice = ?,
          currency = ?,
          url = ?,
          imageUrl = COALESCE(?, imageUrl),
          location = COALESCE(?, location),
          sellerName = COALESCE(?, sellerName),
          isSold = ?,
          isActive = 1,
          postage = ?,
          estimatedDeliveredCost = ?,
          lastSeenAt = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      WHERE id = ?
    `);

    const upsertSearchListing = db.prepare(`
      INSERT INTO searchListings (searchId, listingId, firstSeenAt, lastSeenAt)
      VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT(searchId, listingId) DO UPDATE SET
        lastSeenAt = excluded.lastSeenAt
    `);

    const insertPriceHistory = db.prepare(`
      INSERT INTO priceHistory (listingId, price)
      VALUES (?, ?)
    `);
    // Sold availability is global; baseline and discount values remain search-specific.
    const retireSoldDeals = db.prepare(`UPDATE dealsLog SET status = 'SOLD', isActive = 0
      WHERE listingId = ? AND status = 'ACTIVE'`);

    for (const item of validItems) {
      const existing = findExisting.get(item.platform, item.externalId) as
        | { id: number; currentPrice: number; isSold: number; isActive: number }
        | undefined;

      const isSoldInt = item.isSold ? 1 : 0;
      const itemPostage = item.postage !== undefined ? item.postage : null;
      const deliveredCost =
        item.estimatedDeliveredCost !== undefined
          ? item.estimatedDeliveredCost
          : calculateDeliveredCost(item.currentPrice, itemPostage);

      if (!existing) {
        // Brand new listing
        const res = insertListing.run(
          searchId,
          item.platform,
          item.externalId,
          item.title,
          item.currentPrice,
          item.currency,
          item.url,
          item.imageUrl ?? null,
          item.location ?? null,
          item.sellerName ?? null,
          isSoldInt,
          itemPostage,
          deliveredCost
        );
        const listingId = Number(res.lastInsertRowid);

        upsertSearchListing.run(searchId, listingId);
        insertPriceHistory.run(listingId, item.currentPrice);
        newItems++;
      } else {
        // Existing listing: check if price has changed
        if (existing.currentPrice !== item.currentPrice) {
          insertPriceHistory.run(existing.id, item.currentPrice);
          priceChanges++;
        }

        // Update listing metadata and lastSeenAt without overwriting origin searchId
        updateListing.run(
          item.title,
          item.currentPrice,
          item.currency,
          item.url,
          item.imageUrl ?? null,
          item.location ?? null,
          item.sellerName ?? null,
          isSoldInt,
          itemPostage,
          deliveredCost,
          existing.id
        );
        upsertSearchListing.run(searchId, existing.id);
        if (item.isSold) retireSoldDeals.run(existing.id);
        updatedItems++;
      }
    }

    // Update tracked search lastScrapedAt timestamp
    db.prepare(
      `UPDATE trackedSearches
       SET lastScrapedAt = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
           updatedAt = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       WHERE id = ?`
    ).run(searchId);

    // Detection uses the updated baseline; its nested transaction is a savepoint.
    const dealSummary = detectDealsForSearch(searchId, match);

    return {
      totalItems: rawItems.length,
      newItems,
      updatedItems,
      priceChanges,
      filteredOutliers,
      activeDealsFound: dealSummary.activeDeals,
    };
  });

  // Reserve the writer before reading policy/baseline data; no browser or network work runs here.
  return processBatch.immediate();
}
