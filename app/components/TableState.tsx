import React from 'react';

export function TableScroll({ children }: { children: React.ReactNode }) {
  return <div className="overflow-x-auto">{children}</div>;
}

export function TableState({ columns, loading, error, empty, loadingText, emptyText, children }:
  { columns: number; loading: boolean; error: string | null; empty: boolean;
    loadingText: string; emptyText: string; children: React.ReactNode }) {
  if (!loading && !error && !empty) return <>{children}</>;
  return <tr><td colSpan={columns} className={`text-center py-8 text-xs font-mono ${error ? 'text-rose-600' : 'text-slate-500'}`}>
    <span role={error ? 'alert' : 'status'}>{loading ? loadingText : error || emptyText}</span>
  </td></tr>;
}
