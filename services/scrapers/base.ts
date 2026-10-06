/**
 * Base Marketplace Scraper Architecture
 * Abstract interface to support multiple secondhand platforms (eBay, Gumtree, Facebook Marketplace).
 */

import { RawScrapedItem } from '../../lib/types';

export type ScraperStatus = 'success' | 'empty' | 'blocked' | 'failed' | 'partial' | 'cancelled';

export class ScrapeCancelledError extends Error {
  override name = 'ScrapeCancelledError';
}

export class MarketplaceBlockedError extends Error {
  override name = 'MarketplaceBlockedError';
}

export interface ScrapeResult {
  platform: string;
  items: RawScrapedItem[];
  status: ScraperStatus;
  errorMessage: string | null;
  pagesAttempted: number;
  pagesCompleted: number;
}

export function createScrapeResult(
  platform: string,
  items: RawScrapedItem[],
  status: ScraperStatus,
  errorMessage: string | null = null,
  pagesAttempted = 0,
  pagesCompleted = 0,
): ScrapeResult {
  return { platform, items, status, errorMessage, pagesAttempted, pagesCompleted };
}

export interface ScraperRunOptions {
  query: string;
  category?: string;
  negativeKeywords?: string | null;
  isSold?: boolean;
  maxPages?: number;
  headless?: boolean;
  delayMs?: number;
  userDataDir?: string;
  signal?: AbortSignal;
}

export interface ListingToVerify {
  externalId: string;
  url: string;
}

export abstract class BaseMarketplaceScraper {
  abstract readonly platform: string;

  /** The caller owns a reusable session and must close it after the job. */
  async openSession(_options: ScraperRunOptions): Promise<void> {}
  async closeSession(): Promise<void> {}

  /**
   * Scrapes listings matching the given query options.
   */
  abstract scrape(options?: ScraperRunOptions): Promise<ScrapeResult>;

  /**
   * Verifies if specific listings are ended or active.
   */
  async verifyEndedListings(
    _listings: ListingToVerify[],
    _options?: ScraperRunOptions
  ): Promise<string[]> {
    return [];
  }

  /**
   * Randomized polite delay between operations.
   */
  protected async politeDelay(minMs = 1000, maxMs = 2500): Promise<void> {
    const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
