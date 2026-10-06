import type { SearchDetailResponse, UpdateSearchResponse, DeleteSearchResponse, SearchDto } from '@/lib/types';
import { errorResponse, readJsonBody } from '@/lib/api';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { validateUpdateTrackedSearch, parseId, parseBoolean } from '@/lib/validation';
import { jobRunner } from '@/services/job-runner';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }> | { id: string };
}

export async function GET(_request: NextRequest, context: RouteContext) {
  try {
    const { id: rawId } = await Promise.resolve(context.params);

    const searchId = parseId(rawId);
    if (searchId === undefined) {
      return errorResponse({ id: ['Invalid search ID'] });
    }

    const db = getDb();
    const search = db
      .prepare('SELECT * FROM trackedSearches WHERE id = ?')
      .get(searchId) as SearchDto | undefined;

    if (!search) {
      return errorResponse({ id: [`Tracked search ${searchId} not found`] }, 404);
    }

    const listingCount = (
      db
        .prepare('SELECT COUNT(*) as count FROM searchListings WHERE searchId = ?')
        .get(searchId) as { count: number }
    ).count;

    const activeDealsCount = (
      db
        .prepare('SELECT COUNT(*) as count FROM dealsLog WHERE searchId = ? AND isActive = 1')
        .get(searchId) as { count: number }
    ).count;

    const searchData = {
      ...search,
      listingCount,
      activeDealsCount,
    };

    return NextResponse.json<SearchDetailResponse>({
      success: true,
      data: searchData,
      search: searchData,
    });
  } catch (error: unknown) {
    console.error('[API /api/searches/[id] GET] Error:', error);
    return errorResponse({ server: ['Internal server error fetching tracked search'] }, 500);
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const { id: rawId } = await Promise.resolve(context.params);

    const searchId = parseId(rawId);
    if (searchId === undefined) {
      return errorResponse({ id: ['Invalid search ID'] });
    }

    const db = getDb();

    // Check if search exists
    const existing = db
      .prepare('SELECT * FROM trackedSearches WHERE id = ?')
      .get(searchId) as SearchDto | undefined;

    if (!existing) {
      return errorResponse({ id: [`Tracked search ${searchId} not found`] }, 404);
    }

    const body = await readJsonBody(request);
    if (!body.success) return errorResponse(body.errors);

    const validation = validateUpdateTrackedSearch(body.data);
    if (!validation.success) {
      return errorResponse(validation.errors);
    }

    const { query, category, negativeKeywords, isActive } = validation.data;

    // Check if there are fields to update
    const updates: string[] = [];
    const values: unknown[] = [];

    if (query !== undefined) {
      updates.push('query = ?');
      values.push(query);
    }
    if (category !== undefined) {
      updates.push('category = ?');
      values.push(category);
    }
    if (negativeKeywords !== undefined) {
      updates.push('negativeKeywords = ?');
      values.push(negativeKeywords);
    }
    if (isActive !== undefined) {
      updates.push('isActive = ?');
      values.push(isActive ? 1 : 0);
      if (!isActive) {
        jobRunner.cancelJobsForSearch(searchId, 'Tracked search was deactivated');
      }
    }

    if (updates.length === 0) {
      return errorResponse({ update: ['No valid fields provided for update'] });
    }

    updates.push("updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
    values.push(searchId);

    const updateQuery = `UPDATE trackedSearches SET ${updates.join(', ')} WHERE id = ?`;
    db.prepare(updateQuery).run(...values);

    const updated = db
      .prepare('SELECT * FROM trackedSearches WHERE id = ?')
      .get(searchId) as SearchDto;

    return NextResponse.json<UpdateSearchResponse>({
      success: true,
      data: updated,
      search: updated,
    });
  } catch (error: unknown) {
    console.error('[API /api/searches/[id] PATCH] Error:', error);
    return errorResponse({ server: ['Internal server error updating tracked search'] }, 500);
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const { id: rawId } = await Promise.resolve(context.params);

    const searchId = parseId(rawId);
    if (searchId === undefined) {
      return errorResponse({ id: ['Invalid search ID'] });
    }

    const db = getDb();

    // Check if search exists
    const existing = db
      .prepare('SELECT * FROM trackedSearches WHERE id = ?')
      .get(searchId) as SearchDto | undefined;

    if (!existing) {
      return errorResponse({ id: [`Tracked search ${searchId} not found`] }, 404);
    }

    const { searchParams } = new URL(request.url);
    const hardDelete = parseBoolean(searchParams.get('hard')) === true;

    if (hardDelete) {
      // Cancel active jobs for this search
      jobRunner.cancelJobsForSearch(searchId, 'Tracked search was permanently deleted');

      // Atomic hard cascade deletion
      const cascadeDeleteTx = db.transaction((id: number) => {
        db.prepare('DELETE FROM dealsLog WHERE searchId = ?').run(id);
        db.prepare('UPDATE scrapeJobs SET searchId = NULL WHERE searchId = ?').run(id);
        db.prepare('DELETE FROM searchListings WHERE searchId = ?').run(id);
        // Clean up orphaned listings that have no associations in searchListings
        db.prepare(`
          DELETE FROM priceHistory 
          WHERE listingId NOT IN (SELECT listingId FROM searchListings)
        `).run();
        db.prepare(`
          DELETE FROM listings 
          WHERE id NOT IN (SELECT listingId FROM searchListings)
        `).run();
        // Reassign legacy searchId column on remaining shared listings to another associated search
        db.prepare(`
          UPDATE listings
          SET searchId = (SELECT sl.searchId FROM searchListings sl WHERE sl.listingId = listings.id LIMIT 1)
          WHERE searchId = ?
        `).run(id);
        db.prepare('DELETE FROM trackedSearches WHERE id = ?').run(id);
      });

      cascadeDeleteTx(searchId);

      return NextResponse.json<DeleteSearchResponse>({
        success: true,
        message: `Tracked search ${searchId} and all associated data permanently deleted.`,
        mode: 'hard',
      });
    } else {
      // Soft delete: set isActive = 0 and cancel active jobs
      jobRunner.cancelJobsForSearch(searchId, 'Tracked search was deactivated');

      db.prepare(`
        UPDATE trackedSearches
        SET isActive = 0,
            updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?
      `).run(searchId);

      return NextResponse.json<DeleteSearchResponse>({
        success: true,
        message: `Tracked search ${searchId} deactivated (soft-deleted). Historical price data preserved.`,
        mode: 'soft',
      });
    }
  } catch (error: unknown) {
    console.error('[API /api/searches/[id] DELETE] Error:', error);
    return errorResponse({ server: ['Internal server error deleting tracked search'] }, 500);
  }
}
