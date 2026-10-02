export function usd(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '—';
  }
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

export function percent(value: number | null) {
  if (value === null || Number.isNaN(value)) {
    return '—';
  }
  return `${Math.round(value * 1000) / 10}%`;
}

export function when(value: Date | string | null | undefined) {
  if (!value) {
    return '—';
  }
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date(value));
}

export function periodRange(period: string | undefined, from?: string, to?: string) {
  const now = new Date();
  if (period === '24h') {
    return { start: new Date(now.getTime() - 24 * 60 * 60 * 1000), end: now, label: '24h' };
  }
  if (period === '7d') {
    return { start: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), end: now, label: '7d' };
  }
  if (period === '90d') {
    return { start: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000), end: now, label: '90d' };
  }
  if (period === 'custom' && from && to) {
    const start = new Date(from);
    const end = new Date(to);
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && end > start) {
      const max = 366 * 24 * 60 * 60 * 1000;
      return {
        start: end.getTime() - start.getTime() > max ? new Date(end.getTime() - max) : start,
        end,
        label: 'custom',
      };
    }
  }
  return { start: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000), end: now, label: '30d' };
}
