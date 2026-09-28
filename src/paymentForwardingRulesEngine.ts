/**
 * Payment forwarding rules engine.
 *
 * Evaluates a set of ordered forwarding rules against an incoming payment and
 * decides where (and whether) the payment should be forwarded. Emits events for
 * rule evaluation and forwarding outcomes so callers can observe/audit decisions.
 */

export type Payment = {
  id: string;
  amount: number;
  currency: string;
  source: string;
  destination: string;
  metadata?: Record<string, unknown>;
};

export type RuleCondition = {
  /** Field on the payment to inspect. */
  field: keyof Payment | string;
  /** Comparison operator. */
  operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains';
  /** Value to compare against. */
  value: unknown;
};

export type ForwardingRule = {
  id: string;
  /** Higher priority rules are evaluated first. */
  priority?: number;
  /** All conditions must match for the rule to apply. */
  conditions: RuleCondition[];
  /** Destination to forward to when the rule matches. */
  forwardTo: string;
  /** When true, stop evaluating further rules after this one matches. */
  terminal?: boolean;
  enabled?: boolean;
};

export type ForwardingDecision = {
  paymentId: string;
  forwarded: boolean;
  destination: string | null;
  matchedRuleId: string | null;
  reason: string;
};

export type RulesEngineEvent =
  | { type: 'rule:evaluated'; ruleId: string; paymentId: string; matched: boolean }
  | { type: 'rule:skipped'; ruleId: string; paymentId: string; reason: string }
  | { type: 'forwarding:decided'; decision: ForwardingDecision }
  | { type: 'forwarding:error'; paymentId: string; error: Error };

export type RulesEngineListener = (event: RulesEngineEvent) => void;

function getField(payment: Payment, field: string): unknown {
  if (field in payment) {
    return (payment as Record<string, unknown>)[field];
  }
  return payment.metadata ? payment.metadata[field] : undefined;
}

function compare(actual: unknown, operator: RuleCondition['operator'], expected: unknown): boolean {
  switch (operator) {
    case 'eq':
      return actual === expected;
    case 'neq':
      return actual !== expected;
    case 'gt':
      return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
    case 'gte':
      return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
    case 'lt':
      return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
    case 'lte':
      return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
    case 'in':
      return Array.isArray(expected) && expected.includes(actual);
    case 'contains':
      return typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected);
    default:
      return false;
  }
}

export class PaymentForwardingRulesEngine {
  private rules: ForwardingRule[];
  private listeners: Set<RulesEngineListener> = new Set();

  constructor(rules: ForwardingRule[] = []) {
    this.rules = [...rules];
  }

  /** Replace the current rule set. */
  setRules(rules: ForwardingRule[]): void {
    this.rules = [...rules];
  }

  /** Add a rule to the engine. */
  addRule(rule: ForwardingRule): void {
    this.rules.push(rule);
  }

  /** Subscribe to engine events. Returns an unsubscribe function. */
  on(listener: RulesEngineListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: RulesEngineEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Listener errors must not break rule evaluation.
      }
    }
  }

  /** Evaluate a single rule against a payment. */
  evaluateRule(rule: ForwardingRule, payment: Payment): boolean {
    return rule.conditions.every((condition) =>
      compare(getField(payment, condition.field as string), condition.operator, condition.value),
    );
  }

  /**
   * Evaluate all rules against a payment and return the forwarding decision.
   * Rules are evaluated in priority order (highest first).
   */
  evaluate(payment: Payment): ForwardingDecision {
    const ordered = [...this.rules].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

    for (const rule of ordered) {
      if (rule.enabled === false) {
        this.emit({ type: 'rule:skipped', ruleId: rule.id, paymentId: payment.id, reason: 'disabled' });
        continue;
      }

      let matched = false;
      try {
        matched = this.evaluateRule(rule, payment);
      } catch (error) {
        this.emit({ type: 'forwarding:error', paymentId: payment.id, error: error as Error });
        continue;
      }

      this.emit({ type: 'rule:evaluated', ruleId: rule.id, paymentId: payment.id, matched });

      if (matched) {
        const decision: ForwardingDecision = {
          paymentId: payment.id,
          forwarded: true,
          destination: rule.forwardTo,
          matchedRuleId: rule.id,
          reason: `matched rule ${rule.id}`,
        };
        this.emit({ type: 'forwarding:decided', decision });
        return decision;
      }

      if (rule.terminal) {
        break;
      }
    }

    const decision: ForwardingDecision = {
      paymentId: payment.id,
      forwarded: false,
      destination: null,
      matchedRuleId: null,
      reason: 'no matching rule',
    };
    this.emit({ type: 'forwarding:decided', decision });
    return decision;
  }
}
