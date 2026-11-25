// Screenshots and screen recordings saved straight to the PC.
import { nativeImage } from 'electron'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CaptureResult } from '@shared/types'
import { AppError, toFriendlyError } from '../lib/errors'
import { shellCommand, uniqueName } from '../lib/paths'
import { emit } from '../services/events'
import { logInfo, logSuccess } from '../services/log'
import { getSettings } from '../services/settings'
import { pullFile } from './files'
import { adbBinary, shell, spawnAdb } from './runner'
import { requireOnline } from './tracker'

function stamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
}

function captureDir(): string {
  const dir = getSettings().captureDir
  mkdirSync(dir, { recursive: true })
  return dir
}

export async function takeScreenshot(serial: string): Promise<CaptureResult> {
  requireOnline(serial)
  const png = await adbBinary(['exec-out', 'screencap', '-p'], { serial, timeoutMs: 30_000, log: 'Took a screenshot' })
  if (png.length < 100 || png.readUInt32BE(0) !== 0x89504e47) {
    throw new AppError({
      title: 'Screenshot failed',
      message: 'The phone didn’t return an image.',
      hint: 'Some apps (banking, streaming) block screenshots. Unlock the phone and try again.'
    })
  }
  const dir = captureDir()
  const name = uniqueName(`Screenshot_${stamp()}.png`, (n) => existsSync(join(dir, n)))
  const path = join(dir, name)
  writeFileSync(path, png)
  let previewDataUrl: string | undefined
  try {
    const img = nativeImage.createFromBuffer(png)
    const size = img.getSize()
    previewDataUrl = img.resize({ width: Math.min(420, size.width), quality: 'good' }).toDataURL()
  } catch {
    /* preview is optional */
  }
  logSuccess(`Screenshot saved to ${path}`)
  return { path, previewDataUrl }
}

interface Recording {
  child: ChildProcess
  remote: string
  startedAt: number
  done: Promise<void>
}

const recordings = new Map<string, Recording>()
const autoFinished = new Map<string, Promise<CaptureResult>>()

export function activeRecordings(): { serial: string; startedAt: number }[] {
  return [...recordings.entries()].map(([serial, r]) => ({ serial, startedAt: r.startedAt }))
}

export async function startRecording(serial: string): Promise<void> {
  requireOnline(serial)
  if (recordings.has(serial)) return
  const remote = `/sdcard/Movies/.easyadb_rec_${Date.now()}.mp4`
  await shell(serial, shellCommand('mkdir', '-p', '/sdcard/Movies'))
  const child = spawnAdb(['shell', shellCommand('screenrecord', '--bit-rate', '12000000', remote)], serial)
  const startedAt = Date.now()
  const done = new Promise<void>((resolve) => child.on('close', () => resolve()))
  recordings.set(serial, { child, remote, startedAt, done })
  logInfo('Started screen recording', { command: `screenrecord ${remote}` })
  emit('record:state', { serial, recording: true, startedAt })

  // screenrecord stops by itself after 3 minutes → save automatically (the renderer is told via events).
  void done.then(() => {
    const rec = recordings.get(serial)
    if (rec && rec.child === child) {
      const saving = finishRecording(serial, rec, true)
      autoFinished.set(serial, saving)
      void saving
        .catch(() => undefined)
        .finally(() => {
          if (autoFinished.get(serial) === saving) autoFinished.delete(serial)
        })
    }
  })
}

async function finishRecording(serial: string, rec: Recording, auto = false): Promise<CaptureResult> {
  recordings.delete(serial)
  emit('record:state', { serial, recording: false, saving: true, auto })
  try {
    // Give the device a moment to finalise the MP4.
    await new Promise((r) => setTimeout(r, 800))
    const dir = captureDir()
    const name = uniqueName(`Recording_${stamp()}.mp4`, (n) => existsSync(join(dir, n)))
    const path = join(dir, name)
    try {
      await pullFile(serial, rec.remote, path)
    } finally {
      await shell(serial, shellCommand('rm', '-f', rec.remote)).catch(() => undefined)
    }
    logSuccess(`Recording saved to ${path}`)
    emit('record:state', { serial, recording: false, savedPath: path, auto })
    return { path }
  } catch (e) {
    emit('record:state', { serial, recording: false, error: toFriendlyError(e), auto })
    throw e
  }
}

export async function stopRecording(serial: string): Promise<CaptureResult> {
  const pending = autoFinished.get(serial)
  if (pending) {
    autoFinished.delete(serial)
    return pending
  }
  const rec = recordings.get(serial)
  if (!rec) throw new AppError({ title: 'Not recording', message: 'There is no recording in progress.' })
  // SIGINT lets screenrecord write the MP4 index properly.
  await shell(serial, 'pkill -INT screenrecord || killall -INT screenrecord', { log: 'Stopped screen recording' }).catch(() => undefined)
  await Promise.race([rec.done, new Promise((r) => setTimeout(r, 5000))])
  if (recordings.get(serial) === rec) return finishRecording(serial, rec)
  const auto = autoFinished.get(serial)
  autoFinished.delete(serial)
  if (auto) return auto
  return finishRecording(serial, rec)
}

export function abortRecording(serial: string): void {
  const rec = recordings.get(serial)
  if (!rec) return
  recordings.delete(serial)
  rec.child.kill()
  emit('record:state', { serial, recording: false })
}
