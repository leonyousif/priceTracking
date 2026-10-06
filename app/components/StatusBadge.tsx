interface StatusBadgeProps {
  status: string;
}

function getBadgeStyle(status: string): string {
  const normalized = status.toUpperCase();
  switch (normalized) {
    case 'ACTIVE':
    case 'COMPLETED':
    case '1':
      return 'bg-emerald-50 text-emerald-700 border-emerald-300';
    case 'RUNNING':
      return 'bg-sky-50 text-sky-700 border-sky-300 animate-pulse';
    case 'PENDING':
    case 'PAUSED':
    case '0':
      return 'bg-amber-50 text-amber-700 border-amber-300';
    case 'BLOCKED':
      return 'bg-amber-50 text-amber-700 border-amber-300 font-semibold';
    case 'FAILED':
    case 'DELISTED':
      return 'bg-rose-50 text-rose-700 border-rose-300';
    case 'SOLD':
      return 'bg-blue-50 text-blue-700 border-blue-300';
    case 'EXPIRED':
    default:
      return 'bg-slate-50 text-slate-600 border-slate-300';
  }
}

export function StatusBadge(props: StatusBadgeProps) {
  const badgeClass = `inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-medium border ${getBadgeStyle(props.status)}`;
  return <span className={badgeClass}>{props.status}</span>;
}
