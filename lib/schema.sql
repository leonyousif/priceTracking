-- Immutable migration v1: pre-postage baseline for Deal Sniper & Price Anomaly Detector.
-- Add future schema changes as ordered migrations in lib/db.ts, not to this file.
-- Connection pragmas are configured before migrations by openDatabaseConnection().

-- Tracked Searches
CREATE TABLE IF NOT EXISTS trackedSearches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query TEXT NOT NULL,
  category TEXT NOT NULL,
  negativeKeywords TEXT,
  isActive INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updatedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  lastScrapedAt TEXT
);

-- Listings
CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  searchId INTEGER NOT NULL REFERENCES trackedSearches(id),
  platform TEXT NOT NULL DEFAULT 'ebay',
  externalId TEXT NOT NULL,
  title TEXT NOT NULL,
  currentPrice REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'AUD',
  url TEXT NOT NULL,
  imageUrl TEXT,
  location TEXT,
  sellerName TEXT,
  isSold INTEGER NOT NULL DEFAULT 0,
  isActive INTEGER NOT NULL DEFAULT 1,
  firstSeenAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  lastSeenAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(platform, externalId)
);

-- Price History
CREATE TABLE IF NOT EXISTS priceHistory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listingId INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  price REAL NOT NULL,
  recordedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 4. Flagged Deals Log
CREATE TABLE IF NOT EXISTS dealsLog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listingId INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  searchId INTEGER NOT NULL REFERENCES trackedSearches(id),
  listingPrice REAL NOT NULL,
  baselineMarketPrice REAL NOT NULL,
  discountPercentage REAL NOT NULL,
  dealType TEXT NOT NULL DEFAULT 'BELOW_MARKET',
  status TEXT NOT NULL DEFAULT 'ACTIVE', -- 'ACTIVE', 'SOLD', 'EXPIRED', 'DELISTED'
  isActive INTEGER NOT NULL DEFAULT 1,
  flaggedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(listingId)
);

-- Scraping Background Jobs
CREATE TABLE IF NOT EXISTS scrapeJobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  searchId INTEGER REFERENCES trackedSearches(id),
  status TEXT NOT NULL,
  itemsScraped INTEGER NOT NULL DEFAULT 0,
  dealsFound INTEGER NOT NULL DEFAULT 0,
  errorMessage TEXT,
  startedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completedAt TEXT
);

-- FTS5 Virtual Table for Fast Title Search
CREATE VIRTUAL TABLE IF NOT EXISTS listingsFts USING fts5(
  title,
  content='listings',
  content_rowid='id'
);

-- FTS5 Sync Triggers
CREATE TRIGGER IF NOT EXISTS listings_ai AFTER INSERT ON listings BEGIN
  INSERT INTO listingsFts(rowid, title) VALUES (new.id, new.title);
END;

CREATE TRIGGER IF NOT EXISTS listings_ad AFTER DELETE ON listings BEGIN
  INSERT INTO listingsFts(listingsFts, rowid, title) VALUES('delete', old.id, old.title);
END;

CREATE TRIGGER IF NOT EXISTS listings_au AFTER UPDATE ON listings BEGIN
  INSERT INTO listingsFts(listingsFts, rowid, title) VALUES('delete', old.id, old.title);
  INSERT INTO listingsFts(rowid, title) VALUES (new.id, new.title);
END;

-- Performance Indexes
CREATE INDEX IF NOT EXISTS idx_listings_search_sold ON listings(searchId, isSold, isActive);
CREATE INDEX IF NOT EXISTS idx_listings_price ON listings(currentPrice);
CREATE INDEX IF NOT EXISTS idx_price_history_listing ON priceHistory(listingId, recordedAt);
CREATE INDEX IF NOT EXISTS idx_deals_discount ON dealsLog(discountPercentage DESC);
CREATE INDEX IF NOT EXISTS idx_deals_active_discount ON dealsLog(isActive, discountPercentage DESC);
CREATE INDEX IF NOT EXISTS idx_deals_search ON dealsLog(searchId);
CREATE INDEX IF NOT EXISTS idx_scrape_jobs_search ON scrapeJobs(searchId);
