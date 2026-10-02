export type GuardRedactionMarker = 'EMAIL' | 'PHONE' | 'PAYMENT_CARD' | 'SECRET';

export interface GuardFinding {
  inspectorId: string;
  kind: 'sensitive_data' | 'secret';
  classification: string;
  marker: GuardRedactionMarker;
  count: number;
  severity: 'medium' | 'high';
  confidence: number;
}

export interface GuardInspectionInput {
  messages: Array<{ role?: string; content?: unknown }>;
}

export interface GuardInspectionResult {
  findings: GuardFinding[];
  detectedDataTypes: string[];
  detectedSecrets: string[];
  promptRiskFlags: string[];
}

export interface GuardInspector {
  id: string;
  inspect(input: GuardInspectionInput): GuardInspectionResult | Promise<GuardInspectionResult>;
}

interface Span {
  start: number;
  end: number;
  marker: GuardRedactionMarker;
  classification: string;
  kind: GuardFinding['kind'];
  severity: GuardFinding['severity'];
  confidence: number;
  inspectorId: string;
}

const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const phonePattern = /(?:\+\d{1,3}[\s.-])?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4}\b/g;
const cardPattern = /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g;
const bearerPattern = /Bearer\s+[A-Za-z0-9._~+/-]{12,}/g;
const prefixedKeyPattern = /\b(?:sk|rk|pk|ghp|xox[baprs])-[A-Za-z0-9_-]{8,}\b/g;
const awsKeyPattern = /\bAKIA[0-9A-Z]{16}\b/g;
const privateKeyPattern = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let alternate = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48;
    if (digit < 0 || digit > 9) return false;
    if (alternate) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    alternate = !alternate;
  }
  return sum % 10 === 0 && digits.length >= 13 && digits.length <= 19;
}

function spansFor(text: string): Span[] {
  const spans: Span[] = [];
  const push = (pattern: RegExp, span: Omit<Span, 'start' | 'end'>, accept?: (value: string) => boolean) => {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const value = match[0];
      if (accept && !accept(value)) continue;
      const start = match.index ?? 0;
      spans.push({ ...span, start, end: start + value.length });
    }
  };
  push(privateKeyPattern, {
    marker: 'SECRET',
    classification: 'PRIVATE_KEY',
    kind: 'secret',
    severity: 'high',
    confidence: 1,
    inspectorId: 'SecretInspector',
  });
  push(bearerPattern, {
    marker: 'SECRET',
    classification: 'ACCESS_TOKEN',
    kind: 'secret',
    severity: 'high',
    confidence: 1,
    inspectorId: 'SecretInspector',
  });
  push(prefixedKeyPattern, {
    marker: 'SECRET',
    classification: 'API_KEY',
    kind: 'secret',
    severity: 'high',
    confidence: 1,
    inspectorId: 'SecretInspector',
  });
  push(awsKeyPattern, {
    marker: 'SECRET',
    classification: 'AUTHENTICATION_SECRET',
    kind: 'secret',
    severity: 'high',
    confidence: 1,
    inspectorId: 'SecretInspector',
  });
  push(
    cardPattern,
    {
      marker: 'PAYMENT_CARD',
      classification: 'PAYMENT_CARD',
      kind: 'sensitive_data',
      severity: 'high',
      confidence: 1,
      inspectorId: 'SensitiveDataInspector',
    },
    (value) => luhnValid(value.replace(/\D/g, '')),
  );
  push(emailPattern, {
    marker: 'EMAIL',
    classification: 'CUSTOMER_PII',
    kind: 'sensitive_data',
    severity: 'medium',
    confidence: 1,
    inspectorId: 'SensitiveDataInspector',
  });
  push(phonePattern, {
    marker: 'PHONE',
    classification: 'CUSTOMER_PII',
    kind: 'sensitive_data',
    severity: 'medium',
    confidence: 0.8,
    inspectorId: 'SensitiveDataInspector',
  });
  return spans.sort((left, right) => left.start - right.start || right.end - left.end);
}

function withoutOverlaps(spans: Span[]): Span[] {
  const kept: Span[] = [];
  let cursor = -1;
  for (const span of spans) {
    if (span.start < cursor) continue;
    kept.push(span);
    cursor = span.end;
  }
  return kept;
}

export function collectGuardSpans(text: string): Span[] {
  return withoutOverlaps(spansFor(text));
}

function summarize(spans: Span[]): GuardFinding[] {
  const grouped = new Map<string, GuardFinding>();
  for (const span of spans) {
    const key = `${span.inspectorId}:${span.classification}:${span.marker}`;
    const current = grouped.get(key);
    if (current) {
      current.count += 1;
      continue;
    }
    grouped.set(key, {
      inspectorId: span.inspectorId,
      kind: span.kind,
      classification: span.classification,
      marker: span.marker,
      count: 1,
      severity: span.severity,
      confidence: span.confidence,
    });
  }
  return [...grouped.values()];
}

