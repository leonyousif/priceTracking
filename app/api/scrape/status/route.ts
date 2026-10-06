import type { JobsResponse, JobResponse, JobDto, ScrapeJob } from '@/lib/types';
import { errorResponse } from '@/lib/api';
import { NextRequest, NextResponse } from 'next/server';
import { jobRunner } from '@/services/job-runner';
import { parseId } from '@/lib/validation';

export const dynamic = 'force-dynamic';

function formatJob(job: ScrapeJob): JobDto {
  let durationMs: number | null = null;
  if (job.startedAt && job.completedAt) {
    durationMs = Math.max(
      0,
      new Date(job.completedAt).getTime() - new Date(job.startedAt).getTime()
    );
  }

  return {
    ...job,
    ownerId: job.ownerId ?? null,
    claimedAt: job.claimedAt ?? null,
    heartbeatAt: job.heartbeatAt ?? null,
    leaseExpiresAt: job.leaseExpiresAt ?? null,
    durationMs,
  };
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const jobIdParam = searchParams.get('jobId');

    if (jobIdParam) {
      const jobId = parseId(jobIdParam);
      if (jobId === undefined) {
        return errorResponse({ jobId: ['jobId must be a positive integer'] });
      }

      jobRunner.start();
      const job = jobRunner.getJobStatus(jobId);

      if (!job) {
        return errorResponse({ jobId: [`Job #${jobId} not found`] }, 404);
      }

      return NextResponse.json<JobResponse>({
        success: true,
        job: formatJob(job),
      });
    }

    const limitParam = searchParams.get('limit');
    const parsedLimit = limitParam ? parseId(limitParam) : 10;
    if (parsedLimit === undefined) return errorResponse({ limit: ['limit must be a positive safe integer'] });
    const limit = Math.min(parsedLimit, 50);
    jobRunner.start();
    const recentJobs = jobRunner.getRecentJobs(limit).map((j) => formatJob(j));

    return NextResponse.json<JobsResponse>({
      success: true,
      jobs: recentJobs,
    });
  } catch (error: unknown) {
    console.error('[API /api/scrape/status GET] Error:', error);
    return errorResponse({ server: ['Internal server error fetching scrape status'] }, 500);
  }
}
