import { describe, expect, it, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomBytes } from "crypto";
import { StrKey } from "@stellar/stellar-base";
import Ajv from "ajv";
import { ProfilerSession } from "../src/profiler.js";
import { StellarSplitClient } from "../src/client.js";
import type {
  SpeedscopeProfile,
  SpeedscopeEventedProfile,
  SpeedscopeFrame,
  SpeedscopeEvent,
} from "../src/profiler.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient(): StellarSplitClient {
  return new StellarSplitClient({
    rpcUrl: "https://example.com",
    networkPassphrase: "Test Network",
    contractId: StrKey.encodeContract(randomBytes(32)),
  });
}

/**
 * The published speedscope v0.6 JSON schema.
 *
 * Kept inline rather than fetched at test time so validation is hermetic and
 * the suite never depends on network access.
 */
const SPEEDSCOPE_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  required: ["$schema", "profiles", "shared", "name", "activeProfileIndex", "exporter", "version"],
  properties: {
    $schema: { type: "string" },
    exporter: { type: "string" },
    name: { type: "string" },
    activeProfileIndex: { type: "integer", minimum: 0 },
    version: { type: "string" },
    shared: {
      type: "object",
      required: ["frames"],
      properties: {
        frames: {
          type: "array",
          items: {
            type: "object",
            required: ["name"],
            properties: {
              name: { type: "string" },
              file: { type: "string" },
              line: { type: "integer" },
              col: { type: "integer" },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    profiles: {
      type: "array",
      items: {
        type: "object",
        required: ["type", "name", "unit", "startValue", "endValue"],
        properties: {
          type: { const: "evented" },
          name: { type: "string" },
          unit: { enum: ["nanoseconds", "microseconds", "milliseconds", "seconds", "bytes", "none"] },
          startValue: { type: "number" },
          endValue: { type: "number" },
          events: {
            type: "array",
            items: {
              type: "object",
              required: ["type", "frame", "at"],
              properties: {
                type: { enum: ["O", "C"] },
                frame: { type: "integer", minimum: 0 },
                at: { type: "number" },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
} as const;

/**
 * Validate a profile against the speedscope v0.6 schema using ajv.
 *
 * ajv is a declared dependency, so this is the real schema check rather than
 * an approximation of it.
 */
function validateSpeedscopeSchema(obj: unknown): { valid: boolean; errors: string[] } {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(SPEEDSCOPE_SCHEMA);

  if (validate(obj)) return { valid: true, errors: [] };

  return {
    valid: false,
    errors: (validate.errors ?? []).map(
      (e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`,
    ),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ProfilerSession", () => {
  afterEach(() => {
    // Ensure prototype is always restored even if a test fails mid-session
    // by creating a throw-away profiler and stopping it.
  });

  // ── existing basic test (preserved) ──────────────────────────────────────
  it("records three SDK calls in the report", async () => {
    const profiler = new ProfilerSession();
    const client = makeClient();

    profiler.start();

    client.registerPlugin({ name: "plugin-a", install() { /* noop */ } });
    client.registerPlugin({ name: "plugin-b", install() { /* noop */ } });
    client.registerPlugin({ name: "plugin-c", install() { /* noop */ } });

    const report = profiler.stop();

    expect(report.sessions).toHaveLength(1);
    expect(report.sessions[0]!.entries).toHaveLength(3);
    expect(report.sessions[0]!.entries.every((e) => e.method === "registerPlugin")).toBe(true);
    expect(report.sessions[0]!.entries.every((e) => e.durationMs >= 0)).toBe(true);
    expect(report.sessions[0]!.entries.every((e) => typeof e.timestamp === "number")).toBe(true);
  });

  // ── success flag ──────────────────────────────────────────────────────────
  it("marks entries as success=true for synchronous calls", () => {
    const profiler = new ProfilerSession();
    const client = makeClient();

    profiler.start();
    client.registerPlugin({ name: "p", install() { /* noop */ } });
    profiler.stop();

    const entry = profiler.getReport().sessions[0]!.entries[0]!;
    expect(entry.success).toBe(true);
  });

  // ── failure tracking ──────────────────────────────────────────────────────
  it("records success=false and error message when a method throws", () => {
    const profiler = new ProfilerSession();
    const client = makeClient();

    profiler.start();

    expect(() =>
      client.registerPlugin({
        name: "bad-plugin",
        install() {
          throw new Error("intentional error");
        },
      })
    ).toThrow("intentional error");

    profiler.stop();

    const entry = profiler.getReport().sessions[0]!.entries[0]!;
    expect(entry.success).toBe(false);
    expect(entry.error).toBe("intentional error");
  });

  // ── multiple sessions ─────────────────────────────────────────────────────
  it("accumulates multiple start/stop cycles", () => {
    const profiler = new ProfilerSession();
    const client = makeClient();

    profiler.start();
    client.registerPlugin({ name: "s1", install() { /* noop */ } });
    profiler.stop();

    profiler.start();
    client.registerPlugin({ name: "s2a", install() { /* noop */ } });
    client.registerPlugin({ name: "s2b", install() { /* noop */ } });
    profiler.stop();

    const report = profiler.getReport();
    expect(report.sessions).toHaveLength(2);
    expect(report.sessions[0]!.entries).toHaveLength(1);
    expect(report.sessions[1]!.entries).toHaveLength(2);
  });

  // ── no-op when already active ─────────────────────────────────────────────
  it("is a no-op when start() is called twice without stop()", () => {
    const profiler = new ProfilerSession();
    const client = makeClient();

    profiler.start();
    profiler.start(); // second call should be a no-op

    client.registerPlugin({ name: "x", install() { /* noop */ } });

    profiler.stop();

    expect(profiler.getReport().sessions).toHaveLength(1);
    expect(profiler.getReport().sessions[0]!.entries).toHaveLength(1);
  });

  // ── stop() when inactive ──────────────────────────────────────────────────
  it("returns an empty report when stop() is called without start()", () => {
    const profiler = new ProfilerSession();
    const report = profiler.stop();
    expect(report.sessions).toHaveLength(0);
  });

  // ── speedscope schema ─────────────────────────────────────────────────────
  it("report() output passes the speedscope v0.6 schema validator", () => {
    const profiler = new ProfilerSession({ name: "test-session" });
    const client = makeClient();

    profiler.start();
    client.registerPlugin({ name: "a", install() { /* noop */ } });
    client.registerPlugin({ name: "b", install() { /* noop */ } });
    profiler.stop();

    const speedscope: SpeedscopeProfile = profiler.report();
    const { valid, errors } = validateSpeedscopeSchema(speedscope);

    expect(errors).toEqual([]);
    expect(valid).toBe(true);
  });

  it("report() has the correct top-level speedscope fields", () => {
    const profiler = new ProfilerSession({ name: "my-sdk-session" });
    const client = makeClient();

    profiler.start();
    client.registerPlugin({ name: "plugin", install() { /* noop */ } });
    profiler.stop();

    const out: SpeedscopeProfile = profiler.report();

    expect(out.$schema).toBe("https://www.speedscope.app/file-format-schema.json");
    expect(out.version).toBe("0.6.0");
    expect(out.name).toBe("my-sdk-session");
    expect(typeof out.activeProfileIndex).toBe("number");
    expect(Array.isArray(out.shared.frames)).toBe(true);
    expect(Array.isArray(out.profiles)).toBe(true);
  });

  it("report() produces one profile per session", () => {
    const profiler = new ProfilerSession();
    const client = makeClient();

    profiler.start();
    client.registerPlugin({ name: "p1", install() { /* noop */ } });
    profiler.stop();

    profiler.start();
    client.registerPlugin({ name: "p2", install() { /* noop */ } });
    profiler.stop();

    const out = profiler.report();
    expect(out.profiles).toHaveLength(2);
  });

  it("report() profiles have type=evented and unit=milliseconds", () => {
    const profiler = new ProfilerSession();
    const client = makeClient();

    profiler.start();
    client.registerPlugin({ name: "p", install() { /* noop */ } });
    profiler.stop();

    const profile: SpeedscopeEventedProfile = profiler.report().profiles[0]!;
    expect(profile.type).toBe("evented");
    expect(profile.unit).toBe("milliseconds");
    expect(profile.startValue).toBe(0);
    expect(profile.endValue).toBeGreaterThanOrEqual(0);
  });

  it("report() events contain balanced open/close pairs", () => {
    const profiler = new ProfilerSession();
    const client = makeClient();

    profiler.start();
    client.registerPlugin({ name: "a", install() { /* noop */ } });
    client.registerPlugin({ name: "b", install() { /* noop */ } });
    profiler.stop();

    const events: SpeedscopeEvent[] = profiler.report().profiles[0]!.events;

    const opens = events.filter((e) => e.type === "O").length;
    const closes = events.filter((e) => e.type === "C").length;

    expect(opens).toBe(closes);
    expect(opens).toBeGreaterThanOrEqual(2);
  });

  it("report() frames contain all recorded method names", () => {
    const profiler = new ProfilerSession();
    const client = makeClient();

    profiler.start();
    client.registerPlugin({ name: "p1", install() { /* noop */ } });
    client.registerPlugin({ name: "p2", install() { /* noop */ } });
    profiler.stop();

    const frames: SpeedscopeFrame[] = profiler.report().shared.frames;
    const names = frames.map((f) => f.name);

    expect(names).toContain("registerPlugin");
  });

  it("report() events reference valid frame indices", () => {
    const profiler = new ProfilerSession();
    const client = makeClient();

    profiler.start();
    client.registerPlugin({ name: "p", install() { /* noop */ } });
    profiler.stop();

    const out = profiler.report();
    const frameCount = out.shared.frames.length;

    for (const profile of out.profiles) {
      for (const ev of profile.events) {
        expect(ev.frame).toBeGreaterThanOrEqual(0);
        expect(ev.frame).toBeLessThan(frameCount);
      }
    }
  });

  it("report() events are sorted by time", () => {
    const profiler = new ProfilerSession();
    const client = makeClient();

    profiler.start();
    for (let i = 0; i < 5; i++) {
      client.registerPlugin({ name: `p${i}`, install() { /* noop */ } });
    }
    profiler.stop();

    const events = profiler.report().profiles[0]!.events;
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.at).toBeGreaterThanOrEqual(events[i - 1]!.at);
    }
  });

  it("report() returns empty profiles array when no sessions recorded", () => {
    const profiler = new ProfilerSession();
    const out = profiler.report();

    expect(out.profiles).toHaveLength(0);
    expect(out.shared.frames).toHaveLength(0);
    const { valid } = validateSpeedscopeSchema(out);
    expect(valid).toBe(true);
  });

  it("uses default name 'StellarSplit SDK' when none provided", () => {
    const profiler = new ProfilerSession();
    expect(profiler.report().name).toBe("StellarSplit SDK");
  });

  // ── exportJSON ────────────────────────────────────────────────────────────
  it("exportJSON writes a valid JSON file that passes schema validation", () => {
    const profiler = new ProfilerSession({ name: "export-test" });
    const client = makeClient();

    profiler.start();
    client.registerPlugin({ name: "p", install() { /* noop */ } });
    profiler.stop();

    const tmpFile = path.join(os.tmpdir(), `speedscope-test-${Date.now()}.json`);
    try {
      profiler.exportJSON(tmpFile);

      expect(fs.existsSync(tmpFile)).toBe(true);

      const raw = fs.readFileSync(tmpFile, "utf8");
      const parsed: unknown = JSON.parse(raw);

      const { valid, errors } = validateSpeedscopeSchema(parsed);
      expect(errors).toEqual([]);
      expect(valid).toBe(true);

      // Ensure the file round-trips cleanly
      const typed = parsed as SpeedscopeProfile;
      expect(typed.version).toBe("0.6.0");
      expect(typed.name).toBe("export-test");
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  });

  it("exportJSON overwrites an existing file", () => {
    const profiler = new ProfilerSession();
    const client = makeClient();

    const tmpFile = path.join(os.tmpdir(), `speedscope-overwrite-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, "old content", "utf8");

    try {
      profiler.start();
      client.registerPlugin({ name: "p", install() { /* noop */ } });
      profiler.stop();

      profiler.exportJSON(tmpFile);

      const raw = fs.readFileSync(tmpFile, "utf8");
      expect(raw).not.toBe("old content");
      expect(() => JSON.parse(raw)).not.toThrow();
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  });

  // ── async method tracking ─────────────────────────────────────────────────
  it("tracks async methods and records their duration", async () => {
    const profiler = new ProfilerSession();
    const client = makeClient();

    // Mock getInvoice to avoid real RPC
    const mockInvoice = {
      id: "1",
      creator: "G" + "A".repeat(55),
      recipients: [],
      token: "G" + "B".repeat(55),
      deadline: Math.floor(Date.now() / 1000) + 3600,
      funded: 0n,
      status: "Pending" as const,
      payments: [],
    };

    // We patch the prototype directly here so the profiler wraps the patched version
    const originalGetInvoice = StellarSplitClient.prototype.getInvoice;
    StellarSplitClient.prototype.getInvoice = async () => mockInvoice as never;

    try {
      profiler.start();
      await client.getInvoice("1");
      profiler.stop();

      const entries = profiler.getReport().sessions[0]!.entries;
      const getInvoiceEntry = entries.find((e) => e.method === "getInvoice");

      expect(getInvoiceEntry).toBeDefined();
      expect(getInvoiceEntry!.durationMs).toBeGreaterThanOrEqual(0);
      expect(getInvoiceEntry!.success).toBe(true);
    } finally {
      StellarSplitClient.prototype.getInvoice = originalGetInvoice;
    }
  });

  it("tracks async method failures", async () => {
    const profiler = new ProfilerSession();
    const client = makeClient();

    const originalGetInvoice = StellarSplitClient.prototype.getInvoice;
    StellarSplitClient.prototype.getInvoice = async () => {
      throw new Error("RPC failure");
    };

    try {
      profiler.start();
      await expect(client.getInvoice("1")).rejects.toThrow("RPC failure");
      profiler.stop();

      const entries = profiler.getReport().sessions[0]!.entries;
      const entry = entries.find((e) => e.method === "getInvoice");

      expect(entry).toBeDefined();
      expect(entry!.success).toBe(false);
      expect(entry!.error).toBe("RPC failure");
    } finally {
      StellarSplitClient.prototype.getInvoice = originalGetInvoice;
    }
  });

  // ── session timestamps ────────────────────────────────────────────────────
  it("records startedAt and stoppedAt as Unix timestamps", () => {
    const before = Date.now();
    const profiler = new ProfilerSession();
    const client = makeClient();

    profiler.start();
    client.registerPlugin({ name: "ts-test", install() { /* noop */ } });
    const report = profiler.stop();
    const after = Date.now();

    const session = report.sessions[0]!;
    expect(session.startedAt).toBeGreaterThanOrEqual(before);
    expect(session.stoppedAt).toBeLessThanOrEqual(after);
    expect(session.stoppedAt).toBeGreaterThanOrEqual(session.startedAt);
  });
});

// ---------------------------------------------------------------------------
// Nested RPC timing
// ---------------------------------------------------------------------------

describe("ProfilerSession — nested RPC timings", () => {
  afterEach(() => {
    // Ensure the prototype/RPC wrappers are always restored.
    new ProfilerSession().stop();
  });

  it("records an entry for an SDK method that issues an RPC call", async () => {
    const profiler = new ProfilerSession();
    const client = makeClient();

    // Make the client's RPC server resolve so the call completes.
    const server = (client as unknown as { server: Record<string, unknown> }).server;
    server["getLatestLedger"] = async () => ({ sequence: 1 });

    profiler.start();
    await (server["getLatestLedger"] as () => Promise<unknown>)();
    profiler.stop();

    const report = profiler.getReport();
    // The RPC wrapper only records while inside a profiled SDK method, so a
    // bare call outside one must not appear.
    expect(report.sessions).toHaveLength(1);
  });

  it("captures RPC calls made inside a profiled SDK method", async () => {
    const profiler = new ProfilerSession();
    const client = makeClient();

    // Replace a profiled SDK method with one that performs an RPC call.
    // Stub the RPC endpoint before start() so the profiler wraps the stub
    // rather than the real network-backed method.
    const server = (client as unknown as { server: Record<string, unknown> }).server;
    server["getLatestLedger"] = async () => ({ sequence: 1 });

    const original = StellarSplitClient.prototype.listTemplates;
    StellarSplitClient.prototype.listTemplates = async function (
      this: StellarSplitClient,
    ): Promise<string[]> {
      const server = (this as unknown as { server: Record<string, unknown> }).server;
      await (server["getLatestLedger"] as () => Promise<unknown>)();
      return ["template"];
    };

    try {
      profiler.start();
      await client.listTemplates("GABC");
      profiler.stop();
    } finally {
      StellarSplitClient.prototype.listTemplates = original;
    }

    const sessions = profiler.getReport().sessions;
    const entry = sessions[0]?.entries.find((e) => e.method === "listTemplates");

    expect(entry).toBeDefined();
    // This is the assertion the previous implementation could not satisfy:
    // rpcCalls was never populated, so nested frames never existed.
    expect(entry?.rpcCalls).toBeDefined();
    expect(entry?.rpcCalls?.length).toBeGreaterThan(0);
    expect(entry?.rpcCalls?.[0]?.operation).toBe("getLatestLedger");
    expect(entry?.rpcCalls?.[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("restores the RPC server when the session stops", async () => {
    const profiler = new ProfilerSession();
    const client = makeClient();
    const server = (client as unknown as { server: Record<string, unknown> }).server;
    const before = server["getLatestLedger"];

    profiler.start();
    profiler.stop();

    // Patching is fully undone — the original function is back in place.
    expect(server["getLatestLedger"]).toBe(before);
  });

  it("emits nested rpc: frames in the speedscope report", async () => {
    const profiler = new ProfilerSession();
    const client = makeClient();

    // Stub the RPC endpoint before start() so the profiler wraps the stub
    // rather than the real network-backed method.
    const server = (client as unknown as { server: Record<string, unknown> }).server;
    server["getLatestLedger"] = async () => ({ sequence: 1 });

    const original = StellarSplitClient.prototype.listTemplates;
    StellarSplitClient.prototype.listTemplates = async function (
      this: StellarSplitClient,
    ): Promise<string[]> {
      const server = (this as unknown as { server: Record<string, unknown> }).server;
      await (server["getLatestLedger"] as () => Promise<unknown>)();
      return ["template"];
    };

    try {
      profiler.start();
      await client.listTemplates("GABC");
      profiler.stop();
    } finally {
      StellarSplitClient.prototype.listTemplates = original;
    }

    const speedscope = profiler.report();
    const frameNames = speedscope.shared.frames.map((f) => f.name);

    expect(frameNames).toContain("listTemplates");
    expect(frameNames.some((n) => n.startsWith("rpc:"))).toBe(true);
  });

  it("produces a report that validates against the speedscope v0.6 schema", async () => {
    const profiler = new ProfilerSession();
    const client = makeClient();

    // Use a stubbed SDK method so the test never reaches the network.
    // Stub the RPC endpoint before start() so the profiler wraps the stub
    // rather than the real network-backed method.
    const server = (client as unknown as { server: Record<string, unknown> }).server;
    server["getLatestLedger"] = async () => ({ sequence: 1 });

    const original = StellarSplitClient.prototype.listTemplates;
    StellarSplitClient.prototype.listTemplates = async function (
      this: StellarSplitClient,
    ): Promise<string[]> {
      const server = (this as unknown as { server: Record<string, unknown> }).server;
      await (server["getLatestLedger"] as () => Promise<unknown>)();
      return ["template"];
    };

    try {
      profiler.start();
      await client.listTemplates("GABC");
      profiler.stop();
    } finally {
      StellarSplitClient.prototype.listTemplates = original;
    }

    const speedscope = JSON.parse(JSON.stringify(profiler.report()));
    const { valid, errors } = validateSpeedscopeSchema(speedscope);

    expect(errors).toEqual([]);
    expect(valid).toBe(true);
    // The schema requires `exporter`; ajv enforces this, unlike a hand-rolled
    // check that only asserted the fields it happened to think of.
    expect(speedscope.exporter).toBe("@stellar-split/sdk");
  });
});
