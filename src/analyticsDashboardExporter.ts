/**
 * Optional analytics dashboard data export.
 *
 * Provides a small, dependency-free exporter that serializes analytics
 * dashboard data to CSV or JSON and emits lifecycle events for the export
 * (start / complete / error). The feature is opt-in: nothing runs unless a
 * caller explicitly invokes the exporter, so existing default behavior is
 * unchanged.
 */

export type AnalyticsExportFormat = "csv" | "json";

export interface AnalyticsDashboardRow {
  [key: string]: string | number | boolean | null | undefined;
}

export interface AnalyticsExportOptions {
  /** Output format. Defaults to "json". */
  format?: AnalyticsExportFormat;
  /** Optional explicit column ordering for CSV output. */
  columns?: string[];
  /** Optional filename hint included in the completion event. */
  filename?: string;
}

export interface AnalyticsExportStartEvent {
  format: AnalyticsExportFormat;
  rowCount: number;
  filename?: string;
}

export interface AnalyticsExportCompleteEvent {
  format: AnalyticsExportFormat;
  rowCount: number;
  filename?: string;
  data: string;
}

export interface AnalyticsExportErrorEvent {
  format: AnalyticsExportFormat;
  filename?: string;
  error: Error;
}

export interface AnalyticsExportEventMap {
  start: AnalyticsExportStartEvent;
  complete: AnalyticsExportCompleteEvent;
  error: AnalyticsExportErrorEvent;
}

export type AnalyticsExportEventName = keyof AnalyticsExportEventMap;

export type AnalyticsExportListener<K extends AnalyticsExportEventName> = (
  event: AnalyticsExportEventMap[K],
) => void;

/**
 * Minimal typed event emitter used to report export lifecycle events.
 */
export class AnalyticsExportEventEmitter {
  private readonly listeners: {
    [K in AnalyticsExportEventName]: Set<AnalyticsExportListener<K>>;
  } = {
    start: new Set(),
    complete: new Set(),
    error: new Set(),
  };

  on<K extends AnalyticsExportEventName>(
    event: K,
    listener: AnalyticsExportListener<K>,
  ): () => void {
    this.listeners[event].add(listener);
    return () => this.off(event, listener);
  }

  off<K extends AnalyticsExportEventName>(
    event: K,
    listener: AnalyticsExportListener<K>,
  ): void {
    this.listeners[event].delete(listener);
  }

  emit<K extends AnalyticsExportEventName>(
    event: K,
    payload: AnalyticsExportEventMap[K],
  ): void {
    for (const listener of this.listeners[event]) {
      listener(payload);
    }
  }
}

function resolveColumns(
  rows: AnalyticsDashboardRow[],
  columns?: string[],
): string[] {
  if (columns && columns.length > 0) {
    return columns;
  }
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      seen.add(key);
    }
  }
  return Array.from(seen);
}

function escapeCsvValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function toCsv(rows: AnalyticsDashboardRow[], columns: string[]): string {
  const header = columns.map(escapeCsvValue).join(",");
  const body = rows.map((row) =>
    columns.map((column) => escapeCsvValue(row[column])).join(","),
  );
  return [header, ...body].join("\n");
}

function toJson(rows: AnalyticsDashboardRow[]): string {
  return JSON.stringify(rows, null, 2);
}

/**
 * Optional analytics dashboard exporter.
 *
 * Usage:
 * ```ts
 * const exporter = new AnalyticsDashboardExporter();
 * exporter.on("complete", (e) => console.log(e.data));
 * const csv = exporter.export(rows, { format: "csv" });
 * ```
 */
export class AnalyticsDashboardExporter {
  readonly events = new AnalyticsExportEventEmitter();

  on<K extends AnalyticsExportEventName>(
    event: K,
    listener: AnalyticsExportListener<K>,
  ): () => void {
    return this.events.on(event, listener);
  }

  off<K extends AnalyticsExportEventName>(
    event: K,
    listener: AnalyticsExportListener<K>,
  ): void {
    this.events.off(event, listener);
  }

  /**
   * Serialize dashboard rows into the requested format.
   * Emits `start`, then `complete` on success or `error` on failure.
   */
  export(
    rows: AnalyticsDashboardRow[],
    options: AnalyticsExportOptions = {},
  ): string {
    const format: AnalyticsExportFormat = options.format ?? "json";
    const filename = options.filename;
    const safeRows = Array.isArray(rows) ? rows : [];

    this.events.emit("start", {
      format,
      rowCount: safeRows.length,
      filename,
    });

    try {
      const data =
        format === "csv"
          ? toCsv(safeRows, resolveColumns(safeRows, options.columns))
          : toJson(safeRows);

      this.events.emit("complete", {
        format,
        rowCount: safeRows.length,
        filename,
        data,
      });

      return data;
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.events.emit("error", { format, filename, error });
      throw error;
    }
  }
}

export default AnalyticsDashboardExporter;
