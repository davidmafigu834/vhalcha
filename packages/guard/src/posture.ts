import type { PostureStatus } from './types';

/**
 * Central posture weights. Monitor mode is not a penalty: it is the safe default.
 * "Disabled enforcement" means Guard itself is switched off for the organisation
 * or the deployment, not that the organisation is still observing in monitor mode.
 * Open high incidents are scored once. Threat records are a workflow view of
 * Guard events and are not a second penalty for the same underlying event.
 * Critical policy violations count open policy_violation events only.
 */
export const postureRuleWeights = {
  unprotectedSystems: { weight: 8, cap: 32 },
  unresolvedHighIncidents: { weight: 12, cap: 36 },
  criticalPolicyViolations: { weight: 10, cap: 30 },
  unrestrictedSensitiveData: { weight: 10, cap: 30 },
  missingAuditLogging: { weight: 15, cap: 15 },
  overprivilegedAgents: { weight: 8, cap: 24 },
  unknownSystems: { weight: 6, cap: 24 },
  disabledEnforcement: { weight: 10, cap: 10 },
} as const;

export interface PostureInput {
  aiSystemCount: number;
  unprotectedSystems: number;
  unknownSystems: number;
  unresolvedHighIncidents: number;
  criticalPolicyViolations: number;
  unrestrictedSensitiveDataSystems: number;
  auditLoggingEnabled: boolean;
  overprivilegedAgents: number;
  enforcementDisabled: boolean;
}

export interface PostureFinding {
  id: keyof typeof postureRuleWeights;
  count: number;
  penalty: number;
  summary: string;
}

export interface PostureScore {
  score: number | null;
  status: PostureStatus;
  findings: PostureFinding[];
}

function penalty(count: number, rule: { weight: number; cap: number }): number {
  if (count <= 0) {
    return 0;
  }
  return Math.min(rule.cap, count * rule.weight);
}

function statusFor(score: number): PostureStatus {
  if (score >= 90) return 'strong';
  if (score >= 75) return 'good';
  if (score >= 60) return 'moderate';
  if (score >= 40) return 'weak';
  return 'critical';
}

export function scoreGuardPosture(input: PostureInput): PostureScore {
  if (input.aiSystemCount <= 0) {
    return { score: null, status: 'unscored', findings: [] };
  }

  const candidates: PostureFinding[] = [
    {
      id: 'unprotectedSystems',
      count: input.unprotectedSystems,
      penalty: penalty(input.unprotectedSystems, postureRuleWeights.unprotectedSystems),
      summary: `${input.unprotectedSystems} AI system${input.unprotectedSystems === 1 ? '' : 's'} are unprotected`,
    },
    {
      id: 'unresolvedHighIncidents',
      count: input.unresolvedHighIncidents,
      penalty: penalty(input.unresolvedHighIncidents, postureRuleWeights.unresolvedHighIncidents),
      summary: `${input.unresolvedHighIncidents} high-severity incident${input.unresolvedHighIncidents === 1 ? '' : 's'} remain unresolved`,
    },
    {
      id: 'criticalPolicyViolations',
      count: input.criticalPolicyViolations,
      penalty: penalty(input.criticalPolicyViolations, postureRuleWeights.criticalPolicyViolations),
      summary: `${input.criticalPolicyViolations} critical policy violation${input.criticalPolicyViolations === 1 ? '' : 's'} are open`,
    },
    {
      id: 'unrestrictedSensitiveData',
      count: input.unrestrictedSensitiveDataSystems,
      penalty: penalty(input.unrestrictedSensitiveDataSystems, postureRuleWeights.unrestrictedSensitiveData),
      summary: `${input.unrestrictedSensitiveDataSystems} system${input.unrestrictedSensitiveDataSystems === 1 ? '' : 's'} ha${input.unrestrictedSensitiveDataSystems === 1 ? 's' : 've'} unrestricted sensitive-data access`,
    },
    {
      id: 'missingAuditLogging',
      count: input.auditLoggingEnabled ? 0 : 1,
      penalty: penalty(input.auditLoggingEnabled ? 0 : 1, postureRuleWeights.missingAuditLogging),
      summary: 'Audit logging is disabled',
    },
    {
      id: 'overprivilegedAgents',
      count: input.overprivilegedAgents,
      penalty: penalty(input.overprivilegedAgents, postureRuleWeights.overprivilegedAgents),
      summary: `${input.overprivilegedAgents} agent${input.overprivilegedAgents === 1 ? '' : 's'} are marked overprivileged`,
    },
    {
      id: 'unknownSystems',
      count: input.unknownSystems,
      penalty: penalty(input.unknownSystems, postureRuleWeights.unknownSystems),
      summary: `${input.unknownSystems} AI system${input.unknownSystems === 1 ? '' : 's'} ha${input.unknownSystems === 1 ? 's' : 've'} unknown Guard status`,
    },
    {
      id: 'disabledEnforcement',
      count: input.enforcementDisabled ? 1 : 0,
      penalty: penalty(input.enforcementDisabled ? 1 : 0, postureRuleWeights.disabledEnforcement),
      summary: 'Guard enforcement is disabled for this deployment',
    },
  ];

  const findings = candidates.filter((finding) => finding.penalty > 0);
  const deducted = findings.reduce((total, finding) => total + finding.penalty, 0);
  const score = Math.max(0, 100 - deducted);
  return { score, status: statusFor(score), findings };
}
