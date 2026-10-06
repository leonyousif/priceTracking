'use client';

import React from 'react';
import type { SearchOptionsResponse } from '@/lib/types';
import { useApiResource } from './useApiResource';

export interface SearchSelectProps {
  value: string;
  onChange: (val: string) => void;
  id?: string;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
}

export function SearchSelect({
  value,
  onChange,
  id,
  className,
  placeholder = 'All Tracked Searches',
  disabled = false,
}: SearchSelectProps) {
  const { data } = useApiResource<SearchOptionsResponse>('/api/searches?projection=options');
  const searches = data?.data ?? [];

  const baseClasses = 'text-xs font-mono border border-slate-300 rounded px-2.5 py-1.5 bg-white text-slate-900';
  const resolvedClassName = className
    ? className.includes('border')
      ? className
      : `${baseClasses} ${className}`
    : baseClasses;

  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className={resolvedClassName}
    >
      <option value="">{placeholder}</option>
      {searches.map((s) => (
        <option key={s.id} value={s.id.toString()}>
          #{s.id}: {s.query}
        </option>
      ))}
    </select>
  );
}
