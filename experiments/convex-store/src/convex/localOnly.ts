import { env } from './_generated/server'

export function requireLocalFixture() {
  const hostname = new URL(env.CONVEX_CLOUD_URL).hostname
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) {
    throw new Error('This fake-only experiment must not run on a remote deployment')
  }
}
