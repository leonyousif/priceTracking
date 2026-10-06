/** Preserve the tracker's en-AU display policy and caller-specific empty text. */
export function formatDate(value: string | null, empty = '-', detail: 'short' | 'seconds' | 'year' = 'short'): string {
  if (!value) return empty;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return empty;
  const options: Intl.DateTimeFormatOptions = {
    month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
    ...(detail === 'seconds' ? { second: '2-digit' } : {}),
    ...(detail === 'year' ? { year: 'numeric' } : {}),
  };
  return detail === 'year' ? date.toLocaleString('en-AU', options) : date.toLocaleDateString('en-AU', options);
}

export function formatCurrency(amount: number, currency = 'AUD'): string {
  return `$${amount.toFixed(2)} ${currency}`;
}
