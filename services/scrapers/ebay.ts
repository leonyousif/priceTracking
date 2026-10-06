/**
 * eBay Playwright Scraper Implementation
 * Uses real Chrome channel with stealth configuration (off-screen rendering)
 * to reliably fetch live search listings without Akamai 403 bot blocks.
 */

import { chromium, BrowserContext, Page } from 'playwright';
import { BaseMarketplaceScraper, createScrapeResult, ListingToVerify, MarketplaceBlockedError, ScrapeCancelledError, ScraperRunOptions, ScrapeResult, ScraperStatus } from './base';
import { RawScrapedItem } from '../../lib/types';
import { compileProductMatchPolicy, getEbayCategoryId, ProductMatchPolicy } from '../product-matcher';
import { calculateDeliveredCost, parseListingPricing } from '../pricing';

const MAX_ITEM_PAGE_FALLBACKS = 6;
const ITEM_PAGE_TIMEOUT_MS = 10000;
const PLAUSIBLE_DEAL_PRICE_RATIO = 0.75;
const MAX_ENDED_PAGE_CHECKS = 3;
const EBAY_DOMAINS = new Set(['ebay.com.au', 'ebay.com', 'ebay.co.uk', 'ebay.ca', 'ebay.de',
  'ebay.fr', 'ebay.it', 'ebay.es', 'ebay.ie', 'ebay.at', 'ebay.ch', 'ebay.be', 'ebay.nl', 'ebay.pl']);

/** Shared search-card, fallback and verification identity policy for the configured market. */
export function parseEbayItemUrl(value: string, expectedId?: string): { externalId: string; url: string } | null {
  try {
    const url = new URL(value);
    const domain = (process.env.EBAY_DOMAIN?.trim() || 'ebay.com.au').toLowerCase();
    if (!EBAY_DOMAINS.has(domain) || url.protocol !== 'https:' || url.username || url.password || url.port ||
        (url.hostname !== domain && url.hostname !== `www.${domain}`)) return null;
    const pathId = url.pathname.match(/^\/itm\/(?:[^/]+\/)?(\d+)\/?$/)?.[1];
    const queryIds = ['item', 'itm', 'itemId'].flatMap(key => url.searchParams.getAll(key));
    const externalId = pathId ?? (url.pathname === '/itm' ? queryIds[0] : undefined);
    if (!externalId || !/^\d+$/.test(externalId) || (expectedId !== undefined && expectedId !== externalId) ||
        queryIds.some(id => id !== externalId)) return null;
    if (!pathId) url.pathname = `/itm/${externalId}`;
    url.search = ''; url.hash = '';
    return { externalId, url: url.href };
  } catch { return null; }
}

