/** One search's scrape, persistence and evidence-based ended reconciliation. */
import { getDb } from '../lib/db';
import { IngestionResult, TrackedSearch } from '../lib/types';
import { ingestScrapedListings, reconcileListings } from './pipeline';
import { BaseMarketplaceScraper, ListingToVerify, MarketplaceBlockedError, ScraperRunOptions, ScrapeResult } from './scrapers/base';

const MAX_ENDED_PAGE_CHECKS = 3;

export interface SearchWorkflowPolicy {
  sold: 'refresh' | 'skip' | 'only';
  verifyEnded: boolean;
}

export const DEFAULT_SEARCH_POLICY: SearchWorkflowPolicy = { sold: 'refresh', verifyEnded: true };

export interface SearchWorkflowResult {
  status: 'completed' | 'failed' | 'blocked' | 'cancelled';
  errorMessage: string | null;
  itemsScraped: number;
  /** Search-scoped ACTIVE deal snapshot after all attempted phases and reconciliation. */
  dealsFound: number;
  sold?: ScrapeResult;
  active?: ScrapeResult;
  soldIngestion?: IngestionResult;
  activeIngestion?: IngestionResult;
  verifiedEnded: number;
}

export async function runSearchWorkflow(input: {
  search: TrackedSearch;
  scraper: BaseMarketplaceScraper;
  options: Omit<ScraperRunOptions, 'query' | 'category' | 'negativeKeywords' | 'isSold'>;
  policy?: SearchWorkflowPolicy;
  canWrite?: () => boolean;
}): Promise<SearchWorkflowResult> {
  const { search, scraper } = input;
  const policy = input.policy ?? DEFAULT_SEARCH_POLICY;
  const db = getDb();
  const result: SearchWorkflowResult = {
    status: 'completed', errorMessage: null, itemsScraped: 0, dealsFound: 0, verifiedEnded: 0,
  };
  const baseOptions: ScraperRunOptions = {
    ...input.options, query: search.query, category: search.category,
    negativeKeywords: search.negativeKeywords,
  };
  const cancelled = () => !!baseOptions.signal?.aborted;
  const eligible = () => !cancelled() &&
    !!db.prepare('SELECT 1 FROM trackedSearches WHERE id = ? AND isActive = 1').get(search.id) &&
    (!input.canWrite || input.canWrite());
  const mark = (status: SearchWorkflowResult['status'], message: string) => {
    if (result.status === 'completed' || status === 'cancelled' || (status === 'blocked' && result.status === 'failed')) {
      result.status = status;
      result.errorMessage = message;
    } else if (result.errorMessage) {
      result.errorMessage += `; ${message}`;
    }
  };
  const write = (items: ScrapeResult['items']): IngestionResult | null => db.transaction(() => {
    if (!eligible()) return null;
    return ingestScrapedListings(search.id, items);
  }).immediate();
  const phase = async (isSold: boolean): Promise<ScrapeResult | null> => {
    if (!eligible()) { mark('cancelled', 'Search is inactive or job was cancelled'); return null; }
    let scraped: ScrapeResult;
    try {
      scraped = await scraper.scrape({ ...baseOptions, isSold });
    } catch (error) {
      mark(cancelled() ? 'cancelled' : error instanceof MarketplaceBlockedError ? 'blocked' : 'failed',
        `${isSold ? 'Sold' : 'Active'} scrape failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    if (!eligible() || scraped.status === 'cancelled') {
      mark('cancelled', 'Search is inactive or job was cancelled during scraping'); return null;
    }
    if (isSold) result.sold = scraped; else result.active = scraped;
    if ((scraped.status === 'success' || scraped.status === 'partial' ||
        (scraped.status === 'blocked' && scraped.pagesCompleted > 0)) && scraped.items.length > 0) {
      const ingestion = write(scraped.items);
      if (!ingestion) { mark('cancelled', 'Search is inactive or job cancelled before ingestion'); return scraped; }
      result.itemsScraped += scraped.items.length;
      if (isSold) result.soldIngestion = ingestion; else result.activeIngestion = ingestion;
    }
    if (scraped.status === 'blocked' || scraped.status === 'failed' || scraped.status === 'partial') {
      mark(scraped.status === 'blocked' ? 'blocked' : 'failed',
        `${isSold ? 'Sold' : 'Active'} scrape ${scraped.status}: ${scraped.errorMessage || 'Incomplete results'}`);
    }
    return scraped;
  };

  try {
  if (policy.sold !== 'skip') {
    await phase(true);
    if (result.status === 'blocked' || result.status === 'cancelled') return result;
  }
  if (policy.sold === 'only') return result;
  const active = await phase(false);
  if (!active || result.status === 'cancelled' || active.status === 'blocked' ||
      active.status === 'failed' || active.status === 'partial' || !policy.verifyEnded) return result;

  // Search-page absence is never evidence of an ended listing. Check at most three item pages.
  const seen = [...new Set(active.items.map((item) => item.externalId))];
  const unseenSql = seen.length ? `AND l.externalId NOT IN (${seen.map(() => '?').join(', ')})` : '';
  const candidates = db.prepare(`
    SELECT l.externalId, l.url FROM searchListings sl
    CROSS JOIN listings l ON l.id = sl.listingId
    WHERE sl.searchId = ? AND l.platform = ? AND l.isSold = 0 AND l.isActive = 1
    ${unseenSql}
    ORDER BY l.lastSeenAt ASC, l.id ASC
    LIMIT ?
  `).all(search.id, scraper.platform, ...seen, MAX_ENDED_PAGE_CHECKS) as ListingToVerify[];
  if (candidates.length === 0) return result;
  try {
    const ids = await scraper.verifyEndedListings(candidates, baseOptions);
    if (cancelled()) { mark('cancelled', 'Job was cancelled during ended verification'); return result; }
    const candidateIds = new Set(candidates.map((item) => item.externalId));
    const evidence = ids.filter((id) => candidateIds.has(id) && !seen.includes(id))
      .map((externalId) => ({ externalId, evidence: 'ended-item-page' as const }));
    const reconciled = db.transaction(() => {
      if (!eligible()) return null;
      return reconcileListings(search.id, evidence, scraper.platform).delistedListings;
    }).immediate();
    if (reconciled === null) mark('cancelled', 'Search was deleted or job cancelled before reconciliation');
    else result.verifiedEnded = reconciled;
  } catch (error) {
    mark(error instanceof MarketplaceBlockedError ? 'blocked' : 'failed',
      `Ended verification failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return result;
  } catch (error) {
    mark(cancelled() ? 'cancelled' : 'failed', error instanceof Error ? error.message : String(error));
    return result;
  } finally {
    result.dealsFound = (db.prepare("SELECT COUNT(*) AS n FROM dealsLog WHERE searchId = ? AND status = 'ACTIVE'")
      .get(search.id) as { n: number }).n;
  }
}
