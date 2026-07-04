# Convex Token Store

`ConvexTokenStore` stores OAuth token records in Convex by calling function references that you provide from your app's generated Convex API.

This package does not import Convex directly. Your app owns the Convex schema and functions, then passes those function references into the store.

## Store Setup

```ts
import { ConvexHttpClient } from "convex/browser";
import { ConvexTokenStore } from "@indev42/connections/stores/convex";
import { api } from "../convex/_generated/api";

const client = new ConvexHttpClient(process.env.CONVEX_URL!);

const tokenStore = new ConvexTokenStore({
  client,
  functions: {
    get: api.oauthTokens.get,
    put: api.oauthTokens.put,
    delete: api.oauthTokens.remove,
  },
});
```

The provided `client` must support Convex-style `query(functionReference, args)` and `mutation(functionReference, args)` calls.

## Convex Schema

Add a table for token data in `convex/schema.ts`:

```ts
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  oauthTokens: defineTable({
    tokenKey: v.string(),
    provider: v.string(),
    accountId: v.string(),
    connectionId: v.union(v.string(), v.null()),
    tokenData: v.string(),
    updatedAt: v.number(),
  }).index("by_token_key", ["tokenKey"]),
});
```

`tokenData` is the serialized token payload. If you pass `encryption` to `ConvexTokenStore`, this value is encrypted before it reaches Convex.

## Convex Functions

Add matching functions in `convex/oauthTokens.ts`:

```ts
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const tokenKeyArgs = {
  tokenKey: v.string(),
  provider: v.string(),
  accountId: v.string(),
  connectionId: v.union(v.string(), v.null()),
};

export const get = query({
  args: tokenKeyArgs,
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("oauthTokens")
      .withIndex("by_token_key", (q) => q.eq("tokenKey", args.tokenKey))
      .unique();

    return row?.tokenData ?? null;
  },
});

export const put = mutation({
  args: {
    ...tokenKeyArgs,
    tokenData: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("oauthTokens")
      .withIndex("by_token_key", (q) => q.eq("tokenKey", args.tokenKey))
      .unique();

    const value = {
      tokenKey: args.tokenKey,
      provider: args.provider,
      accountId: args.accountId,
      connectionId: args.connectionId,
      tokenData: args.tokenData,
      updatedAt: Date.now(),
    };

    if (existing) {
      await ctx.db.patch(existing._id, value);
      return;
    }

    await ctx.db.insert("oauthTokens", value);
  },
});

export const remove = mutation({
  args: tokenKeyArgs,
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("oauthTokens")
      .withIndex("by_token_key", (q) => q.eq("tokenKey", args.tokenKey))
      .unique();

    if (existing) {
      await ctx.db.delete(existing._id);
    }
  },
});
```

## Function Arguments

The store sends these arguments to every Convex function:

```ts
{
  tokenKey: string;
  provider: string;
  accountId: string;
  connectionId: string | null;
}
```

`put` also sends:

```ts
{
  tokenData: string;
}
```

The `get` function may return either `string`, `null`, `{ tokenData: string }`, or `{ token_data: string }`.

## Encryption

To encrypt token payloads before storing them in Convex, pass a `TokenEncryption` implementation:

```ts
const tokenStore = new ConvexTokenStore({
  client,
  functions: {
    get: api.oauthTokens.get,
    put: api.oauthTokens.put,
    delete: api.oauthTokens.remove,
  },
  encryption,
});
```

Encryption and decryption happen in your application process, not inside Convex.
