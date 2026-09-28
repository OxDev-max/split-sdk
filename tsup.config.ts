import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/ui/index.ts",
    "src/testing/index.ts",
    "src/utils.ts",
    // #882 – mock client entry point
    "src/mock/index.ts",
    // #884 – React hooks entry point
    "src/react/index.tsx",
    // #885 – telemetry module entry point
    "src/telemetryModule.ts",
  ],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
  treeshake: true,
  external: ["react", "react-dom"],
  esbuildOptions(options) {
    options.jsx = "transform";
    options.jsxFactory = "React.createElement";
    options.jsxFragment = "React.Fragment";
  },
});
