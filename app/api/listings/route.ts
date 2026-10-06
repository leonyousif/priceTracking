import type { ListingsResponse, ListingDto } from '@/lib/types';
import { errorResponse } from '@/lib/api';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { validatePaginationQuery } from '@/lib/validation';

export const dynamic = 'force-dynamic';

/**
 * Builds a safe FTS5 query string with prefix matching for each alphanumeric token.
 * E.g., "rtx 3080" -> '"rtx"* AND "3080"*'
 */
function buildFtsQuery(rawQuery: string): string | null {
  const tokens = rawQuery
    .replace(/[^\w\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"*`).join(' AND ');
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    // Extract query parameters as Record<string, unknown> for validation
    const rawParams: Record<string, unknown> = {};
    for (const [key, value] of searchParams.entries()) {
      rawParams[key] = value;
    }

    const validation = validatePaginationQuery(rawParams);
    if (!validation.success) {
      return errorResponse(validation.errors);
    }

    const db = getDb();
    const {
      page,
      limit,
      searchId,
      query,
      isSold,
      isActive,
      minPrice,
      maxPrice,
      sortBy,
    } = validation.data;

    const offset = (page - 1) * limit;
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    // 1. Search ID filter via explicit searchListings association
    const searchFilterProvided = searchId !== undefined;
    if (searchFilterProvided) {
      conditions.push('sl.searchId = ?');
      params.push(searchId);
    }

    // 2. Status filters
    if (isSold !== undefined) {
      conditions.push('l.isSold = ?');
      params.push(isSold ? 1 : 0);
    }

    if (isActive !== undefined) {
      conditions.push('l.isActive = ?');
      params.push(isActive ? 1 : 0);
    }

    // 3. Price range filters
    if (minPrice !== undefined) {
      conditions.push('l.currentPrice >= ?');
      params.push(minPrice);
    }

    if (maxPrice !== undefined) {
      conditions.push('l.currentPrice <= ?');
      params.push(maxPrice);
    }

    // 4. Text Search via FTS5 with fallback to LIKE
    if (query) {
      const ftsFormatted = buildFtsQuery(query);
      let ftsWorked = false;

      if (ftsFormatted) {
        try {
          // Test FTS query to ensure syntax validity
          db.prepare(
            'SELECT rowid FROM listingsFts WHERE listingsFts MATCH ? LIMIT 1'
          ).get(ftsFormatted);

          conditions.push(
            'l.id IN (SELECT rowid FROM listingsFts WHERE listingsFts MATCH ?)'
          );
          params.push(ftsFormatted);
          ftsWorked = true;
        } catch {
          ftsWorked = false;
        }
      }

      if (!ftsWorked) {
        conditions.push('l.title LIKE ?');
        params.push(`%${query}%`);
      }
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Determine sort clause
    let orderClause = 'ORDER BY l.firstSeenAt DESC, l.id DESC';
    if (sortBy === 'priceAsc') {
      orderClause = 'ORDER BY l.currentPrice ASC, l.id DESC';
    } else if (sortBy === 'priceDesc') {
      orderClause = 'ORDER BY l.currentPrice DESC, l.id DESC';
    } else if (sortBy === 'oldest') {
      orderClause = 'ORDER BY l.firstSeenAt ASC, l.id ASC';
    } else if (sortBy === 'newest') {
      orderClause = 'ORDER BY l.firstSeenAt DESC, l.id DESC';
    }

    // Count total matches
    const countSql = searchFilterProvided
      ? `SELECT COUNT(*) as total FROM listings l JOIN searchListings sl ON l.id = sl.listingId ${whereClause}`
      : `SELECT COUNT(*) as total FROM listings l ${whereClause}`;

    const countRow = db.prepare(countSql).get(...params) as { total: number };
    const total = countRow.total;
    const totalPages = Math.ceil(total / limit) || 1;

    // Fetch paginated items
    const querySql = searchFilterProvided
      ? `
        SELECT
          l.id,
          sl.searchId,
          l.platform,
          l.externalId,
          l.title,
          l.currentPrice,
          l.currency,
          l.postage,
          l.estimatedDeliveredCost,
          l.url,
          l.imageUrl,
          l.location,
          l.sellerName,
          l.isSold,
          l.isActive,
          l.firstSeenAt,
          l.lastSeenAt,
          s.query as searchQuery,
          s.category
        FROM listings l
        JOIN searchListings sl ON l.id = sl.listingId
        JOIN trackedSearches s ON sl.searchId = s.id
        ${whereClause}
        ${orderClause}
        LIMIT ? OFFSET ?
      `
      : `
        SELECT
          l.id,
          COALESCE(l.searchId, (SELECT sl.searchId FROM searchListings sl WHERE sl.listingId = l.id LIMIT 1)) as searchId,
          l.platform,
          l.externalId,
          l.title,
          l.currentPrice,
          l.currency,
          l.postage,
          l.estimatedDeliveredCost,
          l.url,
          l.imageUrl,
          l.location,
          l.sellerName,
          l.isSold,
          l.isActive,
          l.firstSeenAt,
          l.lastSeenAt,
          s.query as searchQuery,
          s.category
        FROM listings l
        LEFT JOIN trackedSearches s ON s.id = COALESCE(l.searchId, (SELECT sl.searchId FROM searchListings sl WHERE sl.listingId = l.id LIMIT 1))
        ${whereClause}
        ${orderClause}
        LIMIT ? OFFSET ?
      `;

    const items = db.prepare(querySql).all(...params, limit, offset) as ListingDto[];

    return NextResponse.json<ListingsResponse>({
      success: true,
      items,
      total,
      page,
      limit,
      totalPages,
    });
  } catch (error: unknown) {
    console.error('[API /api/listings] Error:', error);
    return errorResponse({ server: ['Internal server error fetching listings'] }, 500);
  }
}
