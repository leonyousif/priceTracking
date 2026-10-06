'use client';

import type { SearchesResponse, CreateSearchResponse, UpdateSearchResponse, TriggerResponse } from '@/lib/types';

import React, { useState } from 'react';
import type { SearchSummaryDto } from '@/lib/types';
import { formatDate } from '@/lib/format';
import { TableState, TableScroll } from './TableState';
import { useApiResource, useApiMutation } from './useApiResource';
import { StatusBadge } from './StatusBadge';

interface SearchRowProps {
  search: SearchSummaryDto;
  onToggleActive: (id: number, currentActive: number) => void;
  onTriggerScrape: (id: number) => void;
}

function SearchRow(props: SearchRowProps) {
  function handleToggleClick() {
    props.onToggleActive(props.search.id, props.search.isActive);
  }

  function handleScrapeClick() {
    props.onTriggerScrape(props.search.id);
  }

  const toggleText = props.search.isActive === 1 ? 'Pause' : 'Activate';
  const toggleBtnClass =
    props.search.isActive === 1
      ? 'px-2 py-1 text-[11px] font-mono border border-slate-300 bg-white hover:bg-slate-100 text-slate-700 rounded'
      : 'px-2 py-1 text-[11px] font-mono border border-emerald-300 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 rounded';

  return (
    <tr className="border-b border-slate-200 hover:bg-slate-50 transition-colors text-xs">
      <td className="px-3 py-2.5 font-mono text-slate-500 whitespace-nowrap">
        #{props.search.id}
      </td>
      <td className="px-3 py-2.5 font-semibold text-slate-900">
        {props.search.query}
      </td>
      <td className="px-3 py-2.5 whitespace-nowrap">
        <span className="px-1.5 py-0.5 font-mono text-[11px] bg-slate-100 border border-slate-200 rounded text-slate-700">
          {props.search.category}
        </span>
      </td>
      <td className="px-3 py-2.5 text-slate-500 font-mono text-[11px] max-w-xs truncate">
        {props.search.negativeKeywords || '-'}
      </td>
      <td className="px-3 py-2.5 whitespace-nowrap">
        <StatusBadge status={props.search.isActive === 1 ? 'Active' : 'Paused'} />
      </td>
      <td className="px-3 py-2.5 text-right font-mono text-slate-800 whitespace-nowrap">
        {props.search.activeListingsCount} / {props.search.totalListingsCount}
      </td>
      <td className="px-3 py-2.5 text-right font-mono font-semibold text-emerald-700 whitespace-nowrap">
        {props.search.activeDealsCount}
      </td>
      <td className="px-3 py-2.5 font-mono text-slate-500 whitespace-nowrap">
        {formatDate(props.search.lastScrapedAt, 'Never')}
      </td>
      <td className="px-3 py-2.5 text-right whitespace-nowrap space-x-2">
        <button
          type="button"
          onClick={handleScrapeClick}
          className="px-2 py-1 text-[11px] font-mono border border-blue-300 bg-blue-50 hover:bg-blue-100 text-blue-800 rounded"
        >
          Scrape Now
        </button>
        <button
          type="button"
          onClick={handleToggleClick}
          className={toggleBtnClass}
        >
          {toggleText}
        </button>
      </td>
    </tr>
  );
}

