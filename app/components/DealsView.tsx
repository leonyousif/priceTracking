'use client';

import React, { useState } from 'react';
import type { DealDto, DealsResponse } from '@/lib/types';
import { formatDate, formatCurrency } from '@/lib/format';
import { TableState, TableScroll } from './TableState';
import { useApiResource } from './useApiResource';
import { StatusBadge } from './StatusBadge';
import { PriceHistoryModal } from './PriceHistoryModal';
import { SearchSelect } from './SearchSelect';
import { PaginationControls } from './PaginationControls';

interface DealRowProps {
  deal: DealDto;
  onOpenHistory: (listingId: number, searchId: number) => void;
}

function DealRow(props: DealRowProps) {
  function handleHistoryClick() {
    props.onOpenHistory(props.deal.listingId, props.deal.searchId);
  }

  const discountBadgeClass =
    props.deal.discountPercentage >= 50
      ? 'bg-emerald-600 text-white font-mono font-bold px-2 py-0.5 rounded text-xs inline-block'
      : props.deal.discountPercentage >= 30
      ? 'bg-emerald-100 text-emerald-800 font-mono font-semibold px-2 py-0.5 rounded text-xs inline-block border border-emerald-300'
      : 'bg-slate-100 text-slate-800 font-mono font-medium px-2 py-0.5 rounded text-xs inline-block border border-slate-300';

  return (
    <tr className="border-b border-slate-200 hover:bg-slate-50 transition-colors text-xs">
      <td className="px-3 py-2.5 whitespace-nowrap">
        <span className={discountBadgeClass}>
          {props.deal.discountPercentage.toFixed(1)}% OFF
        </span>
      </td>
      <td className="px-3 py-2.5 max-w-xs sm:max-w-md">
        <a
          href={props.deal.url || '#'}
          target="_blank"
          rel="noreferrer"
          className="font-medium text-blue-600 hover:text-blue-800 hover:underline line-clamp-1"
          title={props.deal.title}
        >
          {props.deal.title || `Listing #${props.deal.listingId}`}
        </a>
        <div className="text-[11px] text-slate-400 font-mono mt-0.5">
          {props.deal.sellerName ? `Seller: ${props.deal.sellerName} | ` : ''}
          {props.deal.platform || 'ebay'} // ID: {props.deal.listingId}
        </div>
      </td>
      <td className="px-3 py-2.5 font-mono text-right whitespace-nowrap">
        <div className="font-semibold text-slate-900">
          {formatCurrency(
            props.deal.estimatedDeliveredCost ?? props.deal.listingPrice,
            props.deal.currency
          )}
        </div>
        <div className="text-[10px] text-slate-400">
          Item: {formatCurrency(props.deal.listingPrice, props.deal.currency)}
          {props.deal.postage !== null && props.deal.postage !== undefined ? (
            props.deal.postage === 0
              ? ' (Free post)'
              : ` (+${formatCurrency(props.deal.postage, props.deal.currency)})`
          ) : (
            ' (Postage unknown)'
          )}
        </div>
      </td>
      <td className="px-3 py-2.5 font-mono text-slate-500 text-right whitespace-nowrap">
        {formatCurrency(props.deal.baselineMarketPrice, props.deal.currency)}
      </td>
      <td className="px-3 py-2.5 whitespace-nowrap font-mono text-slate-600">
        <span className="px-1.5 py-0.5 bg-slate-100 rounded border border-slate-200">
          {props.deal.searchQuery || `#${props.deal.searchId}`}
        </span>
      </td>
      <td className="px-3 py-2.5 whitespace-nowrap">
        <StatusBadge status={props.deal.status} />
      </td>
      <td className="px-3 py-2.5 whitespace-nowrap font-mono text-slate-500">
        {formatDate(props.deal.flaggedAt)}
      </td>
      <td className="px-3 py-2.5 whitespace-nowrap text-right">
        <button
          type="button"
          onClick={handleHistoryClick}
          className="px-2 py-1 text-[11px] font-mono font-medium border border-slate-300 bg-white hover:bg-slate-100 text-slate-700 rounded shadow-xs"
        >
          Audit History
        </button>
      </td>
    </tr>
  );
}

