/** Next invokes this at server startup, independently of incoming scrape requests. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || process.env.NEXT_PHASE === 'phase-production-build') return;
  const { jobRunner } = await import('./services/job-runner');
  jobRunner.start();
}
