import type { Invoice, AutoResolveRule, AutoResolveSimulation } from "./types.js";

/**
 * Determine whether a single auto-resolve rule matches the funded amount.
 *
 * @param rule   - The rule to evaluate.
 * @param funded - The invoice's current funded amount in stroops.
 */
function ruleMatches(rule: AutoResolveRule, funded: bigint): boolean {
  const comparator = rule.comparator ?? "gte";
  return comparator === "lt"
    ? funded < rule.threshold
    : funded >= rule.threshold;
}

/**
 * Evaluate an invoice's `auto_resolve_rules` against its current funded amount
 * and report what action `auto_resolve()` would take if called now.
 *
 * Pure function — performs no RPC calls. Rules are evaluated in order and the
 * first match wins. When no rule's threshold is met, `wouldResolve` is false.
 *
 * @param invoice - The invoice to simulate.
 * @returns The simulated outcome.
 */
export function simulateAutoResolve(invoice: Invoice): AutoResolveSimulation {
  const rules = invoice.auto_resolve_rules ?? [];

  for (const rule of rules) {
    if (ruleMatches(rule, invoice.funded)) {
      return {
        wouldResolve: true,
        action: rule.action,
        matchedRule: rule,
      };
    }
  }

  return { wouldResolve: false, action: null, matchedRule: null };
}

/**
 * A single scenario in a batch simulation: an invoice to evaluate together
 * with an optional label used to identify it in the aggregated results.
 */
export interface BatchSimulationScenario {
  /** Optional human-readable label for the scenario. */
  label?: string;
  /** The invoice to simulate. */
  invoice: Invoice;
}

/**
 * The outcome of a single scenario within a batch simulation.
 */
export interface BatchSimulationResult {
  /** Index of the scenario in the original batch. */
  index: number;
  /** The scenario's label, when provided. */
  label?: string;
  /** The simulated outcome, or null when the scenario failed. */
  simulation: AutoResolveSimulation | null;
  /** Error message when the scenario failed to simulate. */
  error: string | null;
}

/**
 * Aggregated summary of a batch simulation run.
 */
export interface BatchSimulationSummary {
  /** Total number of scenarios in the batch. */
  total: number;
  /** Number of scenarios that simulated successfully. */
  succeeded: number;
  /** Number of scenarios that failed. */
  failed: number;
  /** Number of successful scenarios whose outcome would resolve. */
  wouldResolve: number;
  /** Number of successful scenarios whose outcome would not resolve. */
  wouldNotResolve: number;
}

/**
 * The full result of a batch simulation run.
 */
export interface BatchSimulationReport {
  /** Per-scenario results, in the same order as the input batch. */
  results: BatchSimulationResult[];
  /** Aggregated counts across the batch. */
  summary: BatchSimulationSummary;
}

/**
 * Event handlers invoked during a batch simulation run.
 */
export interface BatchSimulationEvents {
  /** Called once when the batch begins, with the total scenario count. */
  onStart?: (total: number) => void;
  /** Called after each scenario completes, with its result. */
  onProgress?: (result: BatchSimulationResult, completed: number, total: number) => void;
  /** Called once when the batch finishes, with the aggregated report. */
  onComplete?: (report: BatchSimulationReport) => void;
  /** Called when a scenario fails, with the error and its index. */
  onError?: (error: Error, index: number) => void;
}

/**
 * Run a batch of portfolio scenarios through {@link simulateAutoResolve} and
 * aggregate the outcomes.
 *
 * Each scenario is evaluated independently: a failure in one scenario is
 * captured in its result and does not abort the batch. Events are emitted for
 * the batch start, per-scenario progress, per-scenario errors, and completion.
 *
 * @param scenarios - The scenarios to simulate.
 * @param events    - Optional event handlers.
 * @returns The aggregated batch simulation report.
 */
export function simulateBatch(
  scenarios: BatchSimulationScenario[],
  events: BatchSimulationEvents = {},
): BatchSimulationReport {
  const total = scenarios.length;
  events.onStart?.(total);

  const results: BatchSimulationResult[] = [];
  let succeeded = 0;
  let failed = 0;
  let wouldResolve = 0;
  let wouldNotResolve = 0;

  scenarios.forEach((scenario, index) => {
    let result: BatchSimulationResult;
    try {
      const simulation = simulateAutoResolve(scenario.invoice);
      result = {
        index,
        label: scenario.label,
        simulation,
        error: null,
      };
      succeeded += 1;
      if (simulation.wouldResolve) {
        wouldResolve += 1;
      } else {
        wouldNotResolve += 1;
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      result = {
        index,
        label: scenario.label,
        simulation: null,
        error: error.message,
      };
      failed += 1;
      events.onError?.(error, index);
    }

    results.push(result);
    events.onProgress?.(result, index + 1, total);
  });

  const report: BatchSimulationReport = {
    results,
    summary: {
      total,
      succeeded,
      failed,
      wouldResolve,
      wouldNotResolve,
    },
  };

  events.onComplete?.(report);
  return report;
}
