import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { envelopeValidator } from "./schema";

export const save = mutation({
  args: {
    id: v.string(), envelope: envelopeValidator, binding: v.string(), expiresAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!Number.isFinite(args.expiresAt)) throw new Error("Expiry must be finite");
    const existing = await ctx.db.query("attempts")
      .withIndex("by_attempt_id", (q) => q.eq("id", args.id)).unique();
    if (existing) throw new Error("Authorization attempt already exists");
    await ctx.db.insert("attempts", args);
    return null;
  },
});

export const consume = mutation({
  args: { id: v.string(), binding: v.string() },
  returns: v.union(envelopeValidator, v.null()),
  handler: async (ctx, { id, binding }) => {
    const row = await ctx.db.query("attempts")
      .withIndex("by_attempt_id", (q) => q.eq("id", id)).unique();
    if (!row || row.binding !== binding || row.expiresAt <= Date.now()) return null;
    await ctx.db.delete(row._id);
    return row.envelope;
  },
});