export function DealsView() {
  const [statusFilter, setStatusFilter] = useState<string>('ACTIVE');
  const [searchFilter, setSearchFilter] = useState<string>('');
  const [minDiscount, setMinDiscount] = useState<string>('');
  const [historyTarget, setHistoryTarget] = useState<{ listingId: number; searchId: number } | null>(null);
  const [page, setPage] = useState(1);

  const [appliedDiscount, setAppliedDiscount] = useState('');
  const params = new URLSearchParams({ status: statusFilter, limit: '100', page: String(page) });
  if (searchFilter) params.set('searchId', searchFilter);
  if (appliedDiscount) params.set('minDiscount', appliedDiscount);
  const { data, loading, error, refresh: loadDeals } = useApiResource<DealsResponse>(`/api/deals?${params}`);
  const deals = data?.data ?? [];
  const totalPages = data?.totalPages ?? 1;

  function handleStatusChange(event: React.ChangeEvent<HTMLSelectElement>) {
    setStatusFilter(event.target.value);
    setPage(1);
  }

  function handleSearchSelect(val: string) {
    setSearchFilter(val);
    setPage(1);
  }

  function handleMinDiscountChange(event: React.ChangeEvent<HTMLInputElement>) {
    setMinDiscount(event.target.value);
  }

  function handleRefreshClick() {
    loadDeals();
  }

  function handleOpenHistory(listingId: number, searchId: number) {
    setHistoryTarget({ listingId, searchId });
  }

  function handleCloseHistory() {
    setHistoryTarget(null);
  }

  function renderDealRow(item: DealDto) {
    return (
      <DealRow
        key={item.id}
        deal={item}
        onOpenHistory={handleOpenHistory}
      />
    );
  }

  const dealRows = deals.map(renderDealRow);

  const summary = !loading && !error ? data?.summary : undefined;

  return (
    <div className="space-y-6">
      {/* Top Metrics Row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white border border-slate-200 rounded p-4">
          <div className="text-xs font-mono uppercase text-slate-500">
            Detected Deals
          </div>
          <div className="text-2xl font-bold font-mono text-slate-900 mt-1">
            {summary?.count ?? '—'}
          </div>
          <div className="text-xs text-slate-400 mt-1">
            Status: {statusFilter}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded p-4">
          <div className="text-xs font-mono uppercase text-slate-500">
            Highest Discount
          </div>
          <div className="text-2xl font-bold font-mono text-emerald-600 mt-1">
            {summary ? `${summary.maxDiscount.toFixed(1)}%` : '—'}
          </div>
          <div className="text-xs text-slate-400 mt-1">
            vs. Delivered-Cost Baseline
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded p-4">
          <div className="text-xs font-mono uppercase text-slate-500">
            Average Discount
          </div>
          <div className="text-2xl font-bold font-mono text-slate-900 mt-1">
            {summary ? `${summary.avgDiscount.toFixed(1)}%` : '—'}
          </div>
          <div className="text-xs text-slate-400 mt-1">
            Across all deals matching applied filters
          </div>
        </div>
      </div>

      <p className="text-xs text-slate-500">
        Baselines use the median delivered cost from matching sold listings when at least three qualify; otherwise, matching active listings are used when at least three qualify. Listings without known postage are excluded.
      </p>

      {/* Filter Control Bar */}
      <div className="bg-white border border-slate-200 rounded p-3 flex flex-wrap items-center gap-3">
        <div className="flex items-center space-x-2">
          <label htmlFor="dealsview-1" className="text-xs font-mono uppercase text-slate-600">
            Status:
          </label>
          <select id="dealsview-1"
            value={statusFilter}
            onChange={handleStatusChange}
            className="text-xs font-mono border border-slate-300 rounded px-2.5 py-1.5 bg-white text-slate-800"
          >
            <option value="ACTIVE">ACTIVE</option>
            <option value="ALL">ALL STATUSES</option>
            <option value="SOLD">SOLD</option>
            <option value="EXPIRED">EXPIRED</option>
            <option value="DELISTED">DELISTED</option>
          </select>
        </div>

        <div className="flex items-center space-x-2">
          <label htmlFor="dealsview-2" className="text-xs font-mono uppercase text-slate-600">
            Tracked Search:
          </label>
          <SearchSelect
            id="dealsview-2"
            value={searchFilter}
            onChange={handleSearchSelect}
            placeholder="ALL SEARCHES"
            className="max-w-[160px] sm:max-w-xs"
          />
        </div>

        <div className="flex items-center space-x-2">
          <label htmlFor="dealsview-3" className="text-xs font-mono uppercase text-slate-600">
            Min Discount (%):
          </label>
          <input id="dealsview-3"
            type="number"
            min="0"
            max="99"
            placeholder="e.g. 25"
            value={minDiscount}
            onChange={handleMinDiscountChange}
            className="text-xs font-mono border border-slate-300 rounded px-2 py-1.5 w-24 bg-white text-slate-800"
          />
        </div>

        <button type="button" onClick={() => { setAppliedDiscount(minDiscount); setPage(1); }}
          className="px-3 py-1.5 text-xs font-mono border border-slate-300 rounded">Apply discount</button>
        <span role="status" className="text-xs font-mono text-slate-500">Applied minimum: {appliedDiscount || '0'}%{minDiscount !== appliedDiscount ? ' (unapplied changes)' : ''}</span>
        <div className="ml-auto">
          <button
            type="button"
            onClick={handleRefreshClick}
            className="px-3 py-1.5 text-xs font-mono font-medium border border-slate-300 bg-slate-50 hover:bg-slate-100 text-slate-700 rounded"
          >
            Refresh Query
          </button>
        </div>
      </div>

      {/* Main Table */}
      <div className="bg-white border border-slate-200 rounded overflow-hidden shadow-xs">
        <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-mono uppercase font-semibold text-slate-700">
            Flagged Deals Log ({data?.total ?? '—'} matching records; {deals.length} on this page)
          </span>
          <span className="text-xs font-mono text-slate-500">
            Ordered by discount % desc
          </span>
        </div>

        <TableScroll>
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-100 border-b border-slate-200 text-[11px] font-mono uppercase text-slate-600">
                <th className="px-3 py-2 font-semibold">Discount</th>
                <th className="px-3 py-2 font-semibold">Title & External ID</th>
                <th className="px-3 py-2 font-semibold text-right">Price (Delivered)</th>
                <th className="px-3 py-2 font-semibold text-right">Delivered-Cost Baseline</th>
                <th className="px-3 py-2 font-semibold">Search</th>
                <th className="px-3 py-2 font-semibold">Status</th>
                <th className="px-3 py-2 font-semibold">Detected At</th>
                <th className="px-3 py-2 font-semibold text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              <TableState columns={8} loading={loading} error={error} empty={deals.length === 0}
                loadingText="Querying SQLite database..." emptyText="No flagged deals matching current filter criteria.">
                {dealRows}
              </TableState>
            </tbody>
          </table>
        </TableScroll>
        <div className="px-4 py-3 border-t border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-2">
          <PaginationControls
            page={page}
            totalPages={totalPages}
            onPrev={() => setPage((p) => Math.max(1, p - 1))}
            onNext={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={loading}
          />
          {data && page > data.totalPages ? (
            <button
              type="button"
              onClick={() => setPage(1)}
              className="text-xs font-mono text-blue-600 hover:underline"
            >
              Return to first page
            </button>
          ) : null}
        </div>
      </div>

      <PriceHistoryModal
        listingId={historyTarget?.listingId ?? null}
        searchId={historyTarget?.searchId}
        onClose={handleCloseHistory}
      />
    </div>
  );
}
