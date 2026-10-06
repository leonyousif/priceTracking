/**
 * Background Job Runner Service
 * Manages asynchronous scraping tasks with SQLite-backed durable queue,
 * atomic job claiming, process-safe concurrency control, lease renewal/stale worker recovery,
 * overlap coordination, hard deletion safety, and isolated browser profile directories.
 */

import path from 'path';
import os from 'node:os';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { getDb } from '../lib/db';
import { ScrapeJob, ScrapeJobStatus, TrackedSearch, TriggerJobAdmissionResult } from '../lib/types';
import { EbayScraper } from './scrapers/ebay';
import { BaseMarketplaceScraper } from './scrapers/base';
import { runSearchWorkflow } from './search-workflow';
import { assertOwnedPath } from '../lib/owned-path';
import { createOwnedProfile, removeOwnedProfile } from '../lib/owned-profile';

export interface ClaimedJob {
  id: number;
  searchId: number | null;
  ownerId: string;
  attemptId: string;
}

export interface JobRunnerOptions {
  profileRoot?: string;
  scraperFactory?: () => BaseMarketplaceScraper;
  maxConcurrent?: number;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
  ownerId?: string;
  now?: () => Date;
  db?: Database.Database;
  autoStart?: boolean;
  autoPump?: boolean;
}

interface JobCompletion {
  status?: Exclude<ScrapeJobStatus, 'pending' | 'running'>;
  itemsScraped?: number;
  errorMessage?: string | null;
}

export class JobRunnerService {
  private static instance: JobRunnerService | null = null;
  public lastAdmission?: TriggerJobAdmissionResult;

  private maxConcurrent: number;
  private leaseDurationMs: number;
  private heartbeatIntervalMs: number;
  private pollIntervalMs: number;
  private ownerId: string;
  private now: () => Date;
  private customDb?: Database.Database;
  private scraperFactory: () => BaseMarketplaceScraper;
  private profileRoot: string;
  private autoPump: boolean;

  private activeWorkers = 0;
  private workerPromises: Map<number, Promise<void>> = new Map();
  private abortControllers: Map<number, AbortController> = new Map();
  private heartbeatTimers: Map<number, NodeJS.Timeout> = new Map();
  private pollTimer: NodeJS.Timeout | null = null;
  private cleanupFailures: Error[] = [];
  private stopped = false;