export function SearchesView() {
  const mutate = useApiMutation();
  const { data, loading, error, refresh: loadSearches } = useApiResource<SearchesResponse>('/api/searches');
  const searches = data?.data ?? [];
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  // New Search Form State
  const [queryInput, setQueryInput] = useState<string>('');
  const [categoryInput, setCategoryInput] = useState<string>('GPU');
  const [negativeKeywordsInput, setNegativeKeywordsInput] = useState<string>('');
  const [formError, setFormError] = useState<string | null>(null);
  const [formSubmitting, setFormSubmitting] = useState<boolean>(false);

  function handleQueryChange(event: React.ChangeEvent<HTMLInputElement>) {
    setQueryInput(event.target.value);
  }

  function handleCategoryChange(event: React.ChangeEvent<HTMLInputElement>) {
    setCategoryInput(event.target.value);
  }

  function handleNegativeKeywordsChange(event: React.ChangeEvent<HTMLInputElement>) {
    setNegativeKeywordsInput(event.target.value);
  }

  function handleCreateSearch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!queryInput.trim()) {
      setFormError('Query string is required');
      return;
    }
    if (!categoryInput.trim()) {
      setFormError('Category is required');
      return;
    }

    setFormSubmitting(true);
    setFormError(null);

    void mutate<CreateSearchResponse>('/api/searches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: queryInput.trim(),
        category: categoryInput.trim(),
        negativeKeywords: negativeKeywordsInput.trim() || undefined,
        isActive: true,
      }),
    }, { success: (data) => {
        setQueryInput('');
        setNegativeKeywordsInput('');
        setActionNotice(`Tracked search "${data.data.query}" created successfully`);
        loadSearches();
      }, error: setFormError, settled: () => setFormSubmitting(false) });
  }

  function handleToggleActive(id: number, currentActive: number) {
    const nextActive = currentActive === 1 ? false : true;
    void mutate<UpdateSearchResponse>(`/api/searches/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: nextActive }),
    }, { success: () => {
        setActionNotice(`Search #${id} set to ${nextActive ? 'Active' : 'Paused'}`);
        loadSearches();
      }, error: message => setActionNotice(`Failed to update search #${id}: ${message}`) });
  }

  function handleTriggerScrape(id: number) {
    setActionNotice(`Initiating scrape job for search #${id}...`);
    void mutate<TriggerResponse>('/api/scrape/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ searchId: id }),
    }, { success: data => setActionNotice(`Scrape job #${data.jobId}: ${data.message}`),
      error: message => setActionNotice(`Could not trigger job: ${message}`) });
  }

  function renderSearchRow(item: SearchSummaryDto) {
    return (
      <SearchRow
        key={item.id}
        search={item}
        onToggleActive={handleToggleActive}
        onTriggerScrape={handleTriggerScrape}
      />
    );
  }

  const rows = searches.map(renderSearchRow);

  return (
    <div className="space-y-6">
      {actionNotice ? (
        <div role="status" className="bg-blue-50 border border-blue-200 text-blue-800 text-xs font-mono px-4 py-2 rounded flex items-center justify-between">
          <span>{actionNotice}</span>
          <span className="text-slate-400 text-[10px]">[INFO]</span>
        </div>
      ) : null}

      {/* Add Search Form */}
      <div className="bg-white border border-slate-200 rounded p-4 shadow-xs">
        <div className="text-xs font-mono uppercase font-semibold text-slate-700 mb-3">
          Configure New Target Search
        </div>
        <form onSubmit={handleCreateSearch} className="grid grid-cols-1 sm:grid-cols-4 gap-3">
          <div className="sm:col-span-2">
            <label htmlFor="searchesview-1" className="block text-[11px] font-mono text-slate-500 uppercase mb-1">
              Search Query *
            </label>
            <input id="searchesview-1"
              type="text"
              placeholder="e.g. RTX 4070 Ti, PS5 Digital"
              value={queryInput}
              onChange={handleQueryChange}
              className="w-full text-xs font-mono border border-slate-300 rounded px-2.5 py-1.5 bg-white text-slate-900"
              required
            />
          </div>

          <div>
            <label htmlFor="searchesview-2" className="block text-[11px] font-mono text-slate-500 uppercase mb-1">
              Category *
            </label>
            <input id="searchesview-2"
              type="text"
              placeholder="e.g. GPU, Console"
              value={categoryInput}
              onChange={handleCategoryChange}
              className="w-full text-xs font-mono border border-slate-300 rounded px-2.5 py-1.5 bg-white text-slate-900"
              required
            />
          </div>

          <div>
            <label htmlFor="searchesview-3" className="block text-[11px] font-mono text-slate-500 uppercase mb-1">
              Negative Keywords
            </label>
            <input id="searchesview-3"
              type="text"
              placeholder="e.g. box, broken, parts"
              value={negativeKeywordsInput}
              onChange={handleNegativeKeywordsChange}
              className="w-full text-xs font-mono border border-slate-300 rounded px-2.5 py-1.5 bg-white text-slate-900"
            />
          </div>

          <div className="sm:col-span-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 pt-2 border-t border-slate-100">
            {formError ? (
              <span role="alert" className="text-xs font-mono text-rose-600">{formError}</span>
            ) : (
              <span className="text-xs font-mono text-slate-400">
                Negative keywords will automatically filter false positives during anomaly detection.
              </span>
            )}
            <button
              type="submit"
              disabled={formSubmitting}
              className="px-4 py-1.5 text-xs font-mono font-semibold bg-slate-900 hover:bg-slate-800 text-white rounded shadow-xs disabled:opacity-50 shrink-0"
            >
              {formSubmitting ? 'Saving...' : 'Add Search Query'}
            </button>
          </div>
        </form>
      </div>

      {/* Tracked Searches Table */}
      <div className="bg-white border border-slate-200 rounded overflow-hidden shadow-xs">
        <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-mono uppercase font-semibold text-slate-700">
            Active Target Configurations ({searches.length} searches)
          </span>
          <button type="button" onClick={loadSearches} className="text-xs font-mono border border-slate-300 px-2 py-1 rounded">Refresh searches</button>
        </div>

        <TableScroll>
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-100 border-b border-slate-200 text-[11px] font-mono uppercase text-slate-600">
                <th className="px-3 py-2 font-semibold">ID</th>
                <th className="px-3 py-2 font-semibold">Query</th>
                <th className="px-3 py-2 font-semibold">Category</th>
                <th className="px-3 py-2 font-semibold">Negative Keywords</th>
                <th className="px-3 py-2 font-semibold">Status</th>
                <th className="px-3 py-2 font-semibold text-right">Listings (Available/Total)</th>
                <th className="px-3 py-2 font-semibold text-right">Active Deals</th>
                <th className="px-3 py-2 font-semibold">Last Scraped</th>
                <th className="px-3 py-2 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              <TableState columns={9} loading={loading} error={error} empty={searches.length === 0}
                loadingText="Loading tracked searches..." emptyText="No tracked searches configured. Add one using the form above.">
                {rows}
              </TableState>
            </tbody>
          </table>
        </TableScroll>
      </div>
    </div>
  );
}
