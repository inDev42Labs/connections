// Local-runner-only launch guard for pinned Convex CLI 1.45.0.
// That CLI does not expose the backend's --interface flag; the binary otherwise
// defaults to 0.0.0.0. Do not load this hook in application code.
const childProcess = require('node:child_process')
const { basename } = require('node:path')
const { syncBuiltinESMExports } = require('node:module')
const originalSpawn = childProcess.spawn

childProcess.spawn = function (file, args, options) {
  if (typeof file === 'string' && basename(file) === 'convex-local-backend'
    && Array.isArray(args) && args.includes('--port')) {
    return originalSpawn(file, [...args, '--interface', '127.0.0.1', '--disable-beacon'], {
      ...options,
      env: { ...process.env, ...options?.env, SENTRY_DSN: '', DISABLE_BEACON: 'true' },
    })
  }
  return originalSpawn(file, args, options)
}
syncBuiltinESMExports()
