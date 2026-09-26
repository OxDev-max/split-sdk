import type { StellarSplitClient } from "./client.js";

export interface QueuedOperation {
  id: string;
  method: string;
  args: any[];
  timestamp: number;
}

export interface OfflineQueueConfig {
  enabled: boolean;
  maxQueueSize: number;
  persistToStorage: boolean;
}

export class OfflineQueue {
  private queue: QueuedOperation[] = [];
  private config: OfflineQueueConfig;
  private client: StellarSplitClient;
  private readonly storageKey = "stellar_split_offline_queue";

  constructor(client: StellarSplitClient, config: OfflineQueueConfig) {
    this.client = client;
    this.config = config;
    if (this.config.persistToStorage) {
      this.loadFromStorage();
    }
  }

  public enqueue(method: string, args: any[]): void {
    if (!this.config.enabled) return;

    if (this.queue.length >= this.config.maxQueueSize) {
      this.queue.shift();
    }

    const operation: QueuedOperation = {
      id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2),
      method,
      args,
      timestamp: Date.now(),
    };

    this.queue.push(operation);

    if (this.config.persistToStorage) {
      this.saveToStorage();
    }
  }

  public getQueue(): QueuedOperation[] {
    return [...this.queue];
  }

  public clear(): void {
    this.queue = [];
    if (this.config.persistToStorage) {
      this.saveToStorage();
    }
  }

  public async drain(): Promise<void> {
    if (this.queue.length === 0) return;

    const operationsToDrain = [...this.queue];
    this.clear();

    for (const op of operationsToDrain) {
      try {
        // @ts-ignore
        await this.client[op.method](...op.args);
      } catch (error) {
        this.client.emit("queue:operation:failed", { operation: op, error });
      }
    }

    this.client.emit("queue:drained", undefined);
  }

  private loadFromStorage(): void {
    if (typeof localStorage !== "undefined") {
      try {
        const stored = localStorage.getItem(this.storageKey);
        if (stored) {
          this.queue = JSON.parse(stored);
        }
      } catch (e) {
        console.warn("Failed to load offline queue from storage", e);
      }
    }
  }

  private saveToStorage(): void {
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.setItem(this.storageKey, JSON.stringify(this.queue));
      } catch (e) {
        console.warn("Failed to save offline queue to storage", e);
      }
    }
  }
}
