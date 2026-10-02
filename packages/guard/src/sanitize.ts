const secretAssignment =
  /\b(?:api[_-]?key|access[_-]?token|secret|password|authorization)\b\s*[:=]\s*\S+/gi;
const bearer = /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const prefixedKey = /\b(?:sk|rk|pk|ghp|xox[baprs])-[A-Za-z0-9_-]{8,}\b/g;
const pem = /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g;
const cardLike = /\d(?:[ -]?\d){12,18}/g;

export function sanitizeGuardText(value: string, max = 500): string {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .replace(pem, '[redacted]')
    .replace(bearer, 'Bearer [redacted]')
    .replace(prefixedKey, '[redacted]')
    .replace(secretAssignment, '[redacted]')
    .replace(cardLike, '[redacted]');
}

const evidenceAllowlist = new Set([
  'inspector',
  'matchedType',
  'matchCount',
  'maskedPreview',
  'policyId',
  'policyVersion',
  'action',
  'fieldsRedacted',
  'category',
  'outcome',
  'classification',
  'redactionSummary',
  'enforcementExecuted',
  'errorCode',
]);

export function sanitizeEvidence(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {};
  }
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!evidenceAllowlist.has(key)) {
      continue;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      output[key] = value;
      continue;
    }
    if (typeof value === 'string') {
      output[key] = sanitizeGuardText(value, 180);
    }
  }
  return output;
}
