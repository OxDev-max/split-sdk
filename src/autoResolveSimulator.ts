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
 * Lifecycle phase of a simulated transaction rollback.
 */
export type RollbackPhase = "start" | "success" | "failure";

/**
 * Event emitted as a simulated transaction rollback progresses through its
 * lifecycle. `start` is emitted before the simulated transaction is applied,
 * followed by exactly one terminal event (`success` or `failure`).
 */
export interface RollbackEvent {
  phase: RollbackPhase;
  /** Human-readable description of the phase. */
  message: string;
  /** Error that caused a `failure` event, when applicable. */
  error?: Error;
}

/**
 * A single step in a simulated transaction. Each step is applied in order and
 * may throw to signal that the transaction should be rolled back.
 */
export interface RollbackStep<TState> {
  /** Label used in emitted events and error messages. */
  name: string;
  /** Pure function that produces the next state from the current state. */
  apply: (state: TState) => TState;
}

/**
 * Result of simulating a transaction rollback.
 */
export interface RollbackSimulationResult<TState> {
  /** Whether every step applied without throwing. */
  committed: boolean;
  /** State after the simulation: the committed state or the original state. */
  state: TState;
  /** Name of the step that failed, or `null` when the transaction committed. */
  failedStep: string | null;
  /** Error thrown by the failing step, or `null` when the transaction committed. */
  error: Error | null;
  /** Ordered lifecycle events emitted during the simulation. */
  events: RollbackEvent[];
}

/**
 * Simulate a transaction against an initial state, rolling back to that state
 * if any step throws.
 *
 * Steps are applied in order to a working copy of the state. If a step throws,
 * the working copy is discarded and the original state is returned, mirroring
 * the all-or-nothing semantics of an on-chain transaction. Lifecycle events are
 * emitted for the start of the simulation and for its terminal outcome.
 *
 * Pure function — performs no RPC calls and never mutates `initialState`.
 *
 * @param initialState - State the transaction starts from and rolls back to.
 * @param steps        - Ordered steps to apply.
 * @param onEvent      - Optional listener invoked for each lifecycle event.
 * @returns The simulation result, including the emitted events.
 */
export function simulateTransactionRollback<TState>(
  initialState: TState,
  steps: ReadonlyArray<RollbackStep<TState>>,
  onEvent?: (event: RollbackEvent) => void,
): RollbackSimulationResult<TState> {
  const events: RollbackEvent[] = [];

  const emit = (event: RollbackEvent): void => {
    events.push(event);
    onEvent?.(event);
  };

  emit({
    phase: "start",
    message: `Simulating transaction with ${steps.length} step(s)`,
  });

  let workingState = initialState;

  for (const step of steps) {
    try {
      workingState = step.apply(workingState);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      emit({
        phase: "failure",
        message: `Step "${step.name}" failed; rolling back`,
        error,
      });
      return {
        committed: false,
        state: initialState,
        failedStep: step.name,
        error,
        events,
      };
    }
  }

  emit({
    phase: "success",
    message: `Transaction committed after ${steps.length} step(s)`,
  });

  return {
    committed: true,
    state: workingState,
    failedStep: null,
    error: null,
    events,
  };
}
