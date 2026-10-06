'use client';

import type { JobsResponse, TriggerResponse } from '@/lib/types';

import { useState } from 'react';
import type { JobDto } from '@/lib/types';
import { formatDate } from '@/lib/format';
import { TableState, TableScroll } from './TableState';
import { useApiResource, useApiMutation } from './useApiResource';
import { StatusBadge } from './StatusBadge';

interface JobRowProps {
  job: JobDto;
}

function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return '-';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function JobRow(props: JobRowProps) {
  const targetText =
    props.job.searchId !== null
      ? `Search #${props.job.searchId}`
      : 'All Active Searches';

  return (
    <tr className="border-b border-slate-200 hover:bg-slate-50 transition-colors text-xs font-mono">
      <td className="px-3 py-2.5 text-slate-500 whitespace-nowrap">
        #{props.job.id}
      </td>
      <td className="px-3 py-2.5 text-slate-900 whitespace-nowrap">
        {targetText}
      </td>
      <td className="px-3 py-2.5 whitespace-nowrap">
        <StatusBadge status={props.job.status} />
      </td>
      <td className="px-3 py-2.5 text-right font-semibold text-slate-800 whitespace-nowrap">
        {props.job.itemsScraped}
      </td>
      <td className="px-3 py-2.5 text-right font-semibold text-emerald-700 whitespace-nowrap">
        {props.job.dealsFound}
      </td>
      <td className="px-3 py-2.5 text-right text-slate-600 whitespace-nowrap">
        {formatDuration(props.job.durationMs)}
      </td>
      <td className="px-3 py-2.5 text-slate-500 whitespace-nowrap">
        {formatDate(props.job.startedAt, '-', 'seconds')}
      </td>
      <td className="px-3 py-2.5 text-slate-500 whitespace-nowrap">
        {formatDate(props.job.completedAt, '-', 'seconds')}
      </td>
      <td className="px-3 py-2.5 text-rose-600 max-w-xs truncate">
        {props.job.errorMessage || '-'}
      </td>
    </tr>
  );
}

export function JobsView() {
  const mutate = useApiMutation();
  const { data, loading, error, refresh: loadJobs } = useApiResource<JobsResponse>('/api/scrape/status?limit=25', {
    pollMs: 3000, shouldPoll: response => response.jobs.some(job => job.status === 'pending' || job.status === 'running' ||
      (job.status === 'cancelled' && !!job.leaseExpiresAt)),
  });
  const jobs = data?.jobs ?? [];
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [isTriggering, setIsTriggering] = useState<boolean>(false);

  function handleTriggerAllScrapes() {
    setIsTriggering(true);
    setActionNotice('Triggering scraper pipeline for all active searches...');

    void mutate<TriggerResponse>('/api/scrape/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }, { success: data => {
        setActionNotice(`Scrape job #${data.jobId}: ${data.message}`);
        loadJobs();
      }, error: message => setActionNotice(`Failed to trigger job: ${message}`),
      settled: () => setIsTriggering(false) });
  }

  function handleManualRefresh() {
    loadJobs();
  }

  function renderJobRow(job: JobDto) {
    return <JobRow key={job.id} job={job} />;
  }

  const rows = jobs.map(renderJobRow);

  return (
    <div className="space-y-6">
      {actionNotice ? (
        <div role="status" className="bg-blue-50 border border-blue-200 text-blue-800 text-xs font-mono px-4 py-2 rounded flex items-center justify-between">
          <span>{actionNotice}</span>
          <span className="text-slate-400 text-[10px]">[STATUS]</span>
        </div>
      ) : null}

      {/* Control Panel */}
      <div className="bg-white border border-slate-200 rounded p-4 flex flex-wrap items-center justify-between gap-4 shadow-xs">
        <div>
          <div className="text-xs font-mono uppercase font-semibold text-slate-700">
            Background Scrape Pipeline Controller
          </div>
          <div className="text-xs text-slate-500 font-mono mt-0.5">
            Polls 3s after each response while work is pending. Up to three targeted jobs can run at once for different searches; all-search jobs run alone. Each job reuses one browser session and waits up to 6s for results, an empty state or a challenge.
          </div>
        </div>

        <div className="flex items-center space-x-3">
          <button
            type="button"
            onClick={handleManualRefresh}
            className="px-3 py-1.5 text-xs font-mono border border-slate-300 bg-white hover:bg-slate-100 text-slate-700 rounded"
          >
            Refresh Queue
          </button>
          <button
            type="button"
            disabled={isTriggering}
            onClick={handleTriggerAllScrapes}
            className="px-4 py-1.5 text-xs font-mono font-semibold bg-slate-900 hover:bg-slate-800 text-white rounded shadow-xs disabled:opacity-50"
          >
            {isTriggering ? 'Dispatching...' : 'Run All Active Scrapers'}
          </button>
        </div>
      </div>

      {/* Jobs Log Table */}
      <div className="bg-white border border-slate-200 rounded overflow-hidden shadow-xs">
        <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-mono uppercase font-semibold text-slate-700">
            Recent Scrape Execution History ({jobs.length} executions)
          </span>
          <span className="text-xs font-mono text-slate-500">
            Source: SQLite / scrapeJobs
          </span>
        </div>

        <TableScroll>
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-100 border-b border-slate-200 text-[11px] font-mono uppercase text-slate-600">
                <th className="px-3 py-2 font-semibold">Job ID</th>
                <th className="px-3 py-2 font-semibold">Target</th>
                <th className="px-3 py-2 font-semibold">Status</th>
                <th className="px-3 py-2 font-semibold text-right">Items Ingested</th>
                <th className="px-3 py-2 font-semibold text-right">Active Deals at Finish</th>
                <th className="px-3 py-2 font-semibold text-right">Duration</th>
                <th className="px-3 py-2 font-semibold">Started At</th>
                <th className="px-3 py-2 font-semibold">Completed At</th>
                <th className="px-3 py-2 font-semibold">Diagnostic Error</th>
              </tr>
            </thead>
            <tbody>
              <TableState columns={9} loading={loading && !data} error={error} empty={jobs.length === 0}
                loadingText="Querying scrape execution jobs..." emptyText="No scrape jobs recorded yet.">
                {rows}
              </TableState>
            </tbody>
          </table>
        </TableScroll>
      </div>
    </div>
  );
}
