/**
 * npm run db:init             # Create or upgrade without deleting data
 * npm run db:init -- --reset  # Deliberately drop application data, then initialize
 */

import { closeDb, getDb, openDatabaseConnection } from '../lib/db';

/** Destructive behavior is CLI-only and never part of a migration. */
function resetDatabase(): void {
  const db = openDatabaseConnection();
  try {
    console.log('--reset flag provided: Dropping existing tables and triggers...');
    db.transaction(() => {
      db.exec(`
        DROP TRIGGER IF EXISTS listings_ai_search;
        DROP TRIGGER IF EXISTS listings_ai;
        DROP TRIGGER IF EXISTS listings_ad;
        DROP TRIGGER IF EXISTS listings_au;
        DROP TABLE IF EXISTS listingsFts;
        DROP TABLE IF EXISTS searchListings;
        DROP TABLE IF EXISTS dealsLog;
        DROP TABLE IF EXISTS priceHistory;
        DROP TABLE IF EXISTS scrapeJobs;
        DROP TABLE IF EXISTS listings;
        DROP TABLE IF EXISTS trackedSearches;
      `);
      db.pragma('user_version = 0');
    }).immediate();
  } finally { db.close(); }
}

try {
  if (process.argv.includes('--reset')) resetDatabase();
  const db = getDb();
  console.log(`\nInitializing SQLite Database at: ${db.name}`);

  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type IN ('table', 'shadow') AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all() as { name: string }[];
  const triggers = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name"
  ).all() as { name: string }[];
  const indexes = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all() as { name: string }[];

  console.log('\n--- Database Verification ---');
  console.log('Tables:', tables.map(table => table.name).join(', '));
  console.log('Triggers:', triggers.map(trigger => trigger.name).join(', '));
  console.log('Indexes:', indexes.map(index => index.name).join(', '));
  console.log('Journal Mode:', String(db.pragma('journal_mode', { simple: true })).toUpperCase());
  console.log('Foreign Keys:', db.pragma('foreign_keys', { simple: true }) === 1 ? 'ON' : 'OFF');
  console.log('Synchronous:', db.pragma('synchronous', { simple: true }) === 1 ? 'NORMAL' : 'OTHER');
  console.log('User Version:', db.pragma('user_version', { simple: true }));

  console.log('\nDatabase initialization and verification completed successfully.\n');
} catch (error) {
  console.error('\nDatabase initialization failed:', error);
  process.exit(1);
} finally {
  closeDb();
}
