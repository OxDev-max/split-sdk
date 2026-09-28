/**
 * Access Control List (ACL) manager for application-level authorization.
 *
 * Manages off-chain access grants for resources like invoices.
 */

export interface AsyncAclStore {
  grant(resourceId: string, address: string): Promise<void>;
  revoke(resourceId: string, address: string): Promise<void>;
  check(resourceId: string, address: string): Promise<boolean>;
}

export interface AclManagerOptions {
  cacheTtlMs?: number;
}

interface CacheEntry {
  value: boolean;
  expiresAt: number;
}

class InMemoryAclStore implements AsyncAclStore {
  private grants = new Map<string, Set<string>>();

  async grant(resourceId: string, address: string): Promise<void> {
    if (!this.grants.has(resourceId)) {
      this.grants.set(resourceId, new Set());
    }
    this.grants.get(resourceId)!.add(address);
  }

  async revoke(resourceId: string, address: string): Promise<void> {
    this.grants.get(resourceId)?.delete(address);
  }

  async check(resourceId: string, address: string): Promise<boolean> {
    return this.grants.get(resourceId)?.has(address) ?? false;
  }
}

/**
 * Manager for access control lists.
 *
 * Supports custom storage backends for persistence.
 */
export class AclManager {
  private readonly store: AsyncAclStore;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(store?: AsyncAclStore, options: AclManagerOptions = {}) {
    this.store = store ?? new InMemoryAclStore();
    this.cacheTtlMs = options.cacheTtlMs ?? 60_000;
  }

  /**
   * Grant access to a resource for an address.
   *
   * @param resourceId - Resource identifier
   * @param address - Stellar address to grant access
   */
  async grant(resourceId: string, address: string): Promise<void> {
    await this.store.grant(resourceId, address);
    this.invalidateCache(address);
  }

  /**
   * Revoke access to a resource for an address.
   *
   * @param resourceId - Resource identifier
   * @param address - Stellar address to revoke access
   */
  async revoke(resourceId: string, address: string): Promise<void> {
    await this.store.revoke(resourceId, address);
    this.invalidateCache(address);
  }

  /**
   * Check if an address has access to a resource.
   *
   * @param resourceId - Resource identifier
   * @param address - Stellar address to check
   * @returns True if access is granted
   */
  async check(resourceId: string, address: string): Promise<boolean> {
    const key = this.cacheKey(resourceId, address);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const allowed = await this.store.check(resourceId, address);
    this.cache.set(key, {
      value: allowed,
      expiresAt: Date.now() + this.cacheTtlMs,
    });
    return allowed;
  }

  invalidateCache(principal: string): void {
    for (const key of this.cache.keys()) {
      if (key.endsWith(`:${principal}`)) {
        this.cache.delete(key);
      }
    }
  }

  private cacheKey(resourceId: string, address: string): string {
    return `${resourceId}:${address}`;
  }
}

export type WithdrawalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "executed";

export interface WithdrawalRequest {
  id: string;
  resourceId: string;
  requester: string;
  amount: string;
  status: WithdrawalStatus;
  approvals: string[];
  rejections: string[];
  createdAt: number;
  updatedAt: number;
}

export interface WithdrawalApprovalOptions {
  requiredApprovals?: number;
  acl?: AclManager;
}

export type WithdrawalEventType =
  | "submitted"
  | "approved"
  | "rejected"
  | "executed";

export interface WithdrawalEvent {
  type: WithdrawalEventType;
  request: WithdrawalRequest;
  actor: string;
  timestamp: number;
}

export type WithdrawalEventListener = (event: WithdrawalEvent) => void;

/**
 * Manages custody withdrawal approval workflows.
 *
 * A withdrawal request moves through a multi-step approval state machine:
 * pending -> approved (once enough approvals are collected) -> executed,
 * or pending -> rejected. Approvers must hold access to the resource
 * when an AclManager is provided.
 */
