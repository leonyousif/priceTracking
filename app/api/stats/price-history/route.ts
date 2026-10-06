import type { ListingHistoryResponse, SearchHistoryResponse, HistoryListingDto, PricePointDto, SearchDto, DailyTrendDto } from '@/lib/types';
import { errorResponse } from '@/lib/api';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { parseId, validatePaginationQuery } from '@/lib/validation';
import { defaultHistoryWindow, parseCalendarDate } from '@/lib/history';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const listingIdParam = searchParams.get('listingId');
    const searchIdParam = searchParams.get('searchId');
    if (Number(listingIdParam !== null) + Number(searchIdParam !== null) !== 1) {
      return errorResponse({ query: ['Provide exactly one of listingId or searchId'] });
    }

    if (listingIdParam !== null) {
      const listingId = parseId(listingIdParam);
      if (listingId === undefined) return errorResponse({ listingId: ['listingId must be a positive integer'] });
      const pagination = validatePaginationQuery({ page: searchParams.get('page') ?? '1', limit: searchParams.get('limit') ?? '50' });
      if (!pagination.success) return errorResponse(pagination.errors);
      const { page, limit } = pagination.data;
      const db = getDb();
      return db.transaction(() => {
        const listing = db.prepare('SELECT id, title, currentPrice, currency, url, isSold, isActive FROM listings WHERE id = ?')
          .get(listingId) as HistoryListingDto | undefined;
        if (!listing) return errorResponse({ listingId: [`Listing #${listingId} not found`] }, 404);
        const total = (db.prepare('SELECT COUNT(*) AS n FROM priceHistory WHERE listingId = ?').get(listingId) as { n: number }).n;
        // Newest page first; display each page chronologically with its real predecessor.
        const history = (db.prepare(`SELECT id, price, recordedAt FROM priceHistory WHERE listingId = ?
          ORDER BY recordedAt DESC, id DESC LIMIT ? OFFSET ?`).all(listingId, limit, (page - 1) * limit) as PricePointDto[]).reverse();
        const first = history[0];
        const predecessor = first ? db.prepare(`SELECT id, price, recordedAt FROM priceHistory WHERE listingId = ?
          AND (recordedAt, id) < (?, ?) ORDER BY recordedAt DESC, id DESC LIMIT 1`)
          .get(listingId, first.recordedAt, first.id) as PricePointDto | undefined : undefined;
        return NextResponse.json<ListingHistoryResponse>({ success: true, mode: 'listing', semantics: 'item_price_events',
          listing, history, predecessor: predecessor ?? null, total, page, limit, totalPages: Math.ceil(total / limit) || 1 });
      })();
    }

    const searchId = parseId(searchIdParam);
    if (searchId === undefined) return errorResponse({ searchId: ['searchId must be a positive integer'] });
    const defaults = defaultHistoryWindow();
    const startDate = searchParams.get('startDate') ?? defaults.startDate;
    const endDate = searchParams.get('endDate') ?? defaults.endDate;
    const start = parseCalendarDate(startDate);
    const end = parseCalendarDate(endDate);
    if (!start || !end || end.getTime() < start.getTime() || end.getTime() - start.getTime() > 91 * 86400000) {
      return errorResponse({ dateWindow: ['Use valid YYYY-MM-DD dates in ascending order, at most 92 days inclusive'] });
    }
    const exclusiveEnd = new Date(end.getTime() + 86400000).toISOString().slice(0, 10);
    const db = getDb();
    return db.transaction(() => {
      const search = db.prepare('SELECT id, query, category FROM trackedSearches WHERE id = ?')
        .get(searchId) as Pick<SearchDto, 'id' | 'query' | 'category'> | undefined;
      if (!search) return errorResponse({ searchId: [`Tracked search #${searchId} not found`] }, 404);
      // First-seen/item-price-change events, not repeated market observations.
      // SQLite aggregates the window; Node receives at most 92 daily rows.
      const trends = db.prepare(`
        WITH events AS (
          SELECT substr(ph.recordedAt, 1, 10) AS date, ph.price
          FROM searchListings sl JOIN priceHistory ph ON ph.listingId = sl.listingId
          WHERE sl.searchId = ? AND ph.recordedAt >= ? AND ph.recordedAt < ?
        ), ranked AS (
          SELECT date, price, ROW_NUMBER() OVER (PARTITION BY date ORDER BY price) AS rank,
            COUNT(*) OVER (PARTITION BY date) AS n FROM events
        )
        SELECT date, AVG(CASE WHEN rank IN ((n + 1) / 2, (n + 2) / 2) THEN price END) AS medianItemPrice,
          MIN(price) AS minItemPrice, MAX(price) AS maxItemPrice, ROUND(AVG(price), 2) AS avgItemPrice,
          COUNT(*) AS eventCount FROM ranked GROUP BY date ORDER BY date ASC
      `).all(searchId, startDate, exclusiveEnd) as DailyTrendDto[];
      return NextResponse.json<SearchHistoryResponse>({ success: true, mode: 'search', semantics: 'item_price_events',
        search, startDate, endDate, trends });
    })();
  } catch (error: unknown) {
    console.error('[API /api/stats/price-history GET] Error:', error);
    return errorResponse({ server: ['Internal server error fetching price history'] }, 500);
  }
}
