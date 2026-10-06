import type { SearchesResponse, SearchOptionsResponse, SearchOption, CreateSearchResponse, SearchSummaryDto, SearchDto } from '@/lib/types';
import { errorResponse, readJsonBody } from '@/lib/api';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { validateCreateTrackedSearch, parseBoolean } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const db = getDb();
    const { searchParams } = new URL(request.url);

    const activeOnlyParam = searchParams.get('activeOnly');
    const activeOnly = parseBoolean(activeOnlyParam);

    let whereClause = '';
    const params: (string | number)[] = [];

    if (activeOnly) {
      whereClause = 'WHERE s.isActive = 1';
    }

    const projection = searchParams.get('projection');
    if (projection && projection !== 'options') return errorResponse({ projection: ['projection must be options'] });
    if (projection === 'options') {
      const data = db.prepare(`SELECT s.id, s.query FROM trackedSearches s ${whereClause} ORDER BY s.id ASC`).all() as SearchOption[];
      return NextResponse.json<SearchOptionsResponse>({ success: true, data });
    }

    const sql = `
      SELECT
        s.id,
        s.query,
        s.category,
        s.negativeKeywords,
        s.isActive,
        s.createdAt,
        s.updatedAt,
        s.lastScrapedAt,
        (SELECT COUNT(*) FROM searchListings sl JOIN listings l ON sl.listingId = l.id WHERE sl.searchId = s.id AND l.isActive = 1 AND l.isSold = 0) as activeListingsCount,
        (SELECT COUNT(*) FROM searchListings WHERE searchId = s.id) as totalListingsCount,
        (SELECT COUNT(*) FROM dealsLog WHERE searchId = s.id AND status = 'ACTIVE') as activeDealsCount
      FROM trackedSearches s
      ${whereClause}
      ORDER BY s.id ASC
    `;

    const searches = db.prepare(sql).all(...params) as SearchSummaryDto[];

    return NextResponse.json<SearchesResponse>({
      success: true,
      data: searches,
    });
  } catch (error: unknown) {
    console.error('[API /api/searches GET] Error:', error);
    return errorResponse({ server: ['Internal server error fetching tracked searches'] }, 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await readJsonBody(request);
    if (!body.success) return errorResponse(body.errors);

    const validation = validateCreateTrackedSearch(body.data);
    if (!validation.success) {
      return errorResponse(validation.errors);
    }

    const db = getDb();
    const { query, category, negativeKeywords, isActive } = validation.data;

    const stmt = db.prepare(`
      INSERT INTO trackedSearches (query, category, negativeKeywords, isActive)
      VALUES (?, ?, ?, ?)
    `);

    const result = stmt.run(
      query,
      category,
      negativeKeywords ?? null,
      isActive ? 1 : 0
    );

    const newId = Number(result.lastInsertRowid);
    const createdSearch = db
      .prepare('SELECT * FROM trackedSearches WHERE id = ?')
      .get(newId) as SearchDto;

    return NextResponse.json<CreateSearchResponse>(
      { success: true, data: createdSearch },
      { status: 201 }
    );
  } catch (error: unknown) {
    console.error('[API /api/searches POST] Error:', error);
    return errorResponse({ server: ['Internal server error creating tracked search'] }, 500);
  }
}
