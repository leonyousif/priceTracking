/**
 * Standalone Scraper CLI Runner
 * Can be executed manually from terminal or scheduled via Windows Task Scheduler / cron.
 *
 * Usage:
 *   npx tsx scripts/scrape-cli.ts --all
 *   npx tsx scripts/scrape-cli.ts --search 1
 *   npx tsx scripts/scrape-cli.ts --query "RTX 3080" --category "GPU"
 *   npx tsx scripts/scrape-cli.ts --query "MacBook Pro" --category "Laptop" --head --pages 2
 */

import { getDb, closeDb } from '../lib/db';
import path from 'node:path';
import os from 'node:os';
import { createOwnedProfile, removeOwnedProfile } from '../lib/owned-profile';
import { EbayScraper } from '../services/scrapers/ebay';
import {
  BaseMarketplaceScraper,
  createScrapeResult,
  ScrapeResult,
  ScraperRunOptions,
} from '../services/scrapers/base';
import { runSearchWorkflow } from '../services/search-workflow';
import { TrackedSearch, Deal } from '../lib/types';

class CliMockScraper extends BaseMarketplaceScraper {
  readonly platform = 'ebay';
  private scenario: 'success' | 'empty' | 'blocked' | 'failed' | 'partial';

  constructor(scenario: 'success' | 'empty' | 'blocked' | 'failed' | 'partial') {
    super();
    this.scenario = scenario;
  }

  async scrape(options: ScraperRunOptions): Promise<ScrapeResult> {
    if (this.scenario === 'blocked') {
      return createScrapeResult(
        'ebay',
        [],
        'blocked',
        'eBay requested verification (CAPTCHA / bot block)',
        1,
        0
      );
    }
    if (this.scenario === 'failed') {
      return createScrapeResult(
        'ebay',
        [],
        'failed',
        'Page 1 failed to load: net::ERR_CONNECTION_TIMED_OUT',
        1,
        0
      );
    }
    if (this.scenario === 'partial') {
      return createScrapeResult(
        'ebay',
        [
          {
            platform: 'ebay',
            externalId: `mock-partial-${options.query}-${options.isSold ? 'sold' : 'active'}`,
            title: `${options.query} Good Condition`,
            currentPrice: 450,
            currency: 'AUD',
            url: 'https://ebay.com.au/itm/mock-partial',
            isSold: !!options.isSold,
          },
        ],
        'partial',
        'Partial scrape failure: Page 2 timed out',
        2,
        1
      );
    }
    if (this.scenario === 'empty') {
      return createScrapeResult('ebay', [], 'empty', null, 1, 1);
    }
    // success
    return createScrapeResult(
      'ebay',
      [
        {
          platform: 'ebay',
          externalId: `mock-success-${options.query}-${options.isSold ? 'sold' : 'active'}`,
          title: `${options.query} Founders Edition`,
          currentPrice: 420,
          currency: 'AUD',
          url: 'https://ebay.com.au/itm/mock-success',
          isSold: !!options.isSold,
        },
      ],
      'success',
      null,
      1,
      1
    );
  }
}

interface CliArgs {
  all: boolean;
  searchId?: number;
  query?: string;
  category?: string;
  negativeKeywords?: string;
  pages: number;
  head: boolean;
  activeOnly: boolean;
  soldOnly: boolean;
  mock?: 'success' | 'empty' | 'blocked' | 'failed' | 'partial';
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = {
    all: false,
    pages: 1,
    head: false,
    activeOnly: false,
    soldOnly: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--all') {
      result.all = true;
    } else if (arg === '--search' && args[i + 1]) {
      result.searchId = parseInt(args[++i], 10);
    } else if (arg === '--query' && args[i + 1]) {
      result.query = args[++i];
    } else if (arg === '--category' && args[i + 1]) {
      result.category = args[++i];
    } else if (arg === '--negative' && args[i + 1]) {
      result.negativeKeywords = args[++i];
    } else if (arg === '--pages' && args[i + 1]) {
      result.pages = Math.min(Math.max(parseInt(args[++i], 10), 1), 3);
    } else if (arg === '--head') {
      result.head = true;
    } else if (arg === '--active-only') {
      result.activeOnly = true;
    } else if (arg === '--sold-only') {
      result.soldOnly = true;
    } else if (arg === '--mock' && args[i + 1]) {
      result.mock = args[++i] as 'success' | 'empty' | 'blocked' | 'failed' | 'partial';
    }
  }

  return result;
}