export class WithdrawalApprovalWorkflow {
  private readonly requiredApprovals: number;
  private readonly acl?: AclManager;
  private readonly requests = new Map<string, WithdrawalRequest>();
  private readonly listeners = new Set<WithdrawalEventListener>();

  constructor(options: WithdrawalApprovalOptions = {}) {
    this.requiredApprovals = options.requiredApprovals ?? 1;
    if (this.requiredApprovals < 1) {
      throw new Error("requiredApprovals must be at least 1");
    }
    this.acl = options.acl;
  }

  /**
   * Register a listener for withdrawal lifecycle events.
   *
   * @returns An unsubscribe function.
   */
  onEvent(listener: WithdrawalEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Submit a new withdrawal request in the pending state.
   */
  async submit(params: {
    id: string;
    resourceId: string;
    requester: string;
    amount: string;
  }): Promise<WithdrawalRequest> {
    if (this.requests.has(params.id)) {
      throw new Error(`Withdrawal request ${params.id} already exists`);
    }
    const now = Date.now();
    const request: WithdrawalRequest = {
      id: params.id,
      resourceId: params.resourceId,
      requester: params.requester,
      amount: params.amount,
      status: "pending",
      approvals: [],
      rejections: [],
      createdAt: now,
      updatedAt: now,
    };
    this.requests.set(request.id, request);
    this.emit("submitted", request, params.requester);
    return request;
  }

  /**
   * Approve a pending withdrawal request.
   */
  async approve(id: string, approver: string): Promise<WithdrawalRequest> {
    const request = this.getRequest(id);
    if (request.status !== "pending") {
      throw new Error(`Cannot approve request in status ${request.status}`);
    }
    if (approver === request.requester) {
      throw new Error("Requester cannot approve their own withdrawal");
    }
    if (request.approvals.includes(approver)) {
      throw new Error(`Approver ${approver} has already approved`);
    }
    if (this.acl && !(await this.acl.check(request.resourceId, approver))) {
      throw new Error(`Approver ${approver} lacks access to resource`);
    }

    request.approvals.push(approver);
    request.updatedAt = Date.now();
    if (request.approvals.length >= this.requiredApprovals) {
      request.status = "approved";
    }
    this.emit("approved", request, approver);
    return request;
  }

  /**
   * Reject a pending withdrawal request.
   */
  async reject(id: string, rejector: string): Promise<WithdrawalRequest> {
    const request = this.getRequest(id);
    if (request.status !== "pending") {
      throw new Error(`Cannot reject request in status ${request.status}`);
    }
    if (request.rejections.includes(rejector)) {
      throw new Error(`Rejector ${rejector} has already rejected`);
    }
    if (this.acl && !(await this.acl.check(request.resourceId, rejector))) {
      throw new Error(`Rejector ${rejector} lacks access to resource`);
    }

    request.rejections.push(rejector);
    request.status = "rejected";
    request.updatedAt = Date.now();
    this.emit("rejected", request, rejector);
    return request;
  }

  /**
   * Execute an approved withdrawal request.
   */
  async execute(id: string, executor: string): Promise<WithdrawalRequest> {
    const request = this.getRequest(id);
    if (request.status !== "approved") {
      throw new Error(`Cannot execute request in status ${request.status}`);
    }
    request.status = "executed";
    request.updatedAt = Date.now();
    this.emit("executed", request, executor);
    return request;
  }

  /**
   * Retrieve a withdrawal request by id.
   */
  get(id: string): WithdrawalRequest | undefined {
    return this.requests.get(id);
  }

  private getRequest(id: string): WithdrawalRequest {
    const request = this.requests.get(id);
    if (!request) {
      throw new Error(`Withdrawal request ${id} not found`);
    }
    return request;
  }

  private emit(
    type: WithdrawalEventType,
    request: WithdrawalRequest,
    actor: string,
  ): void {
    const event: WithdrawalEvent = {
      type,
      request,
      actor,
      timestamp: Date.now(),
    };
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
