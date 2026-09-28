import type { InvoiceStatus } from "./types.js";
import { InvoiceStateMachine } from "./state/InvoiceStateMachine.js";

const defaultStateMachine = new InvoiceStateMachine();

/**
 * Event payload emitted whenever a transition is validated.
 */
export interface TransitionValidationEvent {
  from: InvoiceStatus;
  to: InvoiceStatus;
  valid: boolean;
}

/**
 * Listener invoked on every transition validation attempt.
 */
export type TransitionValidationListener = (event: TransitionValidationEvent) => void;

/**
 * Listener invoked when a transition is rejected as invalid.
 */
export type TransitionFailureListener = (event: TransitionValidationEvent) => void;

/**
 * SDK state machine validator.
 *
 * Wraps an {@link InvoiceStateMachine} to validate allowed/denied transitions
 * and to emit events for successful and failed validations.
 */
export class StateMachineValidator {
  private readonly machine: InvoiceStateMachine;
  private readonly validationListeners = new Set<TransitionValidationListener>();
  private readonly failureListeners = new Set<TransitionFailureListener>();

  constructor(machine: InvoiceStateMachine = new InvoiceStateMachine()) {
    this.machine = machine;
  }

  /**
   * Validate a transition from one state to another.
   * Emits a validation event for every attempt and a failure event when invalid.
   */
  validate(from: InvoiceStatus, to: InvoiceStatus): boolean {
    const valid = this.machine.validate(from, to);
    const event: TransitionValidationEvent = { from, to, valid };

    for (const listener of this.validationListeners) {
      listener(event);
    }

    if (!valid) {
      for (const listener of this.failureListeners) {
        listener(event);
      }
    }

    return valid;
  }

  /**
   * Assert that a transition is valid, throwing when it is not.
   */
  assertTransition(from: InvoiceStatus, to: InvoiceStatus): void {
    if (!this.validate(from, to)) {
      throw new Error(`Invalid state transition: ${from} -> ${to}`);
    }
  }

  /**
   * Register a listener for all transition validation attempts.
   * Returns an unsubscribe function.
   */
  onValidation(listener: TransitionValidationListener): () => void {
    this.validationListeners.add(listener);
    return () => {
      this.validationListeners.delete(listener);
    };
  }

  /**
   * Register a listener for failed transition validations.
   * Returns an unsubscribe function.
   */
  onFailure(listener: TransitionFailureListener): () => void {
    this.failureListeners.add(listener);
    return () => {
      this.failureListeners.delete(listener);
    };
  }
}

/** @deprecated Use InvoiceStateMachine (src/state/InvoiceStateMachine.ts) directly. */
export function validateTransition(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return defaultStateMachine.validate(from, to);
}
