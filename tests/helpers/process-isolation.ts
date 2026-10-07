import assert from 'node:assert/strict'
import { type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { connect } from 'node:net'
import { resolve } from 'node:path'

const inheritedCredentialName =
  /(?:^|_)(?:API_?KEY|AUTH|COOKIE|CREDENTIAL|PASSWORD|SECRET|TOKEN)(?:_|$)|^(?:AWS|AZURE|CONVEX|GITHUB|GOOGLE|NPM|SALESFORCE|VERCEL)_/i

export const inheritedCredentialCanaryName = 'CONNECTIONS_TEST_INHERITED_TOKEN'

export function isolatedEnvironment(
  root: string,
  overrides: NodeJS.ProcessEnv = {},
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(inherited)) {
    if (value !== undefined && !inheritedCredentialName.test(name)) environment[name] = value
  }
  const home = resolve(root, 'home')
  const cache = resolve(root, 'cache')
  const bunCache = resolve(cache, 'bun')
  mkdirSync(home, { recursive: true })
  mkdirSync(cache, { recursive: true })
  mkdirSync(bunCache, { recursive: true })
  return {
    ...environment,
    ...overrides,
    HOME: home,
    XDG_CACHE_HOME: cache,
    BUN_INSTALL_CACHE_DIR: bunCache,
  }
}

export function listening(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      done(true)
    })
    socket.once('error', () => {
      socket.destroy()
      done(false)
    })
  })
}

export async function assertPortsAvailable(ports: readonly number[]): Promise<void> {
  for (const port of ports) {
    assert.equal(await listening(port), false, `Port ${port} occupied; refusing to touch it`)
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((done) => setTimeout(done, milliseconds))
}

export function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((done) => child.once('exit', () => done()))
}

export async function stopOwnedProcessGroup(child: ChildProcess): Promise<void> {
  const pid = child.pid
  if (pid === undefined) return
  const groupExists = (): boolean => {
    try {
      process.kill(-pid, 0)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
      throw error
    }
  }
  if (!groupExists()) return
  for (const [signal, wait] of [
    ['SIGINT', 2_000],
    ['SIGTERM', 2_000],
    ['SIGKILL', 500],
  ] as const) {
    try {
      process.kill(-pid, signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
      throw error
    }
    const deadline = Date.now() + wait
    while (groupExists() && Date.now() < deadline) await delay(20)
    if (!groupExists()) return
  }
}
