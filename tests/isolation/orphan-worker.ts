import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'

const [mode, portValue] = process.argv.slice(2)
assert.ok(portValue, 'Missing test port')

if (mode === 'parent') {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'child', portValue], {
    stdio: 'ignore',
  })
  child.unref()
} else {
  assert.equal(mode, 'child', 'Unsupported worker mode')
  const server = createServer()
  server.listen(Number(portValue), '127.0.0.1')
  process.once('SIGTERM', () => server.close(() => process.exit(0)))
}
