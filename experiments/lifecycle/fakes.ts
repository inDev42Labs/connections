// FAKE PROVIDER: no HTTP, OAuth, encryption, or verified real-provider semantics.
import { atomic, fail } from './model'
import type { Policy, Provider, Tokens } from './model'

export const initialTokens = (): Tokens => ({ access: 'FAKE-access-0', refresh: 'FAKE-refresh-0', expires: 0, refreshExpires: 10_000 })
export class FakeProvider {
  calls = 0
  exchanges = 0
  processed = 0
  loseResponses = 0
  loseExchangeResponses = 0
  private valid = 'FAKE-refresh-0'
  private readonly conditionalResponses = new Map<string, { first: number; tokens: Tokens; retired: boolean }>()
  constructor(readonly policy: Policy, private readonly now: () => number) {}
  // Test-only complete state; provider commits independently of credential storage.
  exportState() {
    return structuredClone({ policy: this.policy, calls: this.calls, exchanges: this.exchanges,
      processed: this.processed, loseResponses: this.loseResponses, loseExchangeResponses: this.loseExchangeResponses,
      valid: this.valid, conditionalResponses: [...this.conditionalResponses] })
  }
  static restoreState(state: ReturnType<FakeProvider['exportState']>, now: () => number): FakeProvider {
    const s = structuredClone(state)
    const provider = new FakeProvider(s.policy, now)
    provider.calls = s.calls; provider.exchanges = s.exchanges; provider.processed = s.processed
    provider.loseResponses = s.loseResponses; provider.loseExchangeResponses = s.loseExchangeResponses
    provider.valid = s.valid
    for (const [k, v] of s.conditionalResponses) provider.conditionalResponses.set(k, v)
    return provider
  }
  service(): Provider['Service'] {
    return {
      policy: this.policy,
      refresh: (tokens) => atomic(() => {
        this.calls++
        if (this.now() >= tokens.refreshExpires) return fail('unknown')
        const prior = this.conditionalResponses.get(tokens.refresh)
        if (this.policy.kind === 'conditional' && prior) {
          if (prior.retired || this.now() - prior.first >= this.policy.window) return fail('unknown')
        } else if (tokens.refresh !== this.valid) return fail('unknown')
        this.processed++
        // Strong FAKE conditional contract: replay returns the SAME replacement,
        // until its first-use window closes or that replacement is itself used.
        const next = prior?.tokens ?? { access: `FAKE-access-${this.processed}`, refresh: this.policy.kind === 'reusable'
          ? tokens.refresh : `FAKE-refresh-${this.processed}`, expires: this.now() + 1000, refreshExpires: tokens.refreshExpires }
        if (this.policy.kind === 'conditional' && !prior) {
          for (const response of this.conditionalResponses.values()) {
            if (response.tokens.refresh === tokens.refresh) response.retired = true
          }
          this.conditionalResponses.set(tokens.refresh, { first: this.now(), tokens: next, retired: false })
        }
        this.valid = next.refresh
        if (this.loseResponses > 0) { this.loseResponses--; return fail('unknown') }
        return next
      }),
      // Browser preparation is assumed inert; only exchange changes the grant.
      exchange: () => atomic(() => {
        this.exchanges++
        const tokens = { access: `FAKE-authorized-${this.exchanges}`, refresh: `FAKE-grant-${this.exchanges}`,
          expires: this.now() + 1000, refreshExpires: this.now() + 10_000 }
        this.valid = tokens.refresh
        this.conditionalResponses.clear() // New fake grant retires earlier replay permissions.
        if (this.loseExchangeResponses > 0) { this.loseExchangeResponses--; return fail('unknown') }
        return tokens
      }),
    }
  }
}
