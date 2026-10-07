import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'encryptors/aes-gcm': 'src/encryptors/aes-gcm/index.ts',
    'providers/api-key': 'src/providers/api-key/index.ts',
    'providers/salesforce': 'src/providers/salesforce/index.ts',
    'providers/shopify': 'src/providers/shopify/index.ts',
    'providers/yotpo': 'src/providers/yotpo/index.ts',
    'providers/zoho': 'src/providers/zoho/index.ts',
    configuration: 'src/configuration/index.ts',
    'stores/convex': 'src/stores/convex/index.ts',
    'stores/memory': 'src/stores/memory/index.ts',
    'stores/sqlite': 'src/stores/sqlite/index.ts',
    'stores/postgresql': 'src/stores/postgresql/index.ts',
  },
  deps: {
    neverBundle: true,
    dts: {
      neverBundle: true,
    },
  },
  dts: {
    tsgo: true,
  },
})
