import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { detectBreakingChanges, generateMarkdown } from "../src/cli/detector";
import * as fs from "fs";
import * as path from "path";

describe("Breaking Change Detector", () => {
  const fromDir = path.join(__dirname, "mock_from");
  const toDir = path.join(__dirname, "mock_to");

  beforeAll(() => {
    fs.mkdirSync(fromDir, { recursive: true });
    fs.mkdirSync(toDir, { recursive: true });

    // Base API
    fs.writeFileSync(path.join(fromDir, "index.ts"), `
      export function removedMethod(a: string): void {}
      export function changedSignature(a: string): void {}
      export interface RenamedType { id: string; }
      export interface ExistingInterface {
        oldMethod(): void;
      }
      export function addedRequiredParam(a: string): void {}
    `);

    // Target API
    fs.writeFileSync(path.join(toDir, "index.ts"), `
      // removedMethod is gone
      export function changedSignature(a: string, b: number): void {} // removed params, wait no, my logic expects something else, let's just make it have fewer params in from and more required in to
      // RenamedType is now a class or gone
      export class RenamedType { id: string; }
      export interface ExistingInterface {
        // oldMethod is removed
        newMethod(): void;
      }
      export function addedRequiredParam(a: string, b: number): void {} // b is required
    `);
  });

  afterAll(() => {
    fs.rmSync(fromDir, { recursive: true, force: true });
    fs.rmSync(toDir, { recursive: true, force: true });
  });

  it("detects breaking changes correctly", () => {
    const fromFiles = [path.join(fromDir, "index.ts")];
    const toFiles = [path.join(toDir, "index.ts")];

    const changes = detectBreakingChanges(fromFiles, toFiles);
    
    // We expect:
    // 1. removedMethod removed
    // 2. RenamedType changed kind
    // 3. ExistingInterface.oldMethod removed
    // 4. addedRequiredParam added required param 'b'
    // 5. changedSignature added required param 'b'

    const types = changes.map(c => c.type);
    expect(types).toContain("removed");
    expect(types).toContain("renamed_type");
    expect(types).toContain("added_required_param");

    const removedMethodChange = changes.find(c => c.name === "removedMethod");
    expect(removedMethodChange).toBeDefined();
    expect(removedMethodChange?.type).toBe("removed");

    const renamedChange = changes.find(c => c.name === "RenamedType");
    expect(renamedChange).toBeDefined();
    expect(renamedChange?.type).toBe("renamed_type");

    const paramChange = changes.find(c => c.name === "addedRequiredParam");
    expect(paramChange).toBeDefined();
    expect(paramChange?.type).toBe("added_required_param");

    const interfaceMethodRemove = changes.find(c => c.name === "ExistingInterface.oldMethod");
    expect(interfaceMethodRemove).toBeDefined();
    expect(interfaceMethodRemove?.type).toBe("removed");
  });

  it("generates markdown properly", () => {
    const fromFiles = [path.join(fromDir, "index.ts")];
    const toFiles = [path.join(toDir, "index.ts")];

    const changes = detectBreakingChanges(fromFiles, toFiles);
    const md = generateMarkdown(changes);

    expect(md).toContain("# Migration Guide");
    expect(md).toContain("removedMethod");
    expect(md).toContain("RenamedType");
    expect(md).toContain("addedRequiredParam");
  });
});