async function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    void operation.catch(() => undefined);
    throw new ScrapeCancelledError('Scrape cancelled');
  }
  let rejectAbort: ((reason: Error) => void) | undefined;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort?.(new ScrapeCancelledError('Scrape cancelled'));
  signal.addEventListener('abort', onAbort, { once: true });
  try { return await Promise.race([operation, aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

function checkCancellation(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ScrapeCancelledError('Scrape cancelled');
}

async function isChallengePage(page: Page, signal?: AbortSignal): Promise<boolean> {
  const title = (await abortable(page.title(), signal)).toLowerCase();
  if (['sign in', 'pardon our interruption', 'security measure', 'captcha', 'robot'].some(text => title.includes(text))) return true;
  return abortable(page.evaluate(() => ['pardon our interruption', 'please verify you are a human',
    'security check', 'enter the characters you see below'].some(text =>
    (document.body?.innerText.toLowerCase() || '').includes(text))), signal);
}

export async function isExplicitNoResultsPage(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    // If item links exist, a changed card layout is more likely than no results.
    if (document.querySelector('a[href*="/itm/"]')) return false;
    const headings = Array.from(document.querySelectorAll(
      'h1, h2, h3, .srp-save-null-search__heading, .srp-river__no-results'
    ));
    return headings.some((heading) => {
      const text = heading.textContent?.trim().replace(/\s+/g, ' ') || '';
      return /^(?:0 results(?: for\b|$)|no results found\b|no exact matches found\b|no matches found\b|we couldn.t find any results\b|sorry, no matches were found\b)/i.test(text);
    });
  });
}

export type SearchPageReadiness = 'results' | 'empty' | 'blocked' | 'unsupported';

/** Wait for a recognizable result state, with a bound for changed or stalled layouts. */
export async function waitForSearchPageReady(page: Page, timeoutMs = 6000, signal?: AbortSignal): Promise<SearchPageReadiness> {
  try {
    const handle = await abortable(page.waitForFunction(() => {
      const body = document.body?.innerText.toLowerCase() || '';
      if (['pardon our interruption', 'please verify you are a human', 'security check',
        'enter the characters you see below'].some((text) => body.includes(text))) return 'blocked';
      if (document.querySelector('.s-card .s-card__title, .s-item .s-item__title, .s-card [role="heading"], .s-item [role="heading"], .s-card h3, .s-item h3')) {
        const cards = Array.from(document.querySelectorAll('.s-card, .s-item, li.s-card'));
        if (cards.some((card) => card.querySelector('.s-card__price, .s-item__price, [class*="price"]') &&
            card.querySelector('a[href*="/itm/"]'))) return 'results';
      }
      if (!document.querySelector('a[href*="/itm/"]')) {
        const headings = Array.from(document.querySelectorAll('h1, h2, h3, .srp-save-null-search__heading, .srp-river__no-results'));
        if (headings.some((heading) => /^(?:0 results(?: for\b|$)|no results found\b|no exact matches found\b|no matches found\b|we couldn.t find any results\b|sorry, no matches were found\b)/i
          .test(heading.textContent?.trim().replace(/\s+/g, ' ') || ''))) return 'empty';
      }
      return false;
    }, null, { timeout: timeoutMs, polling: 100 }), signal);
    const state = await handle.jsonValue() as Exclude<SearchPageReadiness, 'unsupported'>;
    await handle.dispose();
    return state;
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') return 'unsupported';
    throw error;
  }
}

export async function isVerifiedEndedItemPage(page: Page, externalId: string): Promise<boolean> {
  try {
    if (!parseEbayItemUrl(page.url(), externalId)) return false;
    return page.evaluate(() => {
      const itemTitle = document.querySelector('h1.x-item-title__mainTitle')?.textContent?.trim();
      if (!itemTitle) return false;
      const lines = (document.body?.innerText || '').split(/\n+/).map((line) => line.trim());
      return lines.some((line) => /^This listing (?:has ended|sold)(?:\.|\s|$)/i.test(line));
    });
  } catch {
    return false;
  }
}

export function selectItemPageCandidates(
  items: RawScrapedItem[],
  options: ScraperRunOptions,
  match: ProductMatchPolicy = compileProductMatchPolicy(options)
): RawScrapedItem[] {
  if (options.isSold) return [];

  const completeCosts = items
    .filter((item) => !item.isSold && match(item.title).isMatch)
    .map((item) => calculateDeliveredCost(item.currentPrice, item.postage))
    .filter((cost): cost is number => cost !== null && Number.isFinite(cost))
    .sort((a, b) => a - b);
  if (completeCosts.length < 3) return [];

  const middle = Math.floor(completeCosts.length / 2);
  const median = completeCosts.length % 2 === 1
    ? completeCosts[middle]
    : (completeCosts[middle - 1] + completeCosts[middle]) / 2;

  return items
    .filter((item) => {
      if (item.isSold || item.postage != null || !Number.isFinite(item.currentPrice) ||
          item.currentPrice <= 0 || item.currentPrice > median * PLAUSIBLE_DEAL_PRICE_RATIO ||
          !match(item.title).isMatch) return false;
      return !!parseEbayItemUrl(item.url, item.externalId);
    })
    .sort((a, b) => b.currentPrice - a.currentPrice)
    .slice(0, MAX_ITEM_PAGE_FALLBACKS);
}

export class EbayScraper extends BaseMarketplaceScraper {
  readonly platform = 'ebay';
  private sessionContext: BrowserContext | null = null;
  private sessionOperations = 0;

  protected async launchContext(options: ScraperRunOptions): Promise<BrowserContext> {
    const isVisible = options.headless === false;
    const args = ['--disable-blink-features=AutomationControlled', '--no-sandbox',
      '--disable-setuid-sandbox', '--disable-dev-shm-usage'];
    if (!isVisible) args.push('--window-position=-32000,-32000', '--window-size=1280,800');
    const profileDir = options.userDataDir || process.env.BROWSER_PROFILE_ROOT || './data/browser-profile';
    const common = { args, viewport: { width: 1280, height: 800 }, locale: 'en-AU' };
    try {
      return await chromium.launchPersistentContext(profileDir, {
        ...common, channel: 'chrome', headless: false,
      });
    } catch {
      return chromium.launchPersistentContext(profileDir, { ...common, headless: !isVisible });
    }
  }

  async openSession(options: ScraperRunOptions): Promise<void> {
    if (this.sessionContext) throw new Error('Scraper session is already open');
    this.sessionContext = await this.launchContext(options);
    this.sessionOperations = 0;
  }

  async closeSession(): Promise<void> {
    const context = this.sessionContext;
    if (context) await context.close();
    this.sessionContext = null;
    this.sessionOperations = 0;
  }

  private async paceSession(options: ScraperRunOptions): Promise<void> {
    if (!this.sessionContext) return;
    if (this.sessionOperations++ > 0 && options.delayMs !== 0) {
      await this.politeDelay(1000, 1800);
    }
  }

  /**
   * Scrapes eBay search results for the given options.
   */
  async scrape(options: ScraperRunOptions): Promise<ScrapeResult> {
    const domain = process.env.EBAY_DOMAIN || 'ebay.com.au';
    const defaultCurrency = process.env.DEFAULT_CURRENCY || 'AUD';
    const maxPages = Math.min(Math.max(options.maxPages || 1, 1), 3);
    const results: RawScrapedItem[] = [];
    let context: BrowserContext | null = null;
    let status: ScraperStatus = 'success';
    let errorMessage: string | null = null;
    let pagesAttempted = 0;
    let pagesCompleted = 0;

    try {
      context = this.sessionContext ?? await this.launchContext(options);
      await this.paceSession(options);
      const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

      for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
        checkCancellation(options.signal);
        pagesAttempted++;
        const url = this.buildSearchUrl(domain, options, pageNum);

        try {
          const response = await abortable(page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: 25000,
          }), options.signal);

          const pageTitle = (await page.title().catch(() => '')).toLowerCase();
          const statusCode = response?.status() ?? 200;

          // Check if eBay requested sign-in, verification challenge, or bot block
          const isBotBlock =
            statusCode === 403 ||
            statusCode === 429 ||
            pageTitle.includes('sign in') ||
            pageTitle.includes('pardon our interruption') ||
            pageTitle.includes('security measure') ||
            pageTitle.includes('captcha') ||
            pageTitle.includes('robot');

          let bodyHasVerification = false;
          if (!isBotBlock) {
            bodyHasVerification = await page
              .evaluate(() => {
                const text = document.body ? document.body.innerText.toLowerCase() : '';
                return (
                  text.includes('pardon our interruption') ||
                  text.includes('please verify you are a human') ||
                  text.includes('security check') ||
                  text.includes('enter the characters you see below')
                );
              })
              .catch(() => false);
          }

          if (isBotBlock || bodyHasVerification) {
            if (options.isSold) {
              console.log(
                `   eBay blocked sold results; stopping this search to avoid further requests.`
              );
              status = pagesCompleted > 0 ? 'partial' : 'blocked';
              errorMessage = `eBay requested verification for sold results on page ${pageNum}`;
            } else {
              console.warn(`   ⚠️  eBay requested verification for: ${url}`);
              if (pagesCompleted > 0) {
                status = 'partial';
                errorMessage = `eBay requested verification on page ${pageNum} after ${pagesCompleted} successful page(s)`;
              } else {
                status = 'blocked';
                errorMessage = `eBay requested verification (CAPTCHA / bot block) on page ${pageNum}`;
              }
            }
            break;
          }

          if (statusCode >= 400) {
            if (pagesCompleted > 0) {
              status = 'partial';
              errorMessage = `eBay returned HTTP status ${statusCode} on page ${pageNum}`;
            } else {
              status = 'failed';
              errorMessage = `eBay returned HTTP status ${statusCode} on page ${pageNum}`;
            }
            break;
          }

          const readiness = await waitForSearchPageReady(page, 6000, options.signal);
          if (readiness === 'blocked') {
            status = pagesCompleted > 0 ? 'partial' : 'blocked';
            errorMessage = `eBay requested verification on page ${pageNum}`;
            break;
          }
          if (readiness === 'unsupported') {
            status = pagesCompleted > 0 ? 'partial' : 'failed';
            errorMessage = `Search results did not become ready on page ${pageNum}`;
            break;
          }

          // Extract listings from current page
          const pageItems = await this.extractListingsFromPage(
            page,
            defaultCurrency,
            !!options.isSold
          );

          if (pageItems.length === 0) {
            if (await isExplicitNoResultsPage(page)) {
              pagesCompleted++;
              if (results.length === 0) status = 'empty';
            } else {
              status = pagesCompleted > 0 ? 'partial' : 'failed';
              errorMessage = `No listing cards extracted on page ${pageNum} and no explicit no-results message was found`;
            }
            break;
          }

          results.push(...pageItems);
          pagesCompleted++;

          // Polite delay between pages if scraping multiple pages
          if (pageNum < maxPages) {
            await this.politeDelay(1500, 2500);
          }
        } catch (pageErr) {
          const errMsg = pageErr instanceof Error ? pageErr.message : String(pageErr);
          if (!options.signal?.aborted) console.warn(`[EbayScraper] Warning on page ${pageNum}:`, pageErr);
          if (options.signal?.aborted || pageErr instanceof ScrapeCancelledError) {
            status = 'cancelled';
            errorMessage = 'Scrape cancelled';
          } else if (pagesCompleted > 0) {
            status = 'partial';
            errorMessage = `Failed on page ${pageNum}: ${errMsg}`;
          } else {
            status = 'failed';
            errorMessage = `Failed to load page ${pageNum}: ${errMsg}`;
          }
          break;
        }
      }

      if (!options.isSold && results.length > 0 && status === 'success') {
        try {
          await this.enrichMissingPostage(context, results, options);
        } catch (error) {
          status = options.signal?.aborted || error instanceof ScrapeCancelledError ? 'cancelled'
            : error instanceof MarketplaceBlockedError ? 'blocked' : 'partial';
          errorMessage = `Item-page postage fallback: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      status = options.signal?.aborted || err instanceof ScrapeCancelledError ? 'cancelled' : 'failed';
      errorMessage = `Browser launch failure: ${errMsg}`;
    } finally {
      if (context && context !== this.sessionContext) await context.close();
    }

    return createScrapeResult(
      this.platform,
      results,
      status,
      errorMessage,
      pagesAttempted,
      pagesCompleted
    );
  }

  async verifyEndedListings(candidates: ListingToVerify[], options: ScraperRunOptions): Promise<string[]> {
    const safeCandidates = candidates.filter(candidate => !!parseEbayItemUrl(candidate.url, candidate.externalId))
      .slice(0, MAX_ENDED_PAGE_CHECKS);
    if (safeCandidates.length === 0) return [];

    const context = this.sessionContext ?? await this.launchContext(options);
    await this.paceSession(options);
    const verified: string[] = [];
    let checkError: Error | null = null;
    try {
      const page = context.pages()[0] || await context.newPage();
      for (const candidate of safeCandidates) {
        try {
          checkCancellation(options.signal);
          const response = await abortable(page.goto(candidate.url, {
            waitUntil: 'domcontentloaded', timeout: ITEM_PAGE_TIMEOUT_MS,
          }), options.signal);
          const status = response?.status();
          if (status === 403 || status === 429) throw new MarketplaceBlockedError(`Item-page verification blocked for ${candidate.externalId}`);
          if (status !== 200) throw new Error(`Item-page verification returned HTTP ${status ?? 'unknown'} for ${candidate.externalId}`);
          if (await isChallengePage(page, options.signal)) throw new MarketplaceBlockedError('Item-page verification requested a challenge');
          if (await isVerifiedEndedItemPage(page, candidate.externalId)) {
            verified.push(candidate.externalId);
          }
        } catch (error) {
          checkError = error instanceof Error ? error : new Error(String(error));
          break;
        }
      }
    } finally {
      if (context !== this.sessionContext) await context.close();
    }
    if (checkError) throw checkError;
    return verified;
  }

  async enrichMissingPostage(
    context: BrowserContext,
    items: RawScrapedItem[],
    options: ScraperRunOptions
  ): Promise<void> {
    checkCancellation(options.signal);
    const match = compileProductMatchPolicy(options);
    const candidates = selectItemPageCandidates(items, options, match);
    if (candidates.length === 0) return;

    const itemPage = await context.newPage();
    try {
      for (const item of candidates) {
        try {
          checkCancellation(options.signal);
          const response = await abortable(itemPage.goto(item.url, {
            waitUntil: 'domcontentloaded',
            timeout: ITEM_PAGE_TIMEOUT_MS,
          }), options.signal);
          checkCancellation(options.signal);
          if (response?.status() === 403 || response?.status() === 429) {
            throw new MarketplaceBlockedError(`Postage fallback returned HTTP ${response.status()}`);
          }
          if (!response || response.status() >= 400) continue;
          if (!parseEbayItemUrl(itemPage.url(), item.externalId)) continue;
          if (await isChallengePage(itemPage, options.signal)) throw new MarketplaceBlockedError('Postage fallback requested a challenge');
          await abortable(itemPage.locator(
            '.ux-labels-values--shipping, [data-testid="ux-labels-values--shipping"], .d-shipping-minview, [data-testid="d-shipping-minview"]'
          ).first().waitFor({ state: 'attached', timeout: 3000 }).catch(error => {
            if (error instanceof Error && error.name === 'TimeoutError') return null;
            throw error;
          }), options.signal);
          checkCancellation(options.signal);
          const details = await abortable(this.extractItemPage(itemPage), options.signal);
          if (details.externalId !== item.externalId || details.currency !== 'AUD' || details.isSold ||
              details.itemPrice === null || !Number.isFinite(details.itemPrice) ||
              Math.abs(details.itemPrice - item.currentPrice) > 0.05 ||
              details.postage === null || !Number.isFinite(details.postage) || details.postage < 0 ||
              !match(details.title).isMatch) continue;

          item.postage = details.postage;
          item.estimatedDeliveredCost = calculateDeliveredCost(item.currentPrice, details.postage);
        } catch (error) {
          if (options.signal?.aborted || error instanceof ScrapeCancelledError) throw new ScrapeCancelledError('Scrape cancelled');
          if (error instanceof MarketplaceBlockedError) throw error;
          console.warn(`[EbayScraper] Item page ${item.externalId} could not be read:`, error);
        }
      }
    } finally {
      await itemPage.close();
    }
  }

  /**
   * Constructs an eBay search URL with Buy-It-Now, sort, sold, and negative query parameters.
   */
  private buildSearchUrl(
    domain: string,
    options: ScraperRunOptions,
    pageNumber: number
  ): string {
    const encodedQuery = encodeURIComponent(options.query.trim());
    let url = `https://www.${domain}/sch/i.html?_nkw=${encodedQuery}&_ipg=60&_pgn=${pageNumber}`;

    // Apply category filter (_sacat) where it improves results
    const categoryId = getEbayCategoryId(options.category, options.query);
    if (categoryId) {
      url += `&_sacat=${categoryId}`;
    }

    // Buy It Now filter
    url += '&LH_BIN=1';

    // Lowest Price + Shipping sort
    url += '&_sop=15';

    // If scraping sold items: LH_Sold=1&LH_Complete=1
    if (options.isSold) {
      url += '&LH_Sold=1&LH_Complete=1';
    }

    return url;
  }

  /** Extract raw card text with layout selectors; apply shared pricing in Node. */
  private async extractListingsFromPage(
    page: Page,
    defaultCurrency: string,
    isSold: boolean
  ): Promise<RawScrapedItem[]> {
    const rawItems = await page.evaluate(() => {
      const items: Array<{
        externalId: string;
        title: string;
        rawPriceText: string;
        rawShippingText: string;
        cardText: string;
        url: string;
        imageUrl: string | null;
        location: string | null;
        sellerName: string | null;
      }> = [];
      const cards = Array.from(document.querySelectorAll('.s-card, .s-item, li.s-card'));

      cards.forEach((card) => {
        const titleEl = card.querySelector(
          '.s-card__title, .s-item__title, [role="heading"], h3'
        );
        const priceEl = card.querySelector(
          '.s-card__price, .s-item__price, [class*="price"]'
        );
        if (!titleEl || !priceEl) return;
        const approxPriceEl = card.querySelector(
          '.s-card__price-approx, .s-item__price-approx, [class*="price-approx"], .s-item__trending-price'
        );
        const rawPrimary = priceEl.textContent?.trim() || '';
        const rawApprox = approxPriceEl?.textContent?.trim() || '';
        const rawPriceText = rawApprox ? `${rawPrimary} ${rawApprox}` : rawPrimary;

        const shippingEl = card.querySelector(
          '.s-card__shipping, .s-item__shipping, .s-item__logisticsCost, .s-card__logisticsCost, .s-item__delivery-price, [class*="shipping"], [class*="logisticsCost"], [class*="delivery"], [class*="postage"]'
        );
        let rawShippingText = shippingEl?.textContent?.trim() || '';
        if (!rawShippingText) {
          const allElements = Array.from(card.querySelectorAll('span, div, p'));
          for (const el of allElements) {
            if (el.children.length === 0) {
              const text = el.textContent?.trim() || '';
              if (/(?:delivery|postage|shipping|free)/i.test(text) && text.length < 80) {
                rawShippingText = text;
                break;
              }
            }
          }
        }

        const linkEl = card.querySelector(
          'a.s-card__link, a.s-item__link, a[href*="/itm/"]'
        ) as HTMLAnchorElement | null;
        if (!linkEl?.href) return;
        const rawUrl = linkEl.href;
        const externalId = card.getAttribute('data-itemid') || card.getAttribute('data-listingid') || '';

        const imgEl = card.querySelector(
          '.s-card__image img, .s-item__image-wrapper img, img'
        ) as HTMLImageElement | null;
        const locationEl = card.querySelector(
          '.s-item__location, .s-item__itemLocation, [class*="location"]'
        );
        const sellerEl = card.querySelector(
          '.s-item__seller-info-text, .s-item__seller-info, [class*="seller"]'
        );
        items.push({
          externalId,
          title: titleEl.textContent?.trim() || '',
          rawPriceText,
          rawShippingText,
          cardText: card.textContent || '',
          url: rawUrl,
          imageUrl: imgEl?.getAttribute('data-src') || imgEl?.getAttribute('src') || null,
          location: locationEl?.textContent?.replace(/from\s+/i, '').trim() || null,
          sellerName: sellerEl?.textContent?.split('(')[0]?.trim() || null,
        });
      });
      return items;
    });

    const items: RawScrapedItem[] = [];
    for (const raw of rawItems) {
      const identity = parseEbayItemUrl(raw.url, raw.externalId || undefined);
      if (!identity) continue;
      const title = raw.title
        .replace(/Opens in a new window or tab/gi, '')
        .replace(/^New listing/gi, '').trim();
      if (!title || title.toLowerCase().startsWith('shop on ebay') ||
          title.toLowerCase() === 'new listing') continue;
      const gpuMatches = title.match(
        /\b(?:rtx|gtx|rx)\s*\d{3,4}(?:\s*ti|\s*super|\s*xt)?\b/gi
      ) || [];
      const normalizedGpus = new Set(gpuMatches.map((match) => match.toLowerCase().replace(/\s+/g, '')));
      if (normalizedGpus.size >= 2) continue;
      const cardText = raw.cardText.toLowerCase();
      if (['options available', 'select model', 'choose model', 'customizable']
          .some((marker) => cardText.includes(marker))) continue;

      const pricing = parseListingPricing(raw.rawPriceText, raw.rawShippingText, defaultCurrency);
      if (pricing.itemPrice === null || pricing.itemPrice <= 0) continue;
      items.push({
        platform: this.platform,
        externalId: identity.externalId,
        title,
        currentPrice: pricing.itemPrice,
        currency: pricing.currency,
        url: identity.url,
        imageUrl: raw.imageUrl,
        location: raw.location,
        sellerName: raw.sellerName,
        isSold,
        postage: pricing.postage,
        estimatedDeliveredCost: pricing.estimatedDeliveredCost,
      });
    }
    return items;
  }

  /** Extract item-page text separately from the search-card layout. */
  async extractItemPage(page: Page): Promise<{
    externalId: string;
    title: string;
    itemPrice: number | null;
    postage: number | null;
    estimatedDeliveredCost: number | null;
    currency: string;
    isSold: boolean;
    rawPriceText: string;
    rawShippingText: string;
  }> {
    const raw = await page.evaluate(() => {
      const itmMatch = window.location.href.match(/\/itm\/(?:[^\/]+\/)?(\d+)/);
      const titleEl = document.querySelector(
        'h1.x-item-title__mainTitle, [data-testid="x-item-title"] h1, h1'
      );
      const approxPriceEl = document.querySelector(
        '.x-price-approx, [data-testid="x-price-approx"], .x-price-approx__price'
      );
      const primaryPriceEl = document.querySelector(
        '.x-price-primary, [data-testid="x-price-primary"], .x-bin-price'
      );
      const rawPrimary = primaryPriceEl?.textContent?.trim() || '';
      const rawApprox = approxPriceEl?.textContent?.trim() || '';
      const shippingEl = document.querySelector(
        '.ux-labels-values--shipping, [data-testid="ux-labels-values--shipping"], .d-shipping-minview, [data-testid="d-shipping-minview"]'
      );
      const bodyText = document.body.innerText;
      return {
        externalId: itmMatch ? itmMatch[1] : '',
        title: titleEl?.textContent?.trim() || document.title,
        rawPriceText: rawApprox ? `${rawPrimary} ${rawApprox}` : rawPrimary,
        rawShippingText: shippingEl?.textContent?.trim().replace(/\s+/g, ' ') || '',
        isSold: bodyText.includes('This listing sold') || bodyText.includes('This listing has ended'),
      };
    });
    return {
      ...raw,
      externalId: parseEbayItemUrl(page.url(), raw.externalId)?.externalId ?? '',
      ...parseListingPricing(raw.rawPriceText, raw.rawShippingText, process.env.DEFAULT_CURRENCY || 'AUD'),
    };
  }
}
