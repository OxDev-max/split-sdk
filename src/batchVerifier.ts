import { EventEmitter } from 'events';

export interface PortfolioScenario {
  id: string;
  name?: string;
  initialValue: number;
  returns: number[];
  weights?: number[];
}

export interface ScenarioResult {
  id: string;
  name?: string;
  success: boolean;
  finalValue?: number;
  totalReturn?: number;
  error?: string;
}

export interface BatchSimulationSummary {
  total: number;
  succeeded: number;
  failed: number;
  results: ScenarioResult[];
  aggregateFinalValue: number;
  aggregateReturn: number;
}

export interface BatchSimulationOptions {
  /** Continue running remaining scenarios when one fails. Defaults to true. */
  continueOnError?: boolean;
  /** Optional per-scenario simulator. Defaults to compounding returns. */
  simulate?: (scenario: PortfolioScenario) => ScenarioResult;
}

/**
 * Simulates a single portfolio scenario by compounding its periodic returns.
 */
export function simulateScenario(scenario: PortfolioScenario): ScenarioResult {
  const { id, name, initialValue, returns } = scenario;

  if (typeof initialValue !== 'number' || !isFinite(initialValue)) {
    return { id, name, success: false, error: 'initialValue must be a finite number' };
  }
  if (!Array.isArray(returns)) {
    return { id, name, success: false, error: 'returns must be an array' };
  }

  let value = initialValue;
  for (let i = 0; i < returns.length; i++) {
    const r = returns[i];
    if (typeof r !== 'number' || !isFinite(r)) {
      return { id, name, success: false, error: `returns[${i}] must be a finite number` };
    }
    value *= 1 + r;
  }

  const totalReturn = initialValue === 0 ? 0 : (value - initialValue) / initialValue;
  return { id, name, success: true, finalValue: value, totalReturn };
}

/**
 * Runs a batch of portfolio scenarios and aggregates the results.
 * Emits: 'batch:start', 'scenario:start', 'scenario:complete',
 * 'scenario:error', 'batch:complete', 'batch:error'.
 */
export class BatchVerifier extends EventEmitter {
  private readonly options: Required<Pick<BatchSimulationOptions, 'continueOnError'>> &
    Pick<BatchSimulationOptions, 'simulate'>;

  constructor(options: BatchSimulationOptions = {}) {
    super();
    this.options = {
      continueOnError: options.continueOnError !== false,
      simulate: options.simulate,
    };
  }

  /**
   * Simulates all provided scenarios in a single batch.
   */
  run(scenarios: PortfolioScenario[]): BatchSimulationSummary {
    if (!Array.isArray(scenarios)) {
      const error = new Error('scenarios must be an array');
      this.emit('batch:error', error);
      throw error;
    }

    this.emit('batch:start', { total: scenarios.length });

    const results: ScenarioResult[] = [];
    const simulate = this.options.simulate ?? simulateScenario;

    for (const scenario of scenarios) {
      this.emit('scenario:start', scenario);
      let result: ScenarioResult;
      try {
        result = simulate(scenario);
      } catch (err) {
        result = {
          id: scenario?.id,
          name: scenario?.name,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }

      results.push(result);

      if (result.success) {
        this.emit('scenario:complete', result);
      } else {
        this.emit('scenario:error', result);
        if (!this.options.continueOnError) {
          const error = new Error(result.error ?? 'scenario failed');
          this.emit('batch:error', error);
          throw error;
        }
      }
    }

    const succeeded = results.filter((r) => r.success).length;
    const failed = results.length - succeeded;
    const aggregateFinalValue = results.reduce(
      (sum, r) => sum + (r.success && typeof r.finalValue === 'number' ? r.finalValue : 0),
      0,
    );
    const aggregateInitial = scenarios.reduce(
      (sum, s) => sum + (typeof s?.initialValue === 'number' && isFinite(s.initialValue) ? s.initialValue : 0),
      0,
    );
    const aggregateReturn =
      aggregateInitial === 0 ? 0 : (aggregateFinalValue - aggregateInitial) / aggregateInitial;

    const summary: BatchSimulationSummary = {
      total: results.length,
      succeeded,
      failed,
      results,
      aggregateFinalValue,
      aggregateReturn,
    };

    this.emit('batch:complete', summary);
    return summary;
  }
}

export default BatchVerifier;
