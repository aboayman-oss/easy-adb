// One-click screen mirroring via scrcpy.
import { spawn, type ChildProcess } from 'node:child_process'
import type { FriendlyError, MirrorOptions } from '@shared/types'
import { adbPath, hasScrcpy, scrcpyPath, scrcpyServerPath } from '../engine/paths'
import { AppError } from '../lib/errors'
import { emit } from '../services/events'
import { logError, logInfo } from '../services/log'
import { requireOnline } from './tracker'

const sessions = new Map<string, ChildProcess>()

export function buildScrcpyArgs(serial: string, opts: MirrorOptions, title: string): string[] {
  const args = [`--serial=${serial}`, `--window-title=${title}`]
  switch (opts.quality) {
    case 'smooth':
      args.push('--video-bit-rate=16M', '--max-fps=60')
      break
    case 'balanced':
      args.push('--max-size=1600', '--video-bit-rate=8M', '--max-fps=60')
      break
    case 'saver':
      args.push('--max-size=1024', '--video-bit-rate=2M', '--max-fps=30')
      break
  }
  if (opts.turnScreenOff) args.push('--turn-screen-off')
  if (opts.stayAwake) args.push('--stay-awake')
  if (!opts.audio) args.push('--no-audio')
  if (opts.alwaysOnTop) args.push('--always-on-top')
  return args
}

export function translateScrcpyError(text: string): FriendlyError {
  if (/Could not find any ADB device|device .* not found/i.test(text)) {
    return { title: 'Phone not found', message: 'The phone disconnected before mirroring could start.', hint: 'Reconnect it and try again.' }
  }
  if (/unauthorized/i.test(text)) {
    return { title: 'Permission needed', message: 'Allow USB debugging on your phone first.' }
  }
  if (/Could not open video stream|encoder|MediaCodec/i.test(text)) {
    return {
      title: 'Mirroring couldn’t start',
      message: 'Your phone’s video encoder refused the selected quality.',
      hint: 'Try the “Data saver” quality preset.'
    }
  }
  if (/SDL|video driver|Could not create window/i.test(text)) {
    return { title: 'Display problem', message: 'The mirroring window couldn’t be created on this computer.' }
  }
  return { title: 'Mirroring stopped', message: 'Screen mirroring ended unexpectedly.', hint: 'Open the Activity Log for details.' }
}

export function startMirror(serial: string, opts: MirrorOptions, title: string): void {
  requireOnline(serial)
  if (!hasScrcpy()) {
    throw new AppError({ title: 'Mirroring engine missing', message: 'The screen-mirroring engine isn’t installed yet.', hint: 'Open Settings → Repair engine.' })
  }
  if (sessions.has(serial)) return
  const args = buildScrcpyArgs(serial, opts, title)
  logInfo('Started screen mirroring', { command: `scrcpy ${args.join(' ')}` })
  const env = { ...process.env, ADB: adbPath(), SCRCPY_SERVER_PATH: scrcpyServerPath() }
  let child: ChildProcess
  if (process.platform === 'win32') {
    // scrcpy.exe is a console program. Launch it the way its own scrcpy-noconsole.vbs
    // does: through `cmd /c` with a hidden console. scrcpy and the adb processes it
    // starts share that invisible console, while the mirroring window shows normally.
    child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${windowsCommandLine([scrcpyPath(), ...args])}"`], {
      env,
      windowsHide: true,
      windowsVerbatimArguments: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } else {
    child = spawn(scrcpyPath(), args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  }
  sessions.set(serial, child)
  let output = ''
  const collect = (c: Buffer): void => {
    output = (output + c.toString('utf8')).slice(-8000)
  }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)
  emit('mirror:state', { serial, running: true })

  child.on('error', (e) => {
    sessions.delete(serial)
    logError(`Mirroring failed to start: ${e.message}`)
    emit('mirror:state', { serial, running: false, error: translateScrcpyError(e.message) })
  })
  child.on('exit', (code) => {
    if (sessions.get(serial) !== child) return
    sessions.delete(serial)
    if (code === 0 || code === null) {
      logInfo('Screen mirroring closed')
      emit('mirror:state', { serial, running: false })
    } else {
      logError(`Screen mirroring stopped (code ${code}): ${output.split(/\r?\n/).filter((l) => /ERROR|error/.test(l)).slice(-3).join(' | ')}`)
      emit('mirror:state', { serial, running: false, error: translateScrcpyError(output) })
    }
  })
}

/** Quote arguments for a cmd.exe command line; `"` and `%` can't appear safely, so drop them. */
export function windowsCommandLine(argv: string[]): string {
  return argv.map((a) => `"${a.replace(/["%\r\n]/g, '')}"`).join(' ')
}

function killTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid) {
    // Killing cmd.exe alone would leave scrcpy running.
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill())
  } else {
    child.kill()
  }
}

export function stopMirror(serial: string): void {
  const child = sessions.get(serial)
  if (!child) return
  sessions.delete(serial)
  killTree(child)
  logInfo('Stopped screen mirroring')
  emit('mirror:state', { serial, running: false })
}

export function runningMirrors(): string[] {
  return [...sessions.keys()]
}

export function stopAllMirrors(): void {
  for (const serial of [...sessions.keys()]) stopMirror(serial)
}
