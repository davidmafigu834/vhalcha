import { estimateRequestTokens, estimateTextTokens } from './estimate';
import type { RequestClassifier, RequestProfile, RouteRiskLevel } from './types';

export { estimateTextTokens as estimateTokens };

/**
 * Deterministic request profile.
 *
 * Request size is message length. This classifier does not understand whether a
 * short sentence is a hard legal task. It does not infer vision or tool use:
 * the public chat schema is text only, so those signals are not available.
 * Structured output is set only when the text contains the word "json". That
 * keyword is a weak compatibility signal, not a schema validator.
 */
export class HeuristicRequestClassifier implements RequestClassifier {
  classify(input: {
    messages: Array<{ role: string; content: string }>;
    maxTokens?: number;
    hasKnowledgeContext: boolean;
    systemRisk: 'low' | 'medium' | 'high' | 'critical';
  }): RequestProfile {
    const estimate = estimateRequestTokens(input.messages, input.maxTokens);
    const joined = input.messages.map((message) => message.content).join('\n');
    const latestUser = [...input.messages].reverse().find((message) => message.role === 'user')?.content ?? '';
    const taskType = /\bclassify\b/i.test(latestUser) ? 'classification' : 'chat';
    const requiredCapabilities = ['chat'];
    if (taskType === 'classification') {
      requiredCapabilities.push('classification');
    }
    const requiresStructuredOutput = /\bjson\b/i.test(joined);
    if (requiresStructuredOutput) {
      requiredCapabilities.push('structured_output');
    }
    return {
      taskType,
      estimatedInputTokens: estimate.estimatedInputTokens,
      estimatedOutputTokens: estimate.estimatedOutputTokens,
      requestSize: estimate.requestSize,
      complexity: estimate.requestSize,
      risk: mapRisk(input.systemRisk),
      requiredCapabilities,
      hasKnowledgeContext: input.hasKnowledgeContext,
      usesTools: false,
      requiresStructuredOutput,
      requiresVision: false,
      expectedLatencyClass: estimate.requestSize === 'small' ? 'fast' : 'normal',
    };
  }
}

function mapRisk(systemRisk: 'low' | 'medium' | 'high' | 'critical'): RouteRiskLevel {
  if (systemRisk === 'critical' || systemRisk === 'high') {
    return 'high';
  }
  if (systemRisk === 'medium') {
    return 'medium';
  }
  return 'low';
}
