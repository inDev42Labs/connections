import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "index.ts",
    "core/index": "src/core/index.ts",
    "providers/dummy/index": "src/providers/dummy/index.ts",
    "providers/salesforce/index": "src/providers/salesforce/index.ts",
    "providers/zoho/index": "src/providers/zoho/index.ts",
    "stores/convex/index": "src/stores/convex/index.ts",
    "stores/memory/index": "src/stores/memory/index.ts",
    "stores/neon/index": "src/stores/neon/index.ts",
  },
  clean: true,
  dts: true,
  format: ["esm"],
  platform: "neutral",
  sourcemap: true,
  target: "es2022",
});
