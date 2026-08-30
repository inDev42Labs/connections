import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "index.ts",
    "core/index": "src/core/index.ts",
    "encryptors/index": "src/encryptors/index.ts",
    "encryptors/aes-gcm/index": "src/encryptors/aes-gcm/index.ts",
    "providers/dummy/index": "src/providers/dummy/index.ts",
    "providers/retell/index": "src/providers/retell/index.ts",
    "providers/salesforce/index": "src/providers/salesforce/index.ts",
    "providers/zoho/index": "src/providers/zoho/index.ts",
    "sources/index": "src/sources/index.ts",
    "sources/environment/index": "src/sources/environment/index.ts",
    "stores/convex/index": "src/stores/convex/index.ts",
    "stores/memory/index": "src/stores/memory/index.ts",
    "stores/neon/index": "src/stores/neon/index.ts",
  },
  attw: {
    level: "error",
    profile: "esm-only",
  },
  dts: true,
  exports: false,
  fixedExtension: false,
  format: "esm",
  platform: "neutral",
  publint: true,
  sourcemap: true,
  target: "es2022",
});
