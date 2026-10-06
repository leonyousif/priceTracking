import type { TriggerResponse } from '@/lib/types';
import { errorResponse, readJsonBody } from '@/lib/api';
import { NextRequest, NextResponse } from 'next/server';
import { jobRunner } from '@/services/job-runner';
import { validateScrapeTrigger } from '@/lib/validation';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = await readJsonBody(request, true);
    if (!body.success) return errorResponse(body.errors);

    const validation = validateScrapeTrigger(body.data);
    if (!validation.success) {
      return errorResponse(validation.errors);
    }

    const { searchId } = validation.data;

    try {
      const jobId = await jobRunner.triggerJob(searchId);
      const admission = jobRunner.lastAdmission;
      const isDuplicate = admission?.jobId === jobId ? admission.isDuplicate : false;

      return NextResponse.json<TriggerResponse>(
        {
          success: true,
          jobId,
          status: admission?.jobId === jobId ? admission.status : 'pending',
          duplicate: isDuplicate,
          message:
            admission?.jobId === jobId
              ? admission.message
              : searchId
              ? `Scrape job enqueued for search #${searchId}`
              : 'Scrape job enqueued for all active searches',
        },
        { status: isDuplicate ? 200 : 202 }
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found')) {
        return errorResponse({ searchId: [msg] }, 404);
      }
      throw err;
    }
  } catch (error: unknown) {
    console.error('[API /api/scrape/trigger POST] Error:', error);
    return errorResponse({ server: ['Internal server error triggering scrape job'] }, 500);
  }
}
