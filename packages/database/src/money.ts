export function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === '') {
    return 0;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function toNumeric(value: number, scale = 6): string {
  return value.toFixed(scale);
}

export function toMicroUsd(amount: number): number {
  return Math.round(amount * 1_000_000);
}

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, 60) || 'item';
}
