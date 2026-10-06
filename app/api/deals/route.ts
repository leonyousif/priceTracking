import type { DealsResponse, DealDto, DealSummary } from '@/lib/types';
import { errorResponse } from '@/lib/api';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { validatePaginationQuery, parseNumber } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    const statusParam = searchParams.get('status')?.toUpperCase() || 'ACTIVE';
    const minDiscountParam = searchParams.get('minDiscount');
    const pagination = validatePaginationQuery({
      ...Object.fromEntries(searchParams), limit: searchParams.get('limit') || '50',
    });
    if (!pagination.success) return errorResponse(pagination.errors);
    const { page, limit, searchId } = pagination.data;
    const offset = (page - 1) * limit;
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (searchId !== undefined) {
      conditions.push('d.searchId = ?');
      params.push(searchId);
    }

    // Filter by status
    if (statusParam !== 'ALL') {
      const validStatuses = ['ACTIVE', 'SOLD', 'EXPIRED', 'DELISTED'];
      if (!validStatuses.includes(statusParam)) {
        return errorResponse({ status: [`status must be one of: ${validStatuses.join(', ')}, ALL`] });
      }
      conditions.push('d.status = ?');
      params.push(statusParam);
    }

    // Filter by minDiscount
    if (minDiscountParam) {
      const minDiscount = parseNumber(minDiscountParam);
      if (minDiscount === undefined || minDiscount < 0 || minDiscount > 100) {
        return errorResponse({ minDiscount: ['minDiscount must be a number between 0 and 100'] });
      }
      conditions.push('d.discountPercentage >= ?');
      params.push(minDiscount);
    }

    const db = getDb();
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Summary and page share one read snapshot and exactly the same joins/filters.
    return db.transaction(() => {
      const countSql = `
        SELECT COUNT(*) AS count, COALESCE(AVG(d.discountPercentage), 0) AS avgDiscount,
          COALESCE(MAX(d.discountPercentage), 0) AS maxDiscount
        FROM dealsLog d
        JOIN listings l ON d.listingId = l.id
        JOIN trackedSearches s ON d.searchId = s.id
        ${whereClause}
      `;
      const summary = db.prepare(countSql).get(...params) as DealSummary;
      const total = summary.count;
      const totalPages = Math.ceil(total / limit) || 1;

      // Fetch paginated deals
      const querySql = `
        SELECT
          d.id,
          d.listingId,
          d.searchId,
          d.listingPrice,
          COALESCE(d.postage, l.postage) AS postage,
          COALESCE(d.estimatedDeliveredCost, l.estimatedDeliveredCost, d.listingPrice) AS estimatedDeliveredCost,
          d.baselineMarketPrice,
          d.discountPercentage,
          d.dealType,
          d.status,
          d.isActive,
          d.flaggedAt,
          l.title,
          l.url,
          l.imageUrl,
          l.location,
          l.sellerName,
          l.currency,
          l.platform,
          s.query as searchQuery,
          s.category
        FROM dealsLog d
        JOIN listings l ON d.listingId = l.id
        JOIN trackedSearches s ON d.searchId = s.id
        ${whereClause}
        ORDER BY d.discountPercentage DESC, d.id DESC
        LIMIT ? OFFSET ?
      `;

      const items = db.prepare(querySql).all(...params, limit, offset) as DealDto[];

      return NextResponse.json<DealsResponse>({
        success: true,
        data: items,
        summary,
        total,
        page,
        limit,
        totalPages,
      });
    })();
  } catch (error: unknown) {
    console.error('[API /api/deals] Error:', error);
    return errorResponse({ server: ['Internal server error fetching deals'] }, 500);
  }
}
