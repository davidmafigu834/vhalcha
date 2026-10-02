export interface ModelRule {
  id: string;
  provider: string;
  modelPattern: string;
  isAllowed: boolean;
  priority: number;
}

export interface ModelAccessDecision {
  allowed: boolean;
  matchedRule: ModelRule | null;
}

export function modelPatternMatches(pattern: string, model: string): boolean {
  if (!pattern || pattern.includes('/') || pattern.length > 128) {
    return false;
  }
  const expression = `^${pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replaceAll('*', '.*')}$`;
  return new RegExp(expression, 'i').test(model);
}

export function decideModelAccess(
  rules: ModelRule[],
  provider: string,
  model: string,
): ModelAccessDecision {
  const matching = rules
    .filter(
      (rule) => rule.provider === provider && modelPatternMatches(rule.modelPattern, model),
    )
    .sort((left, right) => {
      if (left.priority !== right.priority) {
        return left.priority - right.priority;
      }
      if (left.isAllowed !== right.isAllowed) {
        return left.isAllowed ? 1 : -1;
      }
      return left.id.localeCompare(right.id);
    });
  const matchedRule = matching[0] ?? null;
  return {
    allowed: Boolean(matchedRule?.isAllowed),
    matchedRule,
  };
}

export interface PolicyComplianceInput {
  allowedRequests: number;
  blockedRequests: number;
  warningEvents: number;
  systemsRequiringAttention: number;
  totalSystems: number;
}

export interface PolicyCompliance {
  score: number | null;
  label: 'No evaluated traffic' | 'Within policy' | 'Warning' | 'Review required';
  explanation: string;
}

export function calculatePolicyCompliance(input: PolicyComplianceInput): PolicyCompliance {
  const evaluated = input.allowedRequests + input.blockedRequests;
  if (evaluated === 0 && input.warningEvents === 0) {
    return {
      score: null,
      label: 'No evaluated traffic',
      explanation: 'Policy compliance is calculated from allowed and blocked requests once traffic exists.',
    };
  }
  const requestCompliance = evaluated === 0 ? 1 : input.allowedRequests / evaluated;
  const warningPenalty = Math.min(0.2, input.warningEvents * 0.02);
  const statusPenalty =
    input.totalSystems === 0 ? 0 : (input.systemsRequiringAttention / input.totalSystems) * 0.3;
  const score = Math.min(1, Math.max(0, requestCompliance - warningPenalty - statusPenalty));
  const label = score >= 0.95 ? 'Within policy' : score >= 0.8 ? 'Warning' : 'Review required';
  return {
    score,
    label,
    explanation:
      'Score uses allowed versus blocked requests, budget warnings, and AI systems that are not active. It is a V1 operational indicator.',
  };
}
