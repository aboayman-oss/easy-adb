// Spawns adb with argument arrays (never through a host shell), with timeouts,
// cancellation and activity logging.
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { adbPath } from '../engine/paths'
import { describeCommand } from '../lib/commands'
import { logError, logInfo } from '../services/log'

export interface RunOptions {
  serial?: string
  timeoutMs?: number
  signal?: AbortSignal
  /** Friendly message for the activity log; false = don't log. */
  log?: string | false
  /** Don't throw on non-zero exit codes. */
  allowFailure?: boolean
  env?: NodeJS.ProcessEnv
}

export interface RunResult {
  stdout: string
  stderr: string
  code: number
}

const children = new Set<ChildProcess>()

export function adbEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...process.env, ADB_MDNS_OPENSCREEN: '1', ...extra }
}

function withSerial(args: string[], serial?: string): string[] {
  return serial ? ['-s', serial, ...args] : args
}

/** Human-readable command line for the activity log (paths quoted for readability only). */
export { describeCommand }

function runRaw(args: string[], opts: RunOptions & { binary: true }): Promise<{ stdout: Buffer; stderr: string; code: number }>
function runRaw(args: string[], opts: RunOptions & { binary?: false }): Promise<RunResult>
function runRaw(
  args: string[],
  opts: RunOptions & { binary?: boolean }
): Promise<RunResult | { stdout: Buffer; stderr: string; code: number }> {
  const fullArgs = withSerial(args, opts.serial)
  const started = Date.now()
  const timeoutMs = opts.timeoutMs ?? 30_000
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(adbPath(), fullArgs, {
        windowsHide: true,
        env: adbEnv(opts.env),
        stdio: ['ignore', 'pipe', 'pipe']
      } satisfies SpawnOptions)
    } catch (e) {
      reject(e)
      return
    }
    children.add(child)
    const out: Buffer[] = []
    const err: Buffer[] = []
    let settled = false
    child.stdout?.on('data', (c: Buffer) => out.push(c))
    child.stderr?.on('data', (c: Buffer) => err.push(c))

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      children.delete(child)
      fn()
    }
    const timer = timeoutMs > 0 ? setTimeout(() => {
      child.kill()
      finish(() => reject(new Error(`Command timed out: ${describeCommand(fullArgs)}`)))
    }, timeoutMs) : undefined
    const onAbort = (): void => {
      child.kill()
      finish(() => reject(new Error('Cancelled')))
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    child.on('error', (e) => finish(() => reject(e)))
    // `adb start-server` hands its stdio to the daemon it launches, so 'close' may never
    // fire on Windows. Treat 'exit' + a short grace period as completion too.
    child.on('exit', (code) => {
      setTimeout(() => child.emit('close', code), 300)
    })
    child.on('close', (code) => {
      finish(() => {
        const stdoutBuf = Buffer.concat(out)
        const stderr = Buffer.concat(err).toString('utf8')
        const exitCode = code ?? -1
        const durationMs = Date.now() - started
        if (opts.log !== false) {
          const message = opts.log || 'Ran a command'
          if (exitCode === 0 || opts.allowFailure) logInfo(message, { command: describeCommand(fullArgs), durationMs })
          else logError(`${message} — failed`, { command: describeCommand(fullArgs), durationMs })
        }
        if (exitCode !== 0 && !opts.allowFailure) {
          const text = (stderr.trim() || stdoutBuf.toString('utf8').trim() || `adb exited with code ${exitCode}`).slice(0, 2000)
          reject(new Error(text))
          return
        }
        if (opts.binary) resolve({ stdout: stdoutBuf, stderr, code: exitCode })
        else resolve({ stdout: stdoutBuf.toString('utf8'), stderr, code: exitCode })
      })
    })
  })
}

export function adb(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return runRaw(args, { ...opts, binary: false })
}

export async function adbBinary(args: string[], opts: RunOptions = {}): Promise<Buffer> {
  const res = await runRaw(args, { ...opts, binary: true })
  return res.stdout
}

/** Run a command line in the device shell. Dynamic values MUST be quoted with shellQuote(). */
export async function shell(serial: string, command: string, opts: Omit<RunOptions, 'serial'> = {}): Promise<string> {
  const res = await adb(['shell', command], { log: false, ...opts, serial })
  return res.stdout
}

/** Spawn a long-running adb process (tracked so it can be cleaned up on quit). */
export function spawnAdb(args: string[], serial?: string, env?: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(adbPath(), withSerial(args, serial), {
    windowsHide: true,
    env: adbEnv(env),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  children.add(child)
  child.on('close', () => children.delete(child))
  return child
}

export function trackChild(child: ChildProcess): void {
  children.add(child)
  child.on('close', () => children.delete(child))
}

export function killAllChildren(): void {
  for (const child of children) {
    try {
      child.kill()
    } catch {
      /* already gone */
    }
  }
  children.clear()
}

export function logCommand(message: string, args: string[]): void {
  logInfo(message, { command: describeCommand(args) })
}
