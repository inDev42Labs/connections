import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { envelopeValidator, recordValidator } from "./schema";

// Short, storage-established leases; orchestration decides whether exchange is safe.
const MAX_LEASE_MS = 5 * 60 * 1000;

function leaseDeadline(leaseMs: number): number {
  if (!Number.isFinite(leaseMs) || leaseMs <= 0 || leaseMs > MAX_LEASE_MS) {
    throw new Error("Lease must be finite and between 0 (exclusive) and 300000 ms");
  }
  return Date.now() + leaseMs;
}

function checkExpiry(expiresAt: number): void {
  if (!Number.isFinite(expiresAt)) throw new Error("Expiry must be finite");
}

export const initialize = mutation({
  args: { key: v.string(), envelope: envelopeValidator, expiresAt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    checkExpiry(args.expiresAt);
    const existing = await ctx.db.query("records")
      .withIndex("by_key", (q) => q.eq("key", args.key)).unique();
    if (!existing) {
      await ctx.db.insert("records", {
        ...args,
        version: 0,
        owner: null,
        fence: 0,
        leaseUntil: null,
        lastCompletionId: null,
        lastCompletionOwner: null,
        lastCompletionFence: null,
      });
    }
    return null;
  },
});

export const read = query({
  args: { key: v.string() },
  returns: v.union(recordValidator, v.null()),
  handler: async (ctx, { key }) => {
    const row = await ctx.db.query("records")
      .withIndex("by_key", (q) => q.eq("key", key)).unique();
    if (!row) return null;
    const { _id, _creationTime, ...record } = row;
    return record;
  },
});

// Read-only metadata projection. Ciphertext stays private to this module.
export const inspect = query({
  args: { key: v.string() },
  returns: v.object({ savedAuthorization: v.boolean(), credentialWorkPending: v.boolean() }),
  handler: async (ctx, { key }) => {
    const row = await ctx.db.query("records")
      .withIndex("by_key", (q) => q.eq("key", key)).unique();
    return { savedAuthorization: row !== null, credentialWorkPending: row !== null && row.owner !== null };
  },
});

export const claim = mutation({
  args: {
    key: v.string(), expectedVersion: v.number(), owner: v.string(), leaseMs: v.number(),
  },
  returns: v.union(
    v.object({ claimed: v.literal(true), version: v.number(), fence: v.number(), leaseUntil: v.number() }),
    v.object({ claimed: v.literal(false) }),
  ),
  handler: async (ctx, { key, expectedVersion, owner, leaseMs }) => {
    const leaseUntil = leaseDeadline(leaseMs);
    const row = await ctx.db.query("records")
      .withIndex("by_key", (q) => q.eq("key", key)).unique();
    if (!row) throw new Error("Credential record missing");
    if (row.version !== expectedVersion ||
      (row.owner !== null && row.leaseUntil !== null && row.leaseUntil > Date.now())) {
      return { claimed: false } as const;
    }
    const version = row.version + 1;
    const fence = row.fence + 1;
    // Transfer only the storage claim. Keep ciphertext and completion evidence intact.
    // An expired lease is NOT evidence that a previous external exchange did not run.
    await ctx.db.patch(row._id, { owner, fence, leaseUntil, version });
    return { claimed: true, version, fence, leaseUntil } as const;
  },
});

export const renew = mutation({
  args: { key: v.string(), owner: v.string(), fence: v.number(), leaseMs: v.number() },
  returns: v.boolean(),
  handler: async (ctx, { key, owner, fence, leaseMs }) => {
    const deadline = leaseDeadline(leaseMs);
    const row = await ctx.db.query("records")
      .withIndex("by_key", (q) => q.eq("key", key)).unique();
    if (!row) throw new Error("Credential record missing");
    if (row.owner !== owner || row.fence !== fence ||
      row.leaseUntil === null || row.leaseUntil <= Date.now()) return false;
    await ctx.db.patch(row._id, { leaseUntil: Math.max(row.leaseUntil, deadline) });
    return true;
  },
});

