/**
 * Database Outlier & Dropdown Cleanup Script
 * Scans all existing listings in SQLite, evaluates them against the updated
 * outlier & multi-variation engine, deletes invalid items, and refreshes deals.
 */

import { getDb, closeDb } from '../lib/db';
import { compileProductMatchPolicy, ProductMatchPolicy } from '../services/product-matcher';
import { detectDealsForSearch } from '../services/anomaly';

function cleanup(): void {
  const db = getDb();

  console.log('\n🧹 Running Outlier & Multi-Variation Cleanup on Database...\n');

  const messages = db.transaction(() => {
  const messages: string[] = [];
  const listings = db.prepare(`
    SELECT sl.searchId, l.id as listingId, l.title, l.currentPrice, t.query, t.category, t.negativeKeywords
    FROM searchListings sl
    JOIN listings l ON sl.listingId = l.id
    JOIN trackedSearches t ON sl.searchId = t.id
  `).all() as Array<{
    searchId: number;
    listingId: number;
    title: string;
    currentPrice: number;
    query: string;
    category: string;
    negativeKeywords: string | null;
  }>;

  let removedCount = 0;
  const affectedSearches = new Set<number>();
  const policies = new Map<number, ProductMatchPolicy>();

  const deleteSearchListing = db.prepare(`DELETE FROM searchListings WHERE searchId = ? AND listingId = ?`);
  const deleteSearchDeal = db.prepare(`DELETE FROM dealsLog WHERE searchId = ? AND listingId = ?`);
  const deleteOrphanedListing = db.prepare(`
    DELETE FROM listings WHERE id = ? AND id NOT IN (SELECT listingId FROM searchListings)
  `);
  const deleteOrphanedHistory = db.prepare(`
    DELETE FROM priceHistory WHERE listingId = ? AND listingId NOT IN (SELECT listingId FROM searchListings)
  `);
  const reassignOriginSearch = db.prepare(`
    UPDATE listings
    SET searchId = (SELECT sl.searchId FROM searchListings sl WHERE sl.listingId = listings.id ORDER BY sl.searchId LIMIT 1)
    WHERE id = ? AND searchId = ?
      AND EXISTS (SELECT 1 FROM searchListings sl WHERE sl.listingId = listings.id)
  `);

  for (const item of listings) {
    let match = policies.get(item.searchId);
    if (!match) {
      match = compileProductMatchPolicy(item);
      policies.set(item.searchId, match);
    }
    const check = match(item.title);
    if (!check.isMatch) {
      messages.push(`❌ Removing non-matching listing [Search ${item.searchId}, Listing: ${item.listingId}]: "${item.title}" ($${item.currentPrice}) - Reason: ${check.reason} (${check.matchedPattern || ''})`);
      deleteSearchDeal.run(item.searchId, item.listingId);
      deleteSearchListing.run(item.searchId, item.listingId);
      deleteOrphanedHistory.run(item.listingId);
      deleteOrphanedListing.run(item.listingId);
      reassignOriginSearch.run(item.listingId, item.searchId);
      affectedSearches.add(item.searchId);
      removedCount++;
    }
  }

  messages.push(`\n✅ Removed ${removedCount} invalid outlier/dropdown search associations.`);

  // Refresh deals for affected searches
  for (const searchId of affectedSearches) {
    const summary = detectDealsForSearch(searchId);
    messages.push(`🔄 Refreshed Search ID ${searchId}: ${summary.activeDeals} active deals remaining.`);
  }
  return messages;
  }).immediate();
  messages.forEach(message => console.log(message));
}

try { cleanup(); }
catch (error) {
  console.error('Cleanup failed; transaction rolled back:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally { closeDb(); }
