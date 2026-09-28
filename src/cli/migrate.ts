#!/usr/bin/env node

import { program } from "commander";
import * as fs from "fs";
import * as path from "path";
import { detectBreakingChanges, generateMarkdown } from "./detector";
import { execSync } from "child_process";

program
  .name("stellar-split-sdk-migrate")
  .description("Compare two SDK versions and detect breaking changes")
  .requiredOption("--from <version>", "Base version or path")
  .requiredOption("--to <version>", "Target version or path")
  .option("--out <path>", "Output path for the markdown guide", "docs/MIGRATION.md")
  .parse(process.argv);

const options = program.opts();

async function run() {
  console.log(`Comparing version ${options.from} to ${options.to}...`);

  // We need to fetch the types for --from and --to.
  // In a real scenario, this could checkout branches to a temp directory,
  // or fetch from npm. Since this is an SDK tool, let's assume it checks out git tags/branches.
  // Wait, if it compares using ts-morph, we need the actual files.
  // The requirements say: "Compares exported TypeScript types between versions using ts-morph".
  // Let's implement a simple approach: if it's a path, use it. Otherwise, checkout from git to a temp dir.
  
  // For the sake of the requirements, let's assume we can checkout git references into temp directories.
  const tempDirFrom = fs.mkdtempSync("sdk-migrate-from-");
  const tempDirTo = fs.mkdtempSync("sdk-migrate-to-");

  try {
    // Clone and checkout from
    execSync(`git clone . ${tempDirFrom}`);
    execSync(`git checkout ${options.from}`, { cwd: tempDirFrom, stdio: 'ignore' });
    
    // Clone and checkout to
    execSync(`git clone . ${tempDirTo}`);
    execSync(`git checkout ${options.to}`, { cwd: tempDirTo, stdio: 'ignore' });

    // Try to find the entry point. Usually src/index.ts or src/**/*.ts
    const fromFiles = [path.join(tempDirFrom, "src/**/*.ts")];
    const toFiles = [path.join(tempDirTo, "src/**/*.ts")];

    const changes = detectBreakingChanges(fromFiles, toFiles);

    if (changes.length > 0) {
      console.log(`Detected ${changes.length} breaking changes.`);
      const md = generateMarkdown(changes);
      
      const outDir = path.dirname(options.out);
      if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
      }
      fs.writeFileSync(options.out, md);
      console.log(`Migration guide generated at ${options.out}`);
      
      process.exit(1);
    } else {
      console.log("No breaking changes detected.");
      process.exit(0);
    }
  } catch (error) {
    console.error("Error during comparison:", error);
    process.exit(2);
  } finally {
    fs.rmSync(tempDirFrom, { recursive: true, force: true });
    fs.rmSync(tempDirTo, { recursive: true, force: true });
  }
}

run();