async function runCli(): Promise<void> {
  const options = parseArgs();
  const db = getDb();
  const scraper: BaseMarketplaceScraper = options.mock
    ? new CliMockScraper(options.mock)
    : new EbayScraper();

  let hasBlocked = false;
  let hasErrors = false;

  console.log('\n========================================');
  console.log('🎯 Secondhand Deal Sniper - Scraper CLI');
  console.log('========================================');

  const targets: TrackedSearch[] = [];

  // Determine what to scrape
  if (options.query) {
    // Ad-hoc query: Check if trackedSearch exists, or create one
    const category = options.category || 'General';
    let existing = db
      .prepare(`SELECT * FROM trackedSearches WHERE query = ?`)
      .get(options.query) as TrackedSearch | undefined;

    if (!existing) {
      const insert = db.prepare(`
        INSERT INTO trackedSearches (query, category, negativeKeywords)
        VALUES (?, ?, ?)
      `);
      const res = insert.run(options.query, category, options.negativeKeywords || null);
      existing = db
        .prepare(`SELECT * FROM trackedSearches WHERE id = ?`)
        .get(res.lastInsertRowid) as TrackedSearch;
      console.log(`✨ Created new tracked search: "${options.query}" [ID: ${existing.id}]`);
    }

    targets.push(existing);
  } else if (options.searchId) {
    const search = db
      .prepare(`SELECT * FROM trackedSearches WHERE id = ?`)
      .get(options.searchId) as TrackedSearch | undefined;

    if (!search) {
      console.error(`❌ Tracked search ID ${options.searchId} not found in database.`);
      process.exit(1);
    }
    targets.push(search);
  } else if (options.all) {
    const allSearches = db
      .prepare(`SELECT * FROM trackedSearches WHERE isActive = 1`)
      .all() as TrackedSearch[];

    if (allSearches.length === 0) {
      console.log('ℹ️  No active tracked searches found in database.');
      console.log('💡 Tip: Add one using --query "RTX 3080" --category "GPU"');
      closeDb();
      return;
    }
    targets.push(...allSearches);
  } else {
    console.log('Usage:');
    console.log('  npx tsx scripts/scrape-cli.ts --all');
    console.log('  npx tsx scripts/scrape-cli.ts --search <id>');
    console.log('  npx tsx scripts/scrape-cli.ts --query <text> --category <cat> [--pages <n>] [--head]');
    closeDb();
    return;
  }

  console.log(`\n📋 Processing ${targets.length} target(s)...\n`);

  const profileRoot = process.env.BROWSER_PROFILE_ROOT ?? path.join(os.tmpdir(), 'price-tracking-profiles');
  const profileDir = createOwnedProfile(profileRoot, 'cli-');
  try {
    await scraper.openSession({ query: targets[0].query, headless: !options.head, userDataDir: profileDir });
  for (const target of targets) {
    console.log(`Target: "${target.query}" [${target.category}] (ID: ${target.id})`);
    const outcome = await runSearchWorkflow({
      search: target, scraper,
      options: { maxPages: options.pages, headless: !options.head, userDataDir: profileDir },
      policy: {
        sold: options.soldOnly ? 'only' : options.activeOnly ? 'skip' : 'refresh',
        verifyEnded: !options.soldOnly,
      },
    });
    if (outcome.sold) console.log(`Sold scrape ${outcome.sold.status}: ${outcome.sold.items.length} raw listings.`);
    if (outcome.active) {
      console.log(`Active scrape ${outcome.active.status}: ${outcome.active.items.length} raw listings.`);
      if (outcome.active.status !== 'success') {
        console.log('Reconciliation skipped; search-page absence does not delist listings.');
      }
    }
    if (outcome.status === 'blocked') hasBlocked = true;
    if (outcome.status === 'failed' || outcome.status === 'cancelled') hasErrors = true;
    if (outcome.errorMessage) console.error(outcome.errorMessage);
    console.log(`Ingested ${outcome.itemsScraped} raw listings; ${outcome.dealsFound} final active deals for this search; ${outcome.verifiedEnded} verified ended.`);

    const activeDeals = db.prepare(`
      SELECT d.*, l.title, l.url, l.currentPrice
      FROM dealsLog d JOIN listings l ON d.listingId = l.id
      WHERE d.searchId = ? AND d.status = 'ACTIVE'
      ORDER BY d.discountPercentage DESC
    `).all(target.id) as Array<Deal & { title: string; currentPrice: number; url: string }>;
    if (activeDeals.length > 0) {
      console.log(`${activeDeals.length} ACTIVE DEAL(S) AFTER RECONCILIATION:`);
      activeDeals.forEach((deal, idx) => {
        console.log(`   ${idx + 1}. [${deal.discountPercentage}% OFF] $${deal.currentPrice.toFixed(2)} AUD (Market: $${deal.baselineMarketPrice.toFixed(2)})`);
        console.log(`      Title: ${deal.title}`);
        console.log(`      Link:  ${deal.url}`);
      });
    } else console.log('No active deals >= 25% below market remain.');
  }
  } finally {
    try { await scraper.closeSession(); }
    finally { await removeOwnedProfile(profileRoot, profileDir); }
  }

  closeDb();
  if (hasBlocked) {
    console.error('Scraping job finished BLOCKED.');
    process.exitCode = 2;
  } else if (hasErrors) {
    console.error('Scraping job finished with ERRORS.');
    process.exitCode = 1;
  } else console.log('Scraping job completed.');
}

runCli().catch((err) => {
  console.error('Fatal CLI Error:', err);
  closeDb();
  process.exitCode = 1;
});
