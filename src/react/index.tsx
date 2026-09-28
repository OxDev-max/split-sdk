/**
 * @stellar-split/sdk/react
 *
 * React 18+ hooks for the StellarSplit SDK. Compatible with Next.js App Router.
 *
 * Usage:
 * ```tsx
 * import { StellarSplitProvider, useInvoice } from '@stellar-split/sdk/react';
 *
 * function App() {
 *   return (
 *     <StellarSplitProvider client={client}>
 *       <InvoiceView id="123" />
 *     </StellarSplitProvider>
 *   );
 * }
 *
 * function InvoiceView({ id }: { id: string }) {
 *   const { data, loading, error, refetch } = useInvoice(id);
 *   if (loading) return <span>Loading…</span>;
 *   if (error)   return <span>Error: {error.message}</span>;
 *   return <pre>{JSON.stringify(data, null, 2)}</pre>;
 * }
 * ```
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import type { Invoice, InvoiceEvent } from "../types.js";
import type { StellarSplitClient } from "../client.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** ProtocolStats returned by {@link useProtocolStats}. */
export interface ProtocolStats {
  /** Total number of invoices created on-chain. */
  totalInvoices: number;
  /** Total amount released in stroops. */
  totalReleased: bigint;
  /** Number of currently pending invoices. */
  pendingInvoices: number;
}