export const complete = mutation({
  args: {
    key: v.string(), owner: v.string(), fence: v.number(), writeId: v.string(),
    envelope: envelopeValidator, expiresAt: v.number(),
  },
  returns: v.object({
    status: v.union(v.literal("committed"), v.literal("already-applied"), v.literal("conflict")),
    version: v.number(),
  }),
  handler: async (ctx, { key, owner, fence, writeId, envelope, expiresAt }) => {
    checkExpiry(expiresAt);
    const row = await ctx.db.query("records")
      .withIndex("by_key", (q) => q.eq("key", key)).unique();
    if (!row) throw new Error("Credential record missing");
    // Recognize an acknowledged-late write without touching even a newer claim.
    // Write IDs identify immutable payloads and must be unique per completion.
    if (row.lastCompletionId === writeId && row.lastCompletionOwner === owner &&
      row.lastCompletionFence === fence) {
      return { status: "already-applied", version: row.version } as const;
    }
    if (row.lastCompletionId === writeId || row.owner !== owner || row.fence !== fence ||
      row.leaseUntil === null || row.leaseUntil <= Date.now()) {
      return { status: "conflict", version: row.version } as const;
    }
    const version = row.version + 1;
    await ctx.db.patch(row._id, {
      envelope, expiresAt, version, owner: null, leaseUntil: null,
      lastCompletionId: writeId, lastCompletionOwner: owner, lastCompletionFence: fence,
    });
    return { status: "committed", version } as const;
  },
});

// A fake provider transaction, deliberately separate from credential completion.
// No real network/provider behavior is modeled. Each token is accepted exactly once.
export const fakeExchange = mutation({
  args: { key: v.string(), refreshToken: v.string() },
  returns: v.object({ accessToken: v.string(), refreshToken: v.string(), expiresAt: v.number() }),
  handler: async (ctx, { key, refreshToken }) => {
    const row = await ctx.db.query("fakeProvider")
      .withIndex("by_key", (q) => q.eq("key", key)).unique();
    const generation = row?.generation ?? 0;
    if (refreshToken !== `FAKE-refresh-${generation}`) {
      throw new Error("Fake provider rejected refresh token");
    }
    const next = generation + 1;
    if (row) {
      await ctx.db.patch(row._id, { generation: next, calls: row.calls + 1 });
    } else {
      await ctx.db.insert("fakeProvider", { key, generation: next, calls: 1 });
    }
    return {
      accessToken: `FAKE-access-${next}`,
      refreshToken: `FAKE-refresh-${next}`,
      expiresAt: Date.now() + 60 * 60 * 1000,
    };
  },
});

// Record each HTTP attempt in its own transaction BEFORE the fake exchange,
// so a rejected exchange cannot roll back the request counter.
export const recordHttpAttempt = mutation({
  args: { key: v.string() },
  returns: v.null(),
  handler: async (ctx, { key }) => {
    const row = await ctx.db.query("fakeProvider")
      .withIndex("by_key", (q) => q.eq("key", key)).unique();
    if (row) await ctx.db.patch(row._id, { requests: (row.requests ?? 0) + 1 });
    else await ctx.db.insert("fakeProvider", { key, generation: 0, calls: 0, requests: 1 });
    return null;
  },
});

export const providerRequests = query({
  args: { key: v.string() },
  returns: v.number(),
  handler: async (ctx, { key }) => {
    const row = await ctx.db.query("fakeProvider")
      .withIndex("by_key", (q) => q.eq("key", key)).unique();
    return row?.requests ?? 0;
  },
});

// Counts committed successful exchanges; rejected mutations roll back atomically.
export const providerCalls = query({
  args: { key: v.string() },
  returns: v.number(),
  handler: async (ctx, { key }) => {
    const row = await ctx.db.query("fakeProvider")
      .withIndex("by_key", (q) => q.eq("key", key)).unique();
    return row?.calls ?? 0;
  },
});
