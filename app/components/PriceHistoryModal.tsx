'use client';

import { useEffect, useRef, useId, useState } from 'react';

import type { PricePointDto, ListingHistoryResponse, SearchHistoryResponse } from '@/lib/types';
import { defaultHistoryWindow } from '@/lib/history';
import { useApiResource } from './useApiResource';
import { formatDate, formatCurrency } from '@/lib/format';

interface PriceHistoryModalProps {
  listingId: number | null;
  searchId?: number;
  onClose: () => void;
}

export function PriceHistoryModal(props: PriceHistoryModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const open = props.listingId !== null;

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.showModal();
    closeRef.current?.focus();
    return () => {
      dialog?.close();
      if (opener?.isConnected) opener.focus();
    };
  }, [open]);

  const target = `${props.listingId}:${props.searchId}`;
  const defaults = defaultHistoryWindow();
  const [selection, setSelection] = useState({ target: '', mode: 'listing', page: 1, ...defaults });
  const current = selection.target === target ? selection : { target, mode: 'listing', page: 1, ...defaults };
  function updateSelection(change: Partial<typeof selection>) { setSelection({ ...current, ...change }); }
  // Closing retires pagination/window choices as well as the request.
  useEffect(() => { if (!open) setSelection({ target: '', mode: 'listing', page: 1, ...defaultHistoryWindow() }); }, [open]);
  const params = current.mode === 'search'
    ? new URLSearchParams({ searchId: String(props.searchId), startDate: current.startDate, endDate: current.endDate })
    : new URLSearchParams({ listingId: String(props.listingId), page: String(current.page), limit: '50' });
  const { data, loading, error, refresh } = useApiResource<ListingHistoryResponse | SearchHistoryResponse>(
    props.listingId === null ? null : `/api/stats/price-history?${params}`);
  const listingData = data?.mode === 'listing' ? data : null;
  const searchData = data?.mode === 'search' ? data : null;
  const listing = listingData?.listing ?? null;
  const history = listingData?.history ?? [];

  function handleCloseModal() {
    props.onClose();
  }

  function renderRow(point: PricePointDto, index: number) {
    const prevPoint = index > 0 ? history[index - 1] : listingData?.predecessor;
    let diffText = '-';
    let diffClass = 'text-slate-500 font-mono text-xs';

    if (prevPoint) {
      const diff = point.price - prevPoint.price;
      if (diff > 0) {
        diffText = `+$${diff.toFixed(2)}`;
        diffClass = 'text-rose-600 font-mono text-xs font-semibold';
      } else if (diff < 0) {
        diffText = `-$${Math.abs(diff).toFixed(2)}`;
        diffClass = 'text-emerald-600 font-mono text-xs font-semibold';
      } else {
        diffText = '$0.00';
      }
    }

    return (
      <tr key={point.id} className="border-b border-slate-100 hover:bg-slate-50">
        <td className="px-3 py-2 text-xs font-mono text-slate-500">{point.id}</td>
        <td className="px-3 py-2 text-xs font-mono text-slate-700">{formatDate(point.recordedAt, '-', 'year')}</td>
        <td className="px-3 py-2 text-xs font-mono font-semibold text-slate-900 text-right">
          {formatCurrency(point.price, listing?.currency)}
        </td>
        <td className={`px-3 py-2 text-right ${diffClass}`}>{diffText}</td>
      </tr>
    );
  }

  if (!props.listingId) {
    return null;
  }

  const rows = history.map(renderRow);

  return (
    <>
      <dialog ref={dialogRef} aria-labelledby={titleId}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const rect = event.currentTarget.getBoundingClientRect();
          if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) props.onClose();
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return;
          const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]'));
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }}
        onCancel={(event) => { event.preventDefault(); props.onClose(); }}
        className="m-auto p-0 bg-white border border-slate-300 rounded shadow-lg max-w-2xl w-[calc(100%-2rem)] max-h-[85vh] open:flex flex-col backdrop:bg-slate-900/50">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 bg-slate-50">
          <div className="min-w-0">
            <span className="text-xs font-mono uppercase tracking-wider text-slate-500">
              ITEM PRICE EVENTS // #{props.listingId}
            </span>
            <h3 id={titleId} className="text-sm font-semibold text-slate-900 truncate max-w-lg mt-0.5">
              {searchData ? searchData.search.query : listing ? listing.title : 'Loading history...'}
            </h3>
          </div>
          <button ref={closeRef}
            type="button"
            onClick={handleCloseModal}
            className="shrink-0 px-2 py-1 text-xs font-mono font-semibold border border-slate-300 bg-white hover:bg-slate-100 text-slate-700 rounded"
          >
            [ESC / CLOSE]
          </button>
        </div>

        <div className="p-4 overflow-y-auto flex-1">
          <p className="text-xs text-slate-500 mb-3">First-seen and item-price change events. Postage changes are not recorded; these events do not represent a delivered-cost market baseline or market volume.</p>
          {props.searchId ? <div className="mb-3 text-xs">
            <label htmlFor={`${titleId}-mode`} className="mr-2">History scope</label>
            <select id={`${titleId}-mode`} value={current.mode} onChange={event => updateSelection({ mode: event.target.value, page: 1 })} className="border rounded p-1">
              <option value="listing">This listing</option><option value="search">This search: daily item-price events</option>
            </select>
          </div> : null}
          {current.mode === 'search' ? <form key={`${target}-window`} onSubmit={event => {
            event.preventDefault();
            const fields = new FormData(event.currentTarget);
            updateSelection({ startDate: String(fields.get('startDate')), endDate: String(fields.get('endDate')) });
          }} className="flex flex-wrap gap-2 items-end text-xs mb-3">
            <label>From (UTC)<input aria-label="History start date" name="startDate" type="date" required defaultValue={current.startDate} className="block border rounded p-1" /></label>
            <label>To (UTC)<input aria-label="History end date" name="endDate" type="date" required defaultValue={current.endDate} className="block border rounded p-1" /></label>
            <button type="submit" className="border rounded p-1">Apply history window</button>
            <span>At most 92 days inclusive</span>
          </form> : null}
          {loading ? (
            <div className="text-xs font-mono text-slate-500 py-8 text-center">
              Fetching audit records from SQLite...
            </div>
          ) : error ? (
            <div role="alert" className="text-xs font-mono text-rose-600 py-8 text-center">{error} <button type="button" onClick={refresh} className="underline">Retry history</button></div>
          ) : searchData ? (
            <div>
              <p className="text-xs mb-2">Applied UTC window: {searchData.startDate} to {searchData.endDate}. Median of recorded item-price events.</p>
              {searchData.trends.length === 0 ? <p className="text-xs">No item-price events in this window.</p> : <div className="overflow-x-auto"><table className="w-full text-xs font-mono">
                <thead><tr><th className="text-left p-2">UTC date</th><th className="text-right p-2">Median item price</th><th className="text-right p-2">Events</th></tr></thead>
                <tbody>{searchData.trends.map(day => <tr key={day.date}><td className="p-2">{day.date}</td><td className="text-right p-2">{formatCurrency(day.medianItemPrice)}</td><td className="text-right p-2">{day.eventCount}</td></tr>)}</tbody>
              </table></div>}
            </div>
          ) : history.length === 0 ? (
            <div className="text-xs font-mono text-slate-500 py-8 text-center">
              No item-price events on this page.
            </div>
          ) : (
            <div className="border border-slate-200 rounded overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-100 border-b border-slate-200 text-[11px] font-mono text-slate-600 uppercase">
                    <th className="px-3 py-1.5 font-medium">Event</th>
                    <th className="px-3 py-1.5 font-medium">Timestamp</th>
                    <th className="px-3 py-1.5 font-medium text-right">Item price</th>
                    <th className="px-3 py-1.5 font-medium text-right">Delta</th>
                  </tr>
                </thead>
                <tbody>{rows}</tbody>
              </table>
            </div>
          )}
        </div>

        <div className="border-t border-slate-200 px-4 py-2 bg-slate-50 flex flex-wrap gap-2 items-center justify-between text-xs font-mono text-slate-500">
          {current.mode === 'listing' ? <div className="flex flex-wrap gap-2 items-center">
            <span>{listingData?.total ?? '—'} item-price events; page {current.page} of {listingData?.totalPages ?? '—'} (newest page first)</span>
            <button type="button" disabled={loading || current.page <= 1} onClick={() => updateSelection({ page: current.page - 1 })} className="border rounded p-1 disabled:opacity-40">Newer events</button>
            <button type="button" disabled={loading || !!error || !listingData || current.page >= listingData.totalPages} onClick={() => updateSelection({ page: current.page + 1 })} className="border rounded p-1 disabled:opacity-40">Older events</button>
          </div> : <span>Daily item-price event summary</span>}
          {listing ? (
            <a
              href={listing.url}
              target="_blank"
              rel="noreferrer"
              className="text-blue-600 hover:underline inline-flex items-center"
            >
              Open Original Marketplace URL &rarr;
            </a>
          ) : null}
        </div>
      </dialog>
    </>
  );
}
