import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const envelopeValidator = v.object({
  iv: v.bytes(),
  ciphertext: v.bytes(),
  format: v.literal("aes-gcm-v1"),
});

export const recordFields = {
  key: v.string(),
  envelope: envelopeValidator,
  expiresAt: v.number(),
  version: v.number(),
  owner: v.union(v.string(), v.null()),
  fence: v.number(),
  leaseUntil: v.union(v.number(), v.null()),
  lastCompletionId: v.union(v.string(), v.null()),
  lastCompletionOwner: v.union(v.string(), v.null()),
  lastCompletionFence: v.union(v.number(), v.null()),
};
export const recordValidator = v.object(recordFields);

export default defineSchema({
  records: defineTable(recordFields).index("by_key", ["key"]),
  attempts: defineTable({
    id: v.string(),
    envelope: envelopeValidator,
    binding: v.string(),
    expiresAt: v.number(),
  }).index("by_attempt_id", ["id"]),
  // Synthetic provider state only; never stores real credentials.
  fakeProvider: defineTable({
    key: v.string(),
    generation: v.number(),
    calls: v.number(),
    requests: v.optional(v.number()),
  }).index("by_key", ["key"]),
});