export function redactGuardText(text: string, allowed: ReadonlySet<GuardRedactionMarker>): { text: string; counts: Record<string, number> } {
  const spans = collectGuardSpans(text).filter((span) => allowed.has(span.marker));
  const counts: Record<string, number> = {};
  let cursor = 0;
  let next = '';
  for (const span of spans) {
    next += text.slice(cursor, span.start);
    next += `[REDACTED:${span.marker}]`;
    counts[span.marker] = (counts[span.marker] ?? 0) + 1;
    cursor = span.end;
  }
  next += text.slice(cursor);
  return { text: next, counts };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function redactGuardValue(
  value: unknown,
  allowed: ReadonlySet<GuardRedactionMarker>,
): { value: unknown; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  const add = (extra: Record<string, number>) => {
    for (const [key, count] of Object.entries(extra)) counts[key] = (counts[key] ?? 0) + count;
  };
  if (typeof value === 'string') {
    const redacted = redactGuardText(value, allowed);
    return { value: redacted.text, counts: redacted.counts };
  }
  if (Array.isArray(value)) {
    return {
      value: value.map((entry) => {
        const redacted = redactGuardValue(entry, allowed);
        add(redacted.counts);
        return redacted.value;
      }),
      counts,
    };
  }
  if (isRecord(value) && value.type === 'text' && typeof value.text === 'string') {
    const redacted = redactGuardText(value.text, allowed);
    return { value: { ...value, text: redacted.text }, counts: redacted.counts };
  }
  return { value, counts };
}

function walkText(value: unknown, visit: (text: string) => void) {
  if (typeof value === 'string') {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) walkText(entry, visit);
    return;
  }
  if (isRecord(value) && value.type === 'text' && typeof value.text === 'string') {
    visit(value.text);
  }
}

export function inspectGuardText(text: string): GuardFinding[] {
  return summarize(collectGuardSpans(text));
}

export function inspectGuardRequest(input: GuardInspectionInput): GuardInspectionResult {
  const spans: Span[] = [];
  for (const message of input.messages) {
    walkText(message.content, (text) => spans.push(...collectGuardSpans(text)));
  }
  const findings = summarize(spans);
  return {
    findings,
    detectedDataTypes: [...new Set(findings.filter((finding) => finding.kind === 'sensitive_data').map((finding) => finding.classification))],
    detectedSecrets: [...new Set(findings.filter((finding) => finding.kind === 'secret').map((finding) => finding.classification))],
    promptRiskFlags: [],
  };
}

export const sensitiveDataInspector: GuardInspector = {
  id: 'SensitiveDataInspector',
  inspect(input) {
    const result = inspectGuardRequest(input);
    return { ...result, findings: result.findings.filter((finding) => finding.inspectorId === 'SensitiveDataInspector'), detectedSecrets: [] };
  },
};

export const secretInspector: GuardInspector = {
  id: 'SecretInspector',
  inspect(input) {
    const result = inspectGuardRequest(input);
    return { ...result, findings: result.findings.filter((finding) => finding.inspectorId === 'SecretInspector'), detectedDataTypes: [] };
  },
};

export const guardRequestInspectors: GuardInspector[] = [sensitiveDataInspector, secretInspector];

const markerForClassification: Record<string, GuardRedactionMarker[]> = {
  CUSTOMER_PII: ['EMAIL', 'PHONE'],
  PAYMENT_CARD: ['PAYMENT_CARD'],
  API_KEY: ['SECRET'],
  ACCESS_TOKEN: ['SECRET'],
  PRIVATE_KEY: ['SECRET'],
  AUTHENTICATION_SECRET: ['SECRET'],
};

export function markersForDataTypes(dataTypes: string[] | undefined, findings: GuardFinding[]): Set<GuardRedactionMarker> {
  if (!dataTypes || dataTypes.length === 0) {
    return new Set(findings.map((finding) => finding.marker));
  }
  const allowed = new Set<GuardRedactionMarker>();
  for (const type of dataTypes) {
    for (const marker of markerForClassification[type] ?? []) allowed.add(marker);
  }
  return allowed;
}

export interface GuardResponseInspector {
  id: string;
  inspect(text: string): GuardFinding[];
}

const responseInspectors: GuardResponseInspector[] = [];

export function registerGuardResponseInspector(inspector: GuardResponseInspector) {
  responseInspectors.push(inspector);
}

export function inspectGuardResponse(value: unknown): { findings: GuardFinding[]; applied: boolean } {
  if (responseInspectors.length === 0) return { findings: [], applied: false };
  const findings: GuardFinding[] = [];
  walkText(value, (text) => {
    for (const inspector of responseInspectors) findings.push(...inspector.inspect(text));
  });
  return { findings, applied: true };
}
