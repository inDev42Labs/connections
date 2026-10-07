import assert from 'node:assert/strict'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import {
  assertPortsAvailable,
  inheritedCredentialCanaryName,
} from '../helpers/process-isolation.js'

const [scratch, portValue] = process.argv.slice(2)
assert.ok(scratch, 'Missing scratch directory')
assert.ok(portValue, 'Missing test port')
const port = Number(portValue)
assert.equal(
  process.env[inheritedCredentialCanaryName],
  undefined,
  'Inherited credential was not stripped',
)
assert.equal(process.env.HOME, resolve(scratch, 'home'), 'Worker HOME is not private')
assert.equal(process.env.XDG_CACHE_HOME, resolve(scratch, 'cache'), 'Worker cache is not private')
await assertPortsAvailable([port])

const server = createServer()
let cleaning = false
const cleanup = (code: number): void => {
  if (cleaning) return
  cleaning = true
  server.close(() => {
    rmSync(scratch, { recursive: true, force: true })
    assert.equal(existsSync(scratch), false, 'Worker scratch directory was not removed')
    process.exit(code)
  })
}
process.once('SIGINT', () => cleanup(130))
process.once('SIGTERM', () => cleanup(143))

await new Promise<void>((done, reject) => {
  server.once('error', reject)
  server.listen(port, '127.0.0.1', () => done())
})
writeFileSync(resolve(scratch, 'owned.marker'), String(process.pid))
console.log('READY')
