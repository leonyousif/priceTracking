import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

let dbInstance: Database.Database | null = null;

export function resolveDatabasePath(override = process.env.SQLITE_DB_PATH): string {
  const configured = override?.trim();
  if (configured) return path.resolve(configured);
  return path.join(process.cwd(), 'data', 'marketplace.db');
}

/** Open a database connection with standard production pragmas. */
export function openDatabaseConnection(dbPath = resolveDatabasePath()): Database.Database {
  const dataDir = path.dirname(dbPath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

// Append consecutive versions; never change a released migration or the v1 SQL.
const migrations = [
  {
    version: 1,
    up(db: Database.Database) {
      const hadFts = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'listingsFts'").get();
      db.exec(fs.readFileSync(path.join(process.cwd(), 'lib', 'schema.sql'), 'utf8'));
      // A newly created external-content FTS table must index existing listings.
      if (!hadFts) db.exec("INSERT INTO listingsFts(listingsFts) VALUES ('rebuild')");
    },
  },
  {
    version: 2,
    up(db: Database.Database) {
      // Adopt both pre-postage databases and unversioned databases with these columns.
      for (const table of ['listings', 'dealsLog']) {
        const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
        for (const column of ['postage', 'estimatedDeliveredCost']) {
          if (!columns.some(existing => existing.name === column)) {
            db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} REAL`);
          }
        }
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_listings_delivered_cost
        ON listings(searchId, isSold, isActive, estimatedDeliveredCost)`);
    },
  },
  {
    version: 3,
    up(db: Database.Database) {
      // 1. Create explicit searchListings association table
      db.exec(`
        CREATE TABLE IF NOT EXISTS searchListings (\n          searchId INTEGER NOT NULL REFERENCES trackedSearches(id) ON DELETE CASCADE,
          listingId INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
          firstSeenAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          lastSeenAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          PRIMARY KEY (searchId, listingId)
        );
        CREATE INDEX IF NOT EXISTS idx_search_listings_listing ON searchListings(listingId);
        CREATE INDEX IF NOT EXISTS idx_search_listings_search ON searchListings(searchId);
      `);

      // 2. Backfill recoverable legacy associations defensively
      const listingCols = (db.prepare('PRAGMA table_info(listings)').all() as { name: string }[]).map(c => c.name);
      const hasFirstSeen = listingCols.includes('firstSeenAt');
      const hasLastSeen = listingCols.includes('lastSeenAt');
      const firstSeenExpr = hasFirstSeen ? 'firstSeenAt' : "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
      const lastSeenExpr = hasLastSeen ? 'lastSeenAt' : "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

      db.exec(`
        INSERT OR IGNORE INTO searchListings (searchId, listingId, firstSeenAt, lastSeenAt)
        SELECT searchId, id, ${firstSeenExpr}, ${lastSeenExpr}
        FROM listings
        WHERE searchId IS NOT NULL;
      `);

      // From dealsLog (searchId, listingId) to recover contradictory legacy ownership records
      const dealCols = (db.prepare('PRAGMA table_info(dealsLog)').all() as { name: string }[]).map(c => c.name);
      const hasFlaggedAt = dealCols.includes('flaggedAt');
      const flaggedExpr = hasFlaggedAt ? 'flaggedAt' : "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

      db.exec(`
        INSERT OR IGNORE INTO searchListings (searchId, listingId, firstSeenAt, lastSeenAt)
        SELECT searchId, listingId, ${flaggedExpr}, ${flaggedExpr}
        FROM dealsLog
        WHERE searchId IS NOT NULL;
      `);

      // 3. Trigger to maintain searchListings for backward-compatible INSERT INTO listings(searchId, ...)
      const triggerFirst = hasFirstSeen ? 'new.firstSeenAt' : "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
      const triggerLast = hasLastSeen ? 'new.lastSeenAt' : "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS listings_ai_search
        AFTER INSERT ON listings
        WHEN new.searchId IS NOT NULL
        BEGIN
          INSERT OR IGNORE INTO searchListings (searchId, listingId, firstSeenAt, lastSeenAt)
          VALUES (new.searchId, new.id, ${triggerFirst}, ${triggerLast});
        END;
      `);

      // 4. Rebuild dealsLog to replace UNIQUE(listingId) with UNIQUE(searchId, listingId)
      // This allows independent searches observing the same listing to maintain their own deals and baselines.
      const selectFlagged = dealCols.includes('flaggedAt') ? 'flaggedAt' : "strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS flaggedAt";
      const selectPostage = dealCols.includes('postage') ? 'postage' : 'NULL AS postage';
      const selectDelivered = dealCols.includes('estimatedDeliveredCost') ? 'estimatedDeliveredCost' : 'NULL AS estimatedDeliveredCost';

      db.exec(`
        CREATE TABLE dealsLog_v3 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          listingId INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
          searchId INTEGER NOT NULL REFERENCES trackedSearches(id) ON DELETE CASCADE,
          listingPrice REAL NOT NULL,
          baselineMarketPrice REAL NOT NULL,
          discountPercentage REAL NOT NULL,
          dealType TEXT NOT NULL DEFAULT 'BELOW_MARKET',
          status TEXT NOT NULL DEFAULT 'ACTIVE',
          isActive INTEGER NOT NULL DEFAULT 1,
          flaggedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          postage REAL,
          estimatedDeliveredCost REAL,
          UNIQUE(searchId, listingId)
        );

        INSERT INTO dealsLog_v3 (
          id, listingId, searchId, listingPrice, baselineMarketPrice,
          discountPercentage, dealType, status, isActive, flaggedAt,
          postage, estimatedDeliveredCost
        )
        SELECT
          id, listingId, searchId, listingPrice, baselineMarketPrice,
          discountPercentage, dealType, status, isActive, ${selectFlagged},
          ${selectPostage}, ${selectDelivered}
        FROM dealsLog;

        DROP TABLE dealsLog;
        ALTER TABLE dealsLog_v3 RENAME TO dealsLog;

        CREATE INDEX IF NOT EXISTS idx_deals_discount ON dealsLog(discountPercentage DESC);
        CREATE INDEX IF NOT EXISTS idx_deals_active_discount ON dealsLog(isActive, discountPercentage DESC);
        CREATE INDEX IF NOT EXISTS idx_deals_search ON dealsLog(searchId);
        CREATE INDEX IF NOT EXISTS idx_deals_listing ON dealsLog(listingId);
      `);

      // 5. Verify foreign key constraints are completely intact
      const fkErrors = db.pragma('foreign_key_check') as unknown[];
      if (fkErrors.length > 0) {
        throw new Error(`Foreign key check failed after migration: ${JSON.stringify(fkErrors)}`);
      }
    },
  },
  {
    version: 4,
    up(db: Database.Database) {
      // 1. Add owner, lease, heartbeat and claim tracking columns to scrapeJobs
      const columns = (db.prepare('PRAGMA table_info(scrapeJobs)').all() as { name: string }[]).map((c) => c.name);
      for (const col of ['ownerId', 'claimedAt', 'heartbeatAt', 'leaseExpiresAt']) {
        if (!columns.includes(col)) {
          db.exec(`ALTER TABLE scrapeJobs ADD COLUMN ${col} TEXT`);
        }
      }

      // 2. Add performance index on status + id for pending queue lookups, and lease index for recovery
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_scrape_jobs_status ON scrapeJobs(status, id);
        CREATE INDEX IF NOT EXISTS idx_scrape_jobs_lease ON scrapeJobs(status, leaseExpiresAt);
      `);

      // 3. Recover any legacy running jobs without a lease
      db.exec(`
        UPDATE scrapeJobs
        SET status = 'pending',
            errorMessage = 'Recovered legacy running job during migration'
        WHERE status = 'running' AND leaseExpiresAt IS NULL;
      `);

      // 4. Verify foreign key constraints are completely intact
      const fkErrors = db.pragma('foreign_key_check') as unknown[];
      if (fkErrors.length > 0) {
        throw new Error(`Foreign key check failed after migration 4: ${JSON.stringify(fkErrors)}`);
      }
    },
  },
  {
    version: 5,
    up(db: Database.Database) {
      db.exec(`
        DROP TRIGGER listings_au;
        CREATE TRIGGER listings_au AFTER UPDATE OF title ON listings
        WHEN old.title IS NOT new.title BEGIN
          INSERT INTO listingsFts(listingsFts, rowid, title) VALUES('delete', old.id, old.title);
          INSERT INTO listingsFts(rowid, title) VALUES (new.id, new.title);
        END;
      `);
    },
  },
  {
    version: 6,
    up(db: Database.Database) {
      // The delivered-cost index covers the origin FK/prefix; deals are filtered by status.
      db.exec(`
        DROP INDEX idx_listings_search_sold;
        DROP INDEX idx_deals_active_discount;
        CREATE INDEX idx_deals_status_discount ON dealsLog(status, discountPercentage DESC, id DESC);
      `);
    },
  },
  {
    version: 7,
    up(db: Database.Database) {
      // A process owner is diagnostic; only a unique attempt with a live lease may write.
      db.exec('ALTER TABLE scrapeJobs ADD COLUMN attemptId TEXT');
    },
  },
];

/** Each migration and PRAGMA user_version commit together, including SQLite DDL. */
export function migrateDatabase(db: Database.Database): void {
  const latestVersion = migrations[migrations.length - 1].version;
  if (db.inTransaction) throw new Error('Database upgrades require their own transaction');
  for (const migration of migrations) {
    db.transaction(() => {
      // Recheck under a write lock: another initializer may have already upgraded.
      const version = db.pragma('user_version', { simple: true }) as number;
      if (version > latestVersion) {
        throw new Error(`Database version ${version} is newer than supported version ${latestVersion}`);
      }
      if (version >= migration.version) return;
      if (version !== migration.version - 1) throw new Error(`Missing migration after version ${version}`);
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    }).immediate();
  }
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

export function getDb(): Database.Database {
  if (!dbInstance) {
    const db = openDatabaseConnection();
    try {
      migrateDatabase(db);
      dbInstance = db;
    } catch (error) {
      db.close();
      throw error;
    }
  }
  return dbInstance;
}
