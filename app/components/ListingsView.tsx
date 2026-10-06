'use client';

import React, { useState } from 'react';
import type { ListingDto, ListingsResponse } from '@/lib/types';
import { formatDate, formatCurrency } from '@/lib/format';
import { TableState, TableScroll } from './TableState';
import { useApiResource } from './useApiResource';
import { StatusBadge } from './StatusBadge';
import { PriceHistoryModal } from './PriceHistoryModal';
import { SearchSelect } from './SearchSelect';
import { PaginationControls } from './PaginationControls';

interface ListingRowProps {
  listing: ListingDto;
  onOpenHistory: (id: number) => void;
}

function ListingRow(props: ListingRowProps) {
  function handleHistoryClick() {
    props.onOpenHistory(props.listing.id);
  }

  const statusText =
    props.listing.isSold === 1
      ? 'SOLD'
      : props.listing.isActive === 1
      ? 'ACTIVE'
      : 'DELISTED';

  return (
    <tr className="border-b border-slate-200 hover:bg-slate-50 transition-colors text-xs">
      <td className="px-3 py-2.5 font-mono text-slate-500 whitespace-nowrap">
        {props.listing.platform} // {props.listing.externalId}
      </td>
      <td className="px-3 py-2.5 max-w-sm sm:max-w-md">
        <a
          href={props.listing.url}
          target="_blank"
          rel="noreferrer"
          className="font-medium text-blue-600 hover:text-blue-800 hover:underline line-clamp-1"
          title={props.listing.title}
        >
          {props.listing.title}
        </a>
        <div className="text-[11px] text-slate-400 font-mono mt-0.5">
          {props.listing.sellerName ? `Seller: ${props.listing.sellerName} | ` : ''}
          {props.listing.location ? `Loc: ${props.listing.location} | ` : ''}
          Target: {props.listing.searchQuery || `#${props.listing.searchId}`}
        </div>
      </td>
      <td className="px-3 py-2.5 font-mono text-right whitespace-nowrap">
        <div className="font-semibold text-slate-900">
          {formatCurrency(props.listing.currentPrice, props.listing.currency)}
        </div>
        <div className="text-[10px] text-slate-400">
          {props.listing.postage !== null && props.listing.postage !== undefined ? (
            props.listing.postage === 0 ? 'Free delivery' : `+ $${props.listing.postage.toFixed(2)} delivery`
          ) : (
            'Postage unknown'
          )}
        </div>
      </td>
      <td className="px-3 py-2.5 whitespace-nowrap">
        <StatusBadge status={statusText} />
      </td>
      <td className="px-3 py-2.5 font-mono text-slate-500 whitespace-nowrap">
        {formatDate(props.listing.firstSeenAt)}
      </td>
      <td className="px-3 py-2.5 font-mono text-slate-500 whitespace-nowrap">
        {formatDate(props.listing.lastSeenAt)}
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

export function ListingsView() {
  // Pagination state
  const [page, setPage] = useState<number>(1);

  // Filters state
  const [searchFilter, setSearchFilter] = useState<string>('');
  const [textQuery, setTextQuery] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [minPrice, setMinPrice] = useState<string>('');
  const [maxPrice, setMaxPrice] = useState<string>('');
  const [sortBy, setSortBy] = useState<string>('newest');

  // History modal
  const [historyListingId, setHistoryListingId] = useState<number | null>(null);

  const [applied, setApplied] = useState({ query: '', min: '', max: '' });
  const params = new URLSearchParams({ page: String(page), limit: '25', sortBy });
  if (searchFilter) params.set('searchId', searchFilter);
  if (applied.query) params.set('query', applied.query);
  if (applied.min) params.set('minPrice', applied.min);
  if (applied.max) params.set('maxPrice', applied.max);
  if (statusFilter === 'active') { params.set('isActive', 'true'); params.set('isSold', 'false'); }
  else if (statusFilter === 'sold') params.set('isSold', 'true');
  const { data, loading, error, refresh } = useApiResource<ListingsResponse>(`/api/listings?${params}`);
  const listings = data?.items ?? [];
  const totalPages = data?.totalPages ?? 1;
  const totalItems = data?.total ?? 0;

  function applyFilters() {
    setPage(1);
    setApplied({ query: textQuery, min: minPrice, max: maxPrice });
  }

  function handleSearchQueryChange(event: React.ChangeEvent<HTMLInputElement>) {
    setTextQuery(event.target.value);
  }

  function handleSearchTargetChange(val: string) {
    setSearchFilter(val);
    setPage(1);
  }

  function handleStatusChange(event: React.ChangeEvent<HTMLSelectElement>) {
    setStatusFilter(event.target.value);
    setPage(1);
  }

  function handleSortChange(event: React.ChangeEvent<HTMLSelectElement>) {
    setSortBy(event.target.value);
    setPage(1);
  }

  function handleMinPriceChange(event: React.ChangeEvent<HTMLInputElement>) {
    setMinPrice(event.target.value);
  }

  function handleMaxPriceChange(event: React.ChangeEvent<HTMLInputElement>) {
    setMaxPrice(event.target.value);
  }

  function handlePrevPage() {
    if (page > 1) {
      setPage(page - 1);
    }
  }

  function handleNextPage() {
    if (page < totalPages) {
      setPage(page + 1);
    }
  }

  function handleOpenHistory(listingId: number) {
    setHistoryListingId(listingId);
  }

  function handleCloseHistory() {
    setHistoryListingId(null);
  }

  function renderListingRow(item: ListingDto) {
    return (
      <ListingRow
        key={item.id}
        listing={item}
        onOpenHistory={handleOpenHistory}
      />
    );
  }

  const rows = listings.map(renderListingRow);

  return (
    <div className="space-y-6">
      {/* Search & Filter Bar */}
      <div className="bg-white border border-slate-200 rounded p-4 space-y-3 shadow-xs">
        <div className="text-xs font-mono uppercase font-semibold text-slate-700">
          Listings Query & Full-Text Search (FTS5)
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
          <div className="sm:col-span-2">
            <label htmlFor="listingsview-1" className="block text-[11px] font-mono text-slate-500 uppercase mb-1">
              Title Search (FTS5 Prefix Enabled)
            </label>
            <input id="listingsview-1"
              type="text"
              placeholder="e.g. Gigabyte 10GB, Disc Edition..."
              value={textQuery}
              onChange={handleSearchQueryChange}
              className="w-full text-xs font-mono border border-slate-300 rounded px-2.5 py-1.5 bg-white text-slate-900"
            />
          </div>

          <div>
            <label htmlFor="listingsview-2" className="block text-[11px] font-mono text-slate-500 uppercase mb-1">
              Tracked Target
            </label>
            <SearchSelect
              id="listingsview-2"
              value={searchFilter}
              onChange={handleSearchTargetChange}
              placeholder="ALL TARGETS"
              className="w-full"
            />
          </div>

          <div>
            <label htmlFor="listingsview-3" className="block text-[11px] font-mono text-slate-500 uppercase mb-1">
              Listing Status
            </label>
            <select id="listingsview-3"
              value={statusFilter}
              onChange={handleStatusChange}
              className="w-full text-xs font-mono border border-slate-300 rounded px-2.5 py-1.5 bg-white text-slate-900"
            >
              <option value="all">ALL (ACTIVE & SOLD)</option>
              <option value="active">ACTIVE ONLY</option>
              <option value="sold">SOLD ONLY</option>
            </select>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-slate-100">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-mono text-slate-500">Price Range:</span>
            <label htmlFor="listings-min" className="sr-only">Minimum price</label>
            <input id="listings-min"
              type="number"
              placeholder="Min $"
              value={minPrice}
              onChange={handleMinPriceChange}
              className="w-20 text-xs font-mono border border-slate-300 rounded px-2 py-1 bg-white text-slate-900"
            />
            <span className="text-xs text-slate-400">-</span>
            <label htmlFor="listings-max" className="sr-only">Maximum price</label>
            <input id="listings-max"
              type="number"
              placeholder="Max $"
              value={maxPrice}
              onChange={handleMaxPriceChange}
              className="w-20 text-xs font-mono border border-slate-300 rounded px-2 py-1 bg-white text-slate-900"
            />
          </div>

          <div className="flex items-center space-x-2 ml-auto">
            <label htmlFor="listings-sort" className="text-xs font-mono text-slate-500">Sort By:</label>
            <select id="listings-sort"
              value={sortBy}
              onChange={handleSortChange}
              className="text-xs font-mono border border-slate-300 rounded px-2 py-1 bg-white text-slate-900"
            >
              <option value="newest">NEWEST FIRST</option>
              <option value="oldest">OLDEST FIRST</option>
              <option value="priceAsc">PRICE: LOW TO HIGH</option>
              <option value="priceDesc">PRICE: HIGH TO LOW</option>
            </select>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
        <button type="button" onClick={applyFilters} className="px-3 py-1.5 border border-slate-300 rounded bg-white">Apply filters</button>
        <button type="button" onClick={refresh} className="px-3 py-1.5 border border-slate-300 rounded bg-white">Refresh listings</button>
        <span role="status">Applied title: {applied.query || 'Any'}; price: {applied.min || 'Any'} – {applied.max || 'Any'}
          {textQuery !== applied.query || minPrice !== applied.min || maxPrice !== applied.max ? ' (unapplied changes)' : ''}</span>
      </div>

      {/* Main Listings Table */}
      <div className="bg-white border border-slate-200 rounded overflow-hidden shadow-xs">
        <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-mono uppercase font-semibold text-slate-700">
            Marketplace Ingested Listings ({totalItems} records found)
          </span>
          <PaginationControls
            page={page}
            totalPages={totalPages}
            onPrev={handlePrevPage}
            onNext={handleNextPage}
            disabled={loading}
          />
        </div>

        <TableScroll>
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-100 border-b border-slate-200 text-[11px] font-mono uppercase text-slate-600">
                <th className="px-3 py-2 font-semibold">Platform // External ID</th>
                <th className="px-3 py-2 font-semibold">Title & Seller</th>
                <th className="px-3 py-2 font-semibold text-right">Price</th>
                <th className="px-3 py-2 font-semibold">Status</th>
                <th className="px-3 py-2 font-semibold">First Seen</th>
                <th className="px-3 py-2 font-semibold">Last Seen</th>
                <th className="px-3 py-2 font-semibold text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              <TableState columns={7} loading={loading} error={error} empty={listings.length === 0}
                loadingText="Querying listings from SQLite..." emptyText="No listings found matching search criteria.">
                {rows}
              </TableState>
            </tbody>
          </table>
        </TableScroll>
      </div>

      <PriceHistoryModal
        listingId={historyListingId}
        onClose={handleCloseHistory}
      />
    </div>
  );
}
