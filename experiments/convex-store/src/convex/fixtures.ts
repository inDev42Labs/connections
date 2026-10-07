// LOCAL-ONLY test endpoints. Never a production credential-management API.
import { v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { components } from './_generated/api'
import { envelopeValidator, recordValidator } from '../component/schema'
import { requireLocalFixture } from './localOnly'

export const read = query({
  args: { key: v.string() }, returns: v.union(recordValidator, v.null()),
  handler: async (ctx, args) => {
    requireLocalFixture()
    return ctx.runQuery(components.credentialStore.records.read, args)
  },
})
export const providerCalls = query({
  args: { key: v.string() }, returns: v.number(),
  handler: async (ctx, args) => {
    requireLocalFixture()
    return ctx.runQuery(components.credentialStore.records.providerCalls, args)
  },
})
export const providerRequests = query({
  args: { key: v.string() }, returns: v.number(),
  handler: async (ctx, args) => {
    requireLocalFixture()
    return ctx.runQuery(components.credentialStore.records.providerRequests, args)
  },
})
export const claim = mutation({
  args: { key: v.string(), expectedVersion: v.number(), owner: v.string(), leaseMs: v.number() },
  returns: v.union(v.object({ claimed: v.literal(true), version: v.number(), fence: v.number(), leaseUntil: v.number() }), v.object({ claimed: v.literal(false) })),
  handler: async (ctx, args) => {
    requireLocalFixture()
    return ctx.runMutation(components.credentialStore.records.claim, args)
  },
})
export const renew = mutation({
  args: { key: v.string(), owner: v.string(), fence: v.number(), leaseMs: v.number() }, returns: v.boolean(),
  handler: async (ctx, args) => {
    requireLocalFixture()
    return ctx.runMutation(components.credentialStore.records.renew, args)
  },
})
export const complete = mutation({
  args: { key: v.string(), owner: v.string(), fence: v.number(), writeId: v.string(), envelope: envelopeValidator, expiresAt: v.number() },
  returns: v.object({ status: v.union(v.literal('committed'), v.literal('already-applied'), v.literal('conflict')), version: v.number() }),
  handler: async (ctx, args) => {
    requireLocalFixture()
    return ctx.runMutation(components.credentialStore.records.complete, args)
  },
})
export const saveAttempt = mutation({
  args: { id: v.string(), envelope: envelopeValidator, binding: v.string(), expiresAt: v.number() }, returns: v.null(),
  handler: async (ctx, args) => {
    requireLocalFixture()
    return ctx.runMutation(components.credentialStore.attempts.save, args)
  },
})
export const consumeAttempt = mutation({
  args: { id: v.string(), binding: v.string() }, returns: v.union(envelopeValidator, v.null()),
  handler: async (ctx, args) => {
    requireLocalFixture()
    return ctx.runMutation(components.credentialStore.attempts.consume, args)
  },
})
