/**
 * Quick Database Inspection Script
 * Prints current counts, tracked searches, recent listings, and active deals.
 */

import { getDb, closeDb } from '../lib/db';

function inspect(): void {
  const db = getDb();

  console.log('\n========================================');
  console.log('📊 Current SQLite Database Snapshot');
  console.log('========================================\n');

  // 1. Row counts across all tables
  const counts = {
    trackedSearches: (db.prepare('SELECT count(*) as c FROM trackedSearches').get() as { c: number }).c,
    listings: (db.prepare('SELECT count(*) as c FROM listings').get() as { c: number }).c,
    searchListings: (db.prepare('SELECT count(*) as c FROM searchListings').get() as { c: number }).c,
    priceHistory: (db.prepare('SELECT count(*) as c FROM priceHistory').get() as { c: number }).c,
    dealsLog: (db.prepare('SELECT count(*) as c FROM dealsLog').get() as { c: number }).c,
    activeDeals: (db.prepare('SELECT count(*) as c FROM dealsLog WHERE isActive = 1').get() as { c: number }).c,
    scrapeJobs: (db.prepare('SELECT count(*) as c FROM scrapeJobs').get() as { c: number }).c,
  };

  console.log('📈 Table Row Counts:');
  console.table(counts);

  // 2. Tracked searches
  const searches = db.prepare('SELECT id, query, category, isActive, lastScrapedAt FROM trackedSearches').all();
  console.log('\n🔍 Tracked Searches:');
  console.table(searches);

  // 3. Top active deals
  const deals = db.prepare(`
    SELECT 
      d.id,
      t.query as searchQuery,
      l.title,
      printf('$%.2f %s', l.currentPrice, l.currency) as currentPrice,
      printf('$%.2f', d.baselineMarketPrice) as marketBaseline,
      printf('%.1f%%', d.discountPercentage) as discount,
      d.status,
      l.url
    FROM dealsLog d
    JOIN listings l ON d.listingId = l.id
    JOIN trackedSearches t ON d.searchId = t.id
    WHERE d.isActive = 1
    ORDER BY d.discountPercentage DESC
    LIMIT 10
  `).all();

  console.log('\n🔥 Top 10 Active Deals Found from Live Scraping:');
  console.table(deals);

  closeDb();
  console.log('\n');
}

inspect();