/** Filter options accepted by {@link useCreatorInvoices}. */
export interface InvoiceFilter {
  /** Only return invoices with this status. */
  status?: import("../types.js").InvoiceStatus;
  /** Maximum number of items to return. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface StellarSplitContextValue {
  client: StellarSplitClient;
}

const StellarSplitContext = createContext<StellarSplitContextValue | null>(
  null,
);

/** Props for {@link StellarSplitProvider}. */
export interface StellarSplitProviderProps {
  /** A fully-initialised {@link StellarSplitClient} instance. */
  client: StellarSplitClient;
  children: ReactNode;
}

/**
 * Context provider. Wrap your application (or test tree) with this component
 * to give all child hooks access to the same SDK client instance.
 */
export function StellarSplitProvider({
  client,
  children,
}: StellarSplitProviderProps): React.ReactElement {
  const value = React.useMemo(() => ({ client }), [client]);
  return (
    <StellarSplitContext.Provider value={value}>
      {children}
    </StellarSplitContext.Provider>
  );
}

/**
 * Access the {@link StellarSplitClient} provided by the nearest
 * {@link StellarSplitProvider}.
 *
 * Throws if called outside of a provider.
 */
export function useStellarSplitClient(): StellarSplitClient {
  const ctx = useContext(StellarSplitContext);
  if (!ctx) {
    throw new Error(
      "useStellarSplitClient must be used inside a <StellarSplitProvider>.",
    );
  }
  return ctx.client;
}

// ---------------------------------------------------------------------------
// useInvoice
// ---------------------------------------------------------------------------

/** Result returned by {@link useInvoice}. */
export interface UseInvoiceResult {
  data: Invoice | null;
  loading: boolean;
  error: Error | null;
  /** Manually re-fetch the invoice from the contract. */
  refetch: () => Promise<void>;
}

/**
 * Fetch a single invoice by ID. Automatically re-fetches whenever
 * `invoiceId` changes.
 *
 * @param invoiceId - The on-chain invoice ID to load.
 * @param client    - Optional client override; defaults to context client.
 */
export function useInvoice(
  invoiceId: string,
  client?: StellarSplitClient,
): UseInvoiceResult {
  const contextClient = useContext(StellarSplitContext)?.client;
  const effectiveClient = client ?? contextClient;

  const [data, setData] = useState<Invoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const mountedRef = useRef(true);

  const fetch = useCallback(async () => {
    if (!effectiveClient) {
      setError(
        new Error(
          "No StellarSplitClient available. Provide one via <StellarSplitProvider> or the client prop.",
        ),
      );
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const invoice = await effectiveClient.getInvoice(invoiceId);
      if (mountedRef.current) {
        setData(invoice);
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [invoiceId, effectiveClient]);

  useEffect(() => {
    mountedRef.current = true;
    void fetch();
    return () => {
      mountedRef.current = false;
    };
  }, [fetch]);

  return { data, loading, error, refetch: fetch };
}

// ---------------------------------------------------------------------------
// useCreatorInvoices
// ---------------------------------------------------------------------------

/** Result returned by {@link useCreatorInvoices}. */
export interface UseCreatorInvoicesResult {
  data: Invoice[];
  loading: boolean;
  error: Error | null;
  /** Whether more pages are available. */
  hasMore: boolean;
  /** Load the next page and append to `data`. */
  loadMore: () => Promise<void>;
}

/**
 * Fetch all invoices created by a given address, with optional filtering and
 * built-in pagination via `loadMore`.
 *
 * @param creator - Stellar address of the invoice creator.
 * @param filter  - Optional filter options (status, limit).
 * @param client  - Optional client override.
 */
export function useCreatorInvoices(
  creator: string,
  filter?: InvoiceFilter,
  client?: StellarSplitClient,
): UseCreatorInvoicesResult {
  const contextClient = useContext(StellarSplitContext)?.client;
  const effectiveClient = client ?? contextClient;

  const [data, setData] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const pageSize = filter?.limit ?? 20;

  const fetchPage = useCallback(
    async (nextCursor?: string | null, append = false) => {
      if (!effectiveClient) {
        setError(
          new Error(
            "No StellarSplitClient available. Provide one via <StellarSplitProvider> or the client prop.",
          ),
        );
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const result = await effectiveClient.getInvoicesByCreator(creator, {
          limit: pageSize,
          ...(nextCursor ? { cursor: nextCursor } : {}),
        });

        // result.items are IDs — fetch each invoice
        const invoices = await Promise.all(
          result.items.map((id) => effectiveClient.getInvoice(id)),
        );

        // Apply status filter client-side if requested
        const filtered = filter?.status
          ? invoices.filter((inv) => inv.status === filter.status)
          : invoices;

        if (mountedRef.current) {
          setData((prev) => (append ? [...prev, ...filtered] : filtered));
          setCursor(result.nextCursor);
          setHasMore(result.nextCursor !== null);
        }
      } catch (err) {
        if (mountedRef.current) {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        if (mountedRef.current) {
          setLoading(false);
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [creator, effectiveClient, pageSize, filter?.status],
  );

  useEffect(() => {
    mountedRef.current = true;
    void fetchPage(null, false);
    return () => {
      mountedRef.current = false;
    };
  }, [fetchPage]);

  const loadMore = useCallback(async () => {
    if (hasMore) {
      await fetchPage(cursor, true);
    }
  }, [hasMore, cursor, fetchPage]);

  return { data, loading, error, hasMore, loadMore };
}

// ---------------------------------------------------------------------------
// useProtocolStats
// ---------------------------------------------------------------------------

/** Result returned by {@link useProtocolStats}. */
export interface UseProtocolStatsResult {
  data: ProtocolStats | null;
  loading: boolean;
  error: Error | null;
}

/**
 * Load high-level protocol statistics. The stats are derived from the
 * client's health-check and available on-chain aggregates.
 *
 * @param client - Optional client override.
 */
export function useProtocolStats(
  client?: StellarSplitClient,
): UseProtocolStatsResult {
  const contextClient = useContext(StellarSplitContext)?.client;
  const effectiveClient = client ?? contextClient;

  const [data, setData] = useState<ProtocolStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    if (!effectiveClient) {
      setError(
        new Error(
          "No StellarSplitClient available. Provide one via <StellarSplitProvider> or the client prop.",
        ),
      );
      setLoading(false);
      return;
    }

    (async () => {
      setLoading(true);
      setError(null);
      try {
        // Use checkHealth if available, otherwise return a minimal default.
        const health = await (effectiveClient as StellarSplitClient & {
          checkHealth?(): Promise<unknown>;
        }).checkHealth?.();

        if (mountedRef.current) {
          // Build a minimal ProtocolStats from whatever health exposes.
          const stats: ProtocolStats = {
            totalInvoices: 0,
            totalReleased: 0n,
            pendingInvoices: 0,
            ...((health as Partial<ProtocolStats>) ?? {}),
          };
          setData(stats);
        }
      } catch (err) {
        if (mountedRef.current) {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        if (mountedRef.current) {
          setLoading(false);
        }
      }
    })();

    return () => {
      mountedRef.current = false;
    };
  }, [effectiveClient]);

  return { data, loading, error };
}

// ---------------------------------------------------------------------------
// useInvoiceStream
// ---------------------------------------------------------------------------

/** Result returned by {@link useInvoiceStream}. */
export interface UseInvoiceStreamResult {
  /** The most recently received event, or null before any event fires. */
  latestEvent: InvoiceEvent | null;
  /** Whether the subscription is currently active. */
  isConnected: boolean;
  error: Error | null;
}

/**
 * Subscribe to real-time events for a single invoice. The subscription is
 * automatically torn down when the component unmounts.
 *
 * @param invoiceId - The invoice ID to subscribe to.
 * @param client    - Optional client override.
 */
export function useInvoiceStream(
  invoiceId: string,
  client?: StellarSplitClient,
): UseInvoiceStreamResult {
  const contextClient = useContext(StellarSplitContext)?.client;
  const effectiveClient = client ?? contextClient;

  const [latestEvent, setLatestEvent] = useState<InvoiceEvent | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const subRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!effectiveClient || !invoiceId) {
      setError(
        new Error(
          "No StellarSplitClient available. Provide one via <StellarSplitProvider> or the client prop.",
        ),
      );
      return;
    }

    try {
      // subscribeToInvoice on StellarSplitClient uses SSEInvoiceEvent (from sse.ts)
      // which has a different shape from the InvoiceEvent in types.ts.
      // We cast via unknown to bridge the two type worlds at this integration point.
      const handler = (event: unknown) => {
        setLatestEvent(event as InvoiceEvent);
      };
      const unsubscribe = (effectiveClient.subscribeToInvoice as unknown as (
        invoiceId: string,
        handler: (event: unknown) => void,
      ) => () => void)(invoiceId, handler);
      subRef.current = unsubscribe;
      setIsConnected(true);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      setIsConnected(false);
    }

    return () => {
      subRef.current?.();
      subRef.current = null;
      setIsConnected(false);
    };
  }, [invoiceId, effectiveClient]);

  return { latestEvent, isConnected, error };
}
