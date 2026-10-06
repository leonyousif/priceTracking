'use client';

import React from 'react';

export interface PaginationControlsProps {
  page: number;
  totalPages: number;
  onPrev: () => void;
  onNext: () => void;
  disabled?: boolean;
  className?: string;
}

export function PaginationControls({
  page,
  totalPages,
  onPrev,
  onNext,
  disabled = false,
  className,
}: PaginationControlsProps) {
  const isPrevDisabled = disabled || page <= 1;
  const isNextDisabled = disabled || page >= totalPages;

  return (
    <div className={`flex items-center space-x-3 text-xs font-mono ${className ?? ''}`}>
      <span className="text-slate-500">
        Page {page} of {totalPages}
      </span>
      <button
        type="button"
        disabled={isPrevDisabled}
        onClick={onPrev}
        className="px-2 py-0.5 border border-slate-300 rounded bg-white hover:bg-slate-100 disabled:opacity-40 transition-colors"
      >
        Previous
      </button>
      <button
        type="button"
        disabled={isNextDisabled}
        onClick={onNext}
        className="px-2 py-0.5 border border-slate-300 rounded bg-white hover:bg-slate-100 disabled:opacity-40 transition-colors"
      >
        Next
      </button>
    </div>
  );
}