  constructor(options: JobRunnerOptions = {}) {
    this.scraperFactory = options.scraperFactory ?? (() => new EbayScraper());
    this.maxConcurrent = options.maxConcurrent ?? 3;
    this.leaseDurationMs = options.leaseDurationMs ?? 30000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10000;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.ownerId = options.ownerId ?? `runner-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    this.now = options.now ?? (() => new Date());
    this.customDb = options.db;
    this.autoPump = options.autoPump ?? true;

    this.profileRoot =
      options.profileRoot ??
      process.env.BROWSER_PROFILE_ROOT ??
      path.join(os.tmpdir(), 'price-tracking-profiles');

    if (process.env.TEST_RUN_ROOT) {
      assertOwnedPath(process.env.TEST_RUN_ROOT, this.profileRoot);
    }

    if (options.autoStart) {
      this.start();
    }
  }

  public static getInstance(): JobRunnerService {
    if (!JobRunnerService.instance) {
      JobRunnerService.instance = new JobRunnerService();
    }
    return JobRunnerService.instance;
  }

  public static resetInstance(): void {
    if (JobRunnerService.instance) {
      JobRunnerService.instance.stop();
      JobRunnerService.instance = null;
    }
  }

  private getDb(): Database.Database {
    return this.customDb ?? getDb();
  }

  private getTime(): Date {
    return this.now();
  }

  private getIsoTime(d?: Date): string {
    return (d ?? this.getTime()).toISOString();
  }

  /**
   * Starts background worker loop and recovers stale jobs.
   */
  public start(): void {
    if (this.pollTimer) return;
    this.stopped = false;
    this.recoverStaleJobs();
    this.pump();

    this.pollTimer = setInterval(() => {
      try {
        this.recoverStaleJobs();
        this.pump();
      } catch {
        // Silently handle transient errors during shutdown/poll
      }
    }, this.pollIntervalMs);

    if (this.pollTimer.unref) {
      this.pollTimer.unref();
    }
  }

  /**
   * Stops admission and aborts local work. Resource leases continue until cleanup.
   */
  public stop(): void {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const controller of this.abortControllers.values()) controller.abort();
  }

  /**
   * Sets a custom scraper factory for testing or alternative scraper implementations.
   */
  public setScraperFactory(factory: () => BaseMarketplaceScraper): void {
    this.scraperFactory = factory;
  }

  /**
   * Resets the scraper factory to the default EbayScraper.
   */
  public resetScraperFactory(): void {
    this.scraperFactory = () => new EbayScraper();
  }

  /**
   * Recovers stale jobs left running by crashed/interrupted workers whose lease expired.
   * Jobs with a live valid lease are never touched.
   */
  public recoverStaleJobs(): number {
    const db = this.getDb();
    const nowIso = this.getIsoTime();

    const recoverTx = db.transaction(() => {
      const stale = db
        .prepare(
          `
        SELECT id, ownerId, leaseExpiresAt FROM scrapeJobs
        WHERE status = 'running'
          AND (leaseExpiresAt IS NULL OR leaseExpiresAt <= ?)
      `
        )
        .all(nowIso) as { id: number; ownerId: string | null; leaseExpiresAt: string | null }[];

      const updateStmt = db.prepare(`
        UPDATE scrapeJobs
        SET status = 'pending',
            ownerId = NULL,
            attemptId = NULL,
            claimedAt = NULL,
            heartbeatAt = NULL,
            leaseExpiresAt = NULL,
            errorMessage = CASE
              WHEN errorMessage IS NULL THEN 'Recovered from interrupted running worker'
              ELSE errorMessage || '; Recovered from interrupted running worker'
            END
        WHERE id = ? AND status = 'running'\n      `);

      let count = 0;
      for (const row of stale) {
        const res = updateStmt.run(row.id);
        count += res.changes;
      }
      // Cancelled work never resumes; a crashed cleanup owner eventually releases its slot.
      db.prepare(`UPDATE scrapeJobs SET leaseExpiresAt = NULL
        WHERE status = 'cancelled' AND leaseExpiresAt <= ?`).run(nowIso);
      return count;
    });

    return recoverTx.immediate();
  }

  /**
   * Atomically claims the next eligible pending job in SQLite.
   * Respects global concurrency limit across processes and prevents overlapping
   * searches (all-search vs targeted) from running concurrently.
   */
  public claimNextJob(): ClaimedJob | null {
    if (this.stopped) return null;
    if (this.activeWorkers >= this.maxConcurrent) return null;

    const db = this.getDb();
    const now = this.getTime();
    const nowIso = this.getIsoTime(now);
    const leaseExpiresIso = this.getIsoTime(new Date(now.getTime() + this.leaseDurationMs));

    const claimTx = db.transaction(() => {
      // 1. Recover stale jobs first
      this.recoverStaleJobs();

      // 2. Enforce global concurrency bound across all processes
      const running = db
        .prepare(
          `
        SELECT id, searchId FROM scrapeJobs
        WHERE (status IN ('running', 'cancelled') AND leaseExpiresAt > ?)
          OR (status = 'failed' AND leaseExpiresAt IS NOT NULL)
      `
        )
        .all(nowIso) as { id: number; searchId: number | null }[];

      if (running.length >= this.maxConcurrent) {
        return null;
      }

      const runningAll = running.some((r) => r.searchId === null);
      const runningSearchIds = new Set(
        running.map((r) => r.searchId).filter((s): s is number => s !== null)
      );

      // 3. Find candidates in pending status ordered by id ASC
      const pending = db
        .prepare(
          `
        SELECT id, searchId FROM scrapeJobs
        WHERE status = 'pending'
        ORDER BY id ASC
      `
        )
        .all() as { id: number; searchId: number | null }[];

      for (const candidate of pending) {
        if (this.workerPromises.has(candidate.id)) continue;
        // Coordination: Overlapping requests cannot process the same search concurrently
        if (candidate.searchId === null) {
          // An all-search job covers all active searches; cannot run if ANY job is currently running
          if (running.length > 0) continue;
        } else {
          // A targeted job cannot run if an all-search job is running or the same search is running
          if (runningAll || runningSearchIds.has(candidate.searchId)) continue;
        }

        // Claim candidate atomically
        const attemptId = crypto.randomUUID();
        const claimRes = db
          .prepare(
            `
          UPDATE scrapeJobs
          SET status = 'running',
              ownerId = ?,
              attemptId = ?,
              claimedAt = ?,
              startedAt = COALESCE(startedAt, ?),
              heartbeatAt = ?,
              leaseExpiresAt = ?
          WHERE id = ? AND status = 'pending'
        `
          )
          .run(this.ownerId, attemptId, nowIso, nowIso, nowIso, leaseExpiresIso, candidate.id);

        if (claimRes.changes > 0) {
          const claim = {
            id: candidate.id,
            searchId: candidate.searchId,
            ownerId: this.ownerId,
            attemptId,
          };
          return claim;
        }
      }

      return null;
    });

    return claimTx.immediate();
  }

  /**
   * Evaluates admission for a scrape request under immediate transaction.
   * Returns consistent duplicate-admission outcome if an active job already covers the search.
   */
  public async triggerJobWithAdmission(
    searchId?: number | null
  ): Promise<TriggerJobAdmissionResult> {
    const db = this.getDb();
    const nowIso = this.getIsoTime();

    const admissionTx = db.transaction((): TriggerJobAdmissionResult => {
      if (searchId !== undefined && searchId !== null) {
        const search = db
          .prepare('SELECT id FROM trackedSearches WHERE id = ?')
          .get(searchId);
        if (!search) {
          throw new Error(`Tracked search with id ${searchId} not found`);
        }

        // Duplicate admission check: active job for searchId or active all-search job
        const existing = db
          .prepare(
            `
          SELECT id, status, searchId FROM scrapeJobs
          WHERE (searchId = ? OR searchId IS NULL)
            AND (status IN ('pending', 'running') OR (status = 'cancelled' AND leaseExpiresAt > ?)
              OR (status = 'failed' AND leaseExpiresAt IS NOT NULL))
          ORDER BY id ASC
          LIMIT 1
        `
          )
          .get(searchId, nowIso) as { id: number; status: ScrapeJobStatus; searchId: number | null } | undefined;

        if (existing) {
          return {
            jobId: existing.id,
            status: existing.status,
            isDuplicate: true,
            message:
              existing.searchId === null
                ? `All-search scrape job #${existing.id} already covers search #${searchId}`
                : `Scrape job #${existing.id} already active for search #${searchId}`,
          };
        }

        const res = db
          .prepare(
            `
          INSERT INTO scrapeJobs (searchId, status, itemsScraped, dealsFound, startedAt)
          VALUES (?, 'pending', 0, 0, ?)
        `
          )
          .run(searchId, nowIso);

        const jobId = Number(res.lastInsertRowid);
        return {
          jobId,
          status: 'pending',
          isDuplicate: false,
          message: `Scrape job #${jobId} enqueued for search #${searchId}`,
        };
      } else {
        // All-searches duplicate admission check
        const existing = db
          .prepare(
            `
          SELECT id, status FROM scrapeJobs
          WHERE searchId IS NULL
            AND (status IN ('pending', 'running') OR (status = 'cancelled' AND leaseExpiresAt > ?)
              OR (status = 'failed' AND leaseExpiresAt IS NOT NULL))
          ORDER BY id ASC
          LIMIT 1
        `
          )
          .get(nowIso) as { id: number; status: ScrapeJobStatus } | undefined;

        if (existing) {
          return {
            jobId: existing.id,
            status: existing.status,
            isDuplicate: true,
            message: `Scrape job #${existing.id} already active for all searches`,
          };
        }

        const res = db
          .prepare(
            `
          INSERT INTO scrapeJobs (searchId, status, itemsScraped, dealsFound, startedAt)
          VALUES (NULL, 'pending', 0, 0, ?)
        `
          )
          .run(nowIso);

        const jobId = Number(res.lastInsertRowid);
        return {
          jobId,
          status: 'pending',
          isDuplicate: false,
          message: `Scrape job #${jobId} enqueued for all active searches`,
        };
      }
    });

    const admission = admissionTx.immediate();
    this.lastAdmission = admission;
    if (this.autoPump && !this.stopped) {
      this.pump();
    }
    return admission;
  }

  /**
   * Enqueues a scraping job and returns the jobId immediately.
   */
  public async triggerJob(searchId?: number | null): Promise<number> {
    const admission = await this.triggerJobWithAdmission(searchId);
    return admission.jobId;
  }

  /**
   * Retrieves status and metrics for a specific job from SQLite.
   */
  public getJobStatus(jobId: number): ScrapeJob | null {
    const db = this.getDb();
    const row = db
      .prepare('SELECT * FROM scrapeJobs WHERE id = ?')
      .get(jobId) as ScrapeJob | undefined;

    return row || null;
  }

  /**
   * Retrieves the most recent scrape jobs.
   */
  public getRecentJobs(limit = 10): ScrapeJob[] {
    const db = this.getDb();
    const safeLimit = Math.min(Math.max(limit, 1), 50);
    return db
      .prepare('SELECT * FROM scrapeJobs ORDER BY id DESC LIMIT ?')
      .all(safeLimit) as ScrapeJob[];
  }

  /**
   * Cancels a pending or running job.
   */
  public cancelJob(jobId: number, reason = 'Job was cancelled'): boolean {
    const db = this.getDb();
    const nowIso = this.getIsoTime();

    const cancelTx = db.transaction(() => {
      const job = db
        .prepare('SELECT status FROM scrapeJobs WHERE id = ?')
        .get(jobId) as { status: string } | undefined;
      if (!job || (job.status !== 'pending' && job.status !== 'running')) {
        return false;
      }

      db.prepare(
        `
        UPDATE scrapeJobs
        SET status = 'cancelled',
            errorMessage = ?,
            completedAt = ?,
            dealsFound = (SELECT COUNT(*) FROM dealsLog d WHERE d.status = 'ACTIVE' AND
              ((scrapeJobs.searchId IS NOT NULL AND d.searchId = scrapeJobs.searchId) OR
              (scrapeJobs.searchId IS NULL AND EXISTS (SELECT 1 FROM trackedSearches s WHERE s.id = d.searchId AND s.isActive = 1)))),
            leaseExpiresAt = CASE WHEN status = 'pending' THEN NULL ELSE leaseExpiresAt END
        WHERE id = ?
      `
      ).run(reason, nowIso, jobId);

      return true;
    });

    const changed = cancelTx.immediate();
    if (changed) {
      const ac = this.abortControllers.get(jobId);
      if (ac) ac.abort();
    }
    return changed;
  }

  /**
   * Cancels all pending and running jobs for a specific search ID, coordinating with deletion.
   */
  public cancelJobsForSearch(searchId: number, reason = 'Tracked search was deleted'): number {
    const db = this.getDb();
    const nowIso = this.getIsoTime();

    const cancelTx = db.transaction(() => {
      const activeJobs = db
        .prepare(
          `
        SELECT id FROM scrapeJobs
        WHERE searchId = ? AND status IN ('pending', 'running')
      `
        )
        .all(searchId) as { id: number }[];

      if (activeJobs.length === 0) return 0;

      db.prepare(
        `
        UPDATE scrapeJobs
        SET status = 'cancelled',
            errorMessage = ?,
            completedAt = ?,
            dealsFound = (SELECT COUNT(*) FROM dealsLog d WHERE d.searchId = scrapeJobs.searchId AND d.status = 'ACTIVE'),
            leaseExpiresAt = CASE WHEN status = 'pending' THEN NULL ELSE leaseExpiresAt END
        WHERE searchId = ? AND status IN ('pending', 'running')
      `
      ).run(reason, nowIso, searchId);

      for (const job of activeJobs) {
        const ac = this.abortControllers.get(job.id);
        if (ac) ac.abort();
      }

      return activeJobs.length;
    });

    return cancelTx.immediate();
  }

  /**
   * Checks whether a job has been cancelled.
   */
  public isJobCancelled(jobId: number): boolean {
    const db = this.getDb();
    const row = db
      .prepare('SELECT status FROM scrapeJobs WHERE id = ?')
      .get(jobId) as { status: string } | undefined;
    return !row || row.status === 'cancelled';
  }

  /**
   * Pumps available worker slots to claim and execute pending jobs.
   */
  public pump(): void {
    if (this.stopped) return;

    while (this.activeWorkers < this.maxConcurrent) {
      const claim = this.claimNextJob();
      if (!claim) break;

      this.activeWorkers++;
      const abortController = new AbortController();
      this.abortControllers.set(claim.id, abortController);

      const promise = this.executeJob(claim, abortController.signal)
        .catch((err) => {
          console.error(`[JobRunner] Unhandled error in job ${claim.id}:`, err);
        })
        .finally(() => {
          this.activeWorkers--;
          this.workerPromises.delete(claim.id);
          this.abortControllers.delete(claim.id);
          this.clearHeartbeat(claim.id);
          this.pump();
        });

      this.workerPromises.set(claim.id, promise);
    }
  }

  /**
   * Pumps the queue and waits until currently spawned workers have completed.
   */
  public async pumpQueue(): Promise<void> {
    this.pump();
    while (this.workerPromises.size > 0) {
      await Promise.all(Array.from(this.workerPromises.values()));
    }
  }

  /**
   * Complete a manually claimed job without a browser. Executing workers finalize after cleanup.
   */
  public completeJob(
    claim: ClaimedJob,
    options: JobCompletion = {}
  ): boolean {
    if (this.workerPromises.has(claim.id)) throw new Error('Worker must finish browser cleanup before completion');
    return this.finalizeClaim(claim, options);
  }

  /** The same live-attempt predicate fences observations, heartbeats and terminal writes. */
  private canWrite(claim: ClaimedJob): boolean {
    return !!this.getDb().prepare(`SELECT 1 FROM scrapeJobs
      WHERE id = ? AND ownerId = ? AND attemptId = ? AND status = 'running' AND leaseExpiresAt > ?`)
      .get(claim.id, claim.ownerId, claim.attemptId, this.getIsoTime());
  }

  private finalizeClaim(claim: ClaimedJob, options: JobCompletion, releaseResources = true, searchIds?: number[]): boolean {
    if (claim.ownerId !== this.ownerId) return false;
    const db = this.getDb();
    const nowIso = this.getIsoTime();
    return db.transaction(() => {
      const scope = searchIds ?? (claim.searchId === null
        ? (db.prepare('SELECT id FROM trackedSearches WHERE isActive = 1').all() as { id: number }[]).map(row => row.id)
        : [claim.searchId]);
      const dealsFound = scope.length === 0 ? 0
        : (db.prepare(`SELECT COUNT(*) AS n FROM dealsLog WHERE status = 'ACTIVE'
            AND searchId IN (${scope.map(() => '?').join(',')})`).get(...scope) as { n: number }).n;
      const changed = db.prepare(`UPDATE scrapeJobs
        SET status = CASE WHEN status = 'cancelled' AND ? THEN 'cancelled' ELSE ? END,
            errorMessage = CASE WHEN status = 'cancelled' AND ? THEN errorMessage ELSE ? END,
            itemsScraped = ?, dealsFound = ?, completedAt = ?,
            leaseExpiresAt = CASE WHEN ? THEN NULL ELSE leaseExpiresAt END
        WHERE id = ? AND ownerId = ? AND attemptId = ?
          AND status IN ('running', 'cancelled') AND leaseExpiresAt > ?`)
        .run(Number(releaseResources), options.status ?? 'completed', Number(releaseResources),
          options.errorMessage ?? null, options.itemsScraped ?? 0, dealsFound, nowIso,
          Number(releaseResources), claim.id, claim.ownerId, claim.attemptId, nowIso).changes;
      return changed > 0;
    }).immediate();
  }

  private startHeartbeat(claim: ClaimedJob): void {
    const jobId = claim.id;
    this.clearHeartbeat(jobId);
    const timer = setInterval(() => {
      try {
        const db = this.getDb();
        const now = this.getTime();
        const nowIso = this.getIsoTime(now);
        const leaseExpiresIso = this.getIsoTime(new Date(now.getTime() + this.leaseDurationMs));

        const changed = db.prepare(
          `
          UPDATE scrapeJobs
          SET heartbeatAt = ?,
              leaseExpiresAt = ?
          WHERE id = ? AND ownerId = ? AND attemptId = ?
            AND status IN ('running', 'cancelled') AND leaseExpiresAt > ?
        `
        ).run(nowIso, leaseExpiresIso, jobId, claim.ownerId, claim.attemptId, nowIso).changes;
        if (!changed || this.isJobCancelled(jobId)) this.abortControllers.get(jobId)?.abort();
        if (!changed) this.clearHeartbeat(jobId);
      } catch {
        // Silently ignore transient errors during db close
      }
    }, this.heartbeatIntervalMs);

    if (timer.unref) {
      timer.unref();
    }
    this.heartbeatTimers.set(jobId, timer);
  }

  private clearHeartbeat(jobId: number): void {
    const timer = this.heartbeatTimers.get(jobId);
    if (timer) {
      clearInterval(timer);
      this.heartbeatTimers.delete(jobId);
    }
  }

  /**
   * Executes a claimed scrape job inside an isolated browser profile.
   */
  private async executeJob(claim: ClaimedJob, signal: AbortSignal): Promise<void> {
    const db = this.getDb();
    const { id: jobId, searchId } = claim;

    this.startHeartbeat(claim);

    let profileDir: string | null = null;
    let scraper: BaseMarketplaceScraper | null = null;

    let totalItemsScraped = 0;
    let searchIds = searchId === null
      ? (db.prepare('SELECT id FROM trackedSearches WHERE isActive = 1').all() as { id: number }[]).map(row => row.id)
      : [searchId];
    let jobStatus: ScrapeJobStatus = 'completed';
    let jobErrorMessage: string | null = null;

    try {
      profileDir = createOwnedProfile(this.profileRoot, `job-${jobId}-`);
      if (signal.aborted || !this.canWrite(claim)) {
        jobStatus = 'cancelled';
        jobErrorMessage = 'Job was cancelled before execution';
        return;
      }

      scraper = this.scraperFactory();

      // Determine searches to execute
      let searches: TrackedSearch[] = [];
      if (searchId !== null) {
        const search = db
          .prepare('SELECT * FROM trackedSearches WHERE id = ? AND isActive = 1')
          .get(searchId) as TrackedSearch | undefined;
        if (search) searches.push(search);
      } else {
        searches = db
          .prepare('SELECT * FROM trackedSearches WHERE isActive = 1')
          .all() as TrackedSearch[];
      }
      searchIds = searchId === null ? searches.map(search => search.id) : [searchId];

      if (searchId !== null && searches.length === 0) {
        jobStatus = 'cancelled';
        jobErrorMessage = `Tracked search ${searchId} was deleted before execution`;
        return;
      }

      if (searches.length > 0) {
        await scraper.openSession({ query: searches[0].query, userDataDir: profileDir, signal });
      }

      for (const search of searches) {
        if (signal.aborted || !this.canWrite(claim)) {
          jobStatus = 'cancelled';
          jobErrorMessage = 'Job was cancelled';
          break;
        }
        if (!db.prepare('SELECT id FROM trackedSearches WHERE id = ? AND isActive = 1').get(search.id)) {
          if (searchId === null) continue;
          jobStatus = 'cancelled';
          jobErrorMessage = 'Search was deleted before scraping';
          break;
        }
        const outcome = await runSearchWorkflow({
          search, scraper,
          options: { maxPages: 1, userDataDir: profileDir, signal },
          canWrite: () => this.canWrite(claim),
        });
        totalItemsScraped += outcome.itemsScraped;
        if (outcome.status !== 'completed') {
          // Deactivation skips just this search in a bulk run, leaving other searches eligible.
          if (searchId === null && this.canWrite(claim) && !signal.aborted &&
              !db.prepare('SELECT 1 FROM trackedSearches WHERE id = ? AND isActive = 1').get(search.id)) continue;
          jobStatus = outcome.status;
          jobErrorMessage = outcome.errorMessage;
          break;
        }
      }

    } catch (err: unknown) {
      jobStatus = signal.aborted ? 'cancelled' : 'failed';
      jobErrorMessage = err instanceof Error ? err.message : String(err);
    } finally {
      let cleaned = true;
      // The job owns the browser. Close it before removing only this run's profile.
      try {
        if (scraper) await scraper.closeSession();
      } catch (error) {
        console.error(`[JobRunner] Browser closure failed for job ${jobId}:`, error);
        this.cleanupFailures.push(error as Error);
        cleaned = false;
        jobStatus = 'failed';
        jobErrorMessage = `Browser closure failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      try {
        if (profileDir && cleaned) await removeOwnedProfile(this.profileRoot, profileDir);
      } catch (error) {
        console.error(`[JobRunner] Profile cleanup failed for job ${jobId}:`, error);
        this.cleanupFailures.push(error as Error);
        cleaned = false;
        jobStatus = 'failed';
        jobErrorMessage = `Profile cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      // Failed cleanup retains durable capacity; obsolete attempts cannot publish any outcome.
      this.finalizeClaim(claim, { status: jobStatus, itemsScraped: totalItemsScraped,
        errorMessage: jobErrorMessage }, cleaned, searchIds);
      this.clearHeartbeat(jobId);
    }
  }

  /**
   * Waits for a job to reach a terminal status ('completed', 'failed', 'blocked', 'cancelled')
   * and awaits full profile cleanup.
   */
  public async waitForJob(
    jobId: number,
    timeoutMs = 10000,
    pollIntervalMs = 40
  ): Promise<ScrapeJob> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const job = this.getJobStatus(jobId);
      if (job && job.status !== 'pending' && job.status !== 'running') {
        const workerPromise = this.workerPromises.get(jobId);
        if (workerPromise) {
          await workerPromise;
        }
        if (this.cleanupFailures.length > 0) {
          throw this.cleanupFailures.shift()!;
        }
        const final = this.getJobStatus(jobId)!;
        if (!final.leaseExpiresAt) return final;
        if (final.status === 'failed') throw new Error(final.errorMessage || 'Browser cleanup requires attention');
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    throw new Error(`Timed out waiting for job #${jobId}`);
  }

  /**
   * Drains all queued jobs and active workers before database closure.
   */
  public async waitForIdle(): Promise<void> {
    this.pump();
    while (this.activeWorkers > 0 || this.workerPromises.size > 0) {
      if (this.workerPromises.size > 0) {
        await Promise.all(Array.from(this.workerPromises.values()));
      } else {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    if (this.cleanupFailures.length > 0) {
      throw this.cleanupFailures.shift()!;
    }
  }
}

export const jobRunner = JobRunnerService.getInstance();
