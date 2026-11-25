// Visual file explorer back-end: listing and a transfer queue with progress, speed and cancel.
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import type { RemoteEntry, TransferJob } from '@shared/types'
import { AppError } from '../lib/errors'
import {
  isInsideUserStorage,
  isValidRemoteName,
  joinRemotePath,
  normalizeRemotePath,
  remoteBasename,
  remoteDirname,
  sanitizeLocalFileName,
  shellCommand,
  uniqueName
} from '../lib/paths'
import { emit } from '../services/events'
import { logError, logInfo, logSuccess } from '../services/log'
import { getSettings } from '../services/settings'
import { shell } from './runner'
import { isDirMode, isLinkMode, SyncSession, withSync, type SyncDirent } from './sync'
import { requireOnline } from './tracker'

// ---------------------------------------------------------------------------
// Listing

export async function listDirectory(serial: string, path: string): Promise<RemoteEntry[]> {
  requireOnline(serial)
  const dir = normalizeRemotePath(path)
  return withSync(serial, async (sync) => {
    const entries = await sync.list(dir + (dir === '/' ? '' : '/'))
    const out: RemoteEntry[] = []
    for (const e of entries) {
      let isDir = isDirMode(e.mode)
      const isLink = isLinkMode(e.mode)
      let size = e.size
      if (isLink) {
        // Resolve symlinks (e.g. /sdcard → /storage/self/primary).
        const target = await sync.stat(joinRemotePath(dir, e.name)).catch(() => null)
        if (target) {
          isDir = isDirMode(target.mode)
          size = target.size
        }
      }
      out.push({ name: e.name, path: joinRemotePath(dir, e.name), isDir, isLink, size, mtime: e.mtime })
    }
    out.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : a.isDir ? -1 : 1))
    return out
  })
}

function assertUserStorage(path: string): void {
  if (!isInsideUserStorage(path)) {
    throw new AppError({
      title: 'Protected location',
      message: 'For safety, Easy ADB only changes files inside your phone’s Internal storage.',
      code: 'PROTECTED_PATH'
    })
  }
}

export async function makeDirectory(serial: string, path: string): Promise<void> {
  requireOnline(serial)
  const norm = normalizeRemotePath(path)
  assertUserStorage(norm)
  if (!isValidRemoteName(remoteBasename(norm))) throw new AppError({ title: 'Invalid name', message: 'That folder name isn’t allowed.' })
  await shell(serial, shellCommand('mkdir', '-p', norm), { log: `Created folder ${remoteBasename(norm)}` })
}

export async function renameEntry(serial: string, from: string, to: string): Promise<void> {
  requireOnline(serial)
  const src = normalizeRemotePath(from)
  const dst = normalizeRemotePath(to)
  assertUserStorage(src)
  assertUserStorage(dst)
  if (!isValidRemoteName(remoteBasename(dst))) throw new AppError({ title: 'Invalid name', message: 'That name isn’t allowed.' })
  const exists = await withSync(serial, (s) => s.stat(dst))
  if (exists) throw new AppError({ title: 'Name already used', message: `Something called “${remoteBasename(dst)}” already exists here.` })
  await shell(serial, shellCommand('mv', '-n', src, dst), { log: `Renamed ${remoteBasename(src)} → ${remoteBasename(dst)}` })
}

/** Delete one file or folder inside user storage (always confirmed in the UI). */
export async function deleteEntry(serial: string, path: string): Promise<void> {
  requireOnline(serial)
  const norm = normalizeRemotePath(path)
  assertUserStorage(norm)
  const depth = norm.split('/').filter(Boolean).length
  const protectedRoots = ['/sdcard', '/storage/emulated/0', '/storage/emulated', '/storage/self/primary', '/storage']
  if (protectedRoots.includes(norm) || depth < 2) {
    throw new AppError({ title: 'Protected location', message: 'Easy ADB won’t delete your whole storage.' })
  }
  const stat = await withSync(serial, (s) => s.stat(norm))
  if (!stat) return
  const cmd = isDirMode(stat.mode) ? shellCommand('rm', '-r', '--', norm) : shellCommand('rm', '--', norm)
  await shell(serial, cmd, { log: `Deleted ${remoteBasename(norm)}` })
}

// ---------------------------------------------------------------------------
// Transfer queue

interface InternalJob extends TransferJob {
  controller: AbortController
  /** Set when the app stopped the transfer because the phone went away (not the user's Cancel). */
  lostDevice?: boolean
  run: () => Promise<void>
  session?: SyncSession
}

const jobs = new Map<string, InternalJob>()
const queue: string[] = []
const MAX_PARALLEL = 2
let running = 0

function publicJob(j: InternalJob): TransferJob {
  const { controller, run, session, ...rest } = j
  return { ...rest }
}

function publish(j: InternalJob): void {
  emit('transfer:update', publicJob(j))
}

export function listTransfers(): TransferJob[] {
  return [...jobs.values()].map(publicJob)
}

export function clearFinished(): void {
  for (const [id, j] of jobs) if (j.status !== 'running' && j.status !== 'queued') jobs.delete(id)
}

const LOST_DEVICE_MESSAGE = 'The phone disconnected during the copy. Nothing half-copied was kept — try again once it’s back.'

export function cancelTransfer(id: string, lostDevice = false): void {
  const j = jobs.get(id)
  if (!j) return
  j.lostDevice = lostDevice
  if (j.status === 'queued') {
    j.status = lostDevice ? 'error' : 'cancelled'
    if (lostDevice) j.error = LOST_DEVICE_MESSAGE
    j.finishedAt = Date.now()
    const idx = queue.indexOf(id)
    if (idx >= 0) queue.splice(idx, 1)
    publish(j)
    return
  }
  j.controller.abort()
  j.session?.destroy()
}

/** Stop every transfer bound to a device that just disappeared (reported as failed, not cancelled). */
export function cancelTransfersFor(serial: string): void {
  for (const j of jobs.values()) {
    if (j.serial === serial && (j.status === 'running' || j.status === 'queued')) cancelTransfer(j.id, true)
  }
}

function pump(): void {
  while (running < MAX_PARALLEL && queue.length) {
    const id = queue.shift()!
    const job = jobs.get(id)
    if (!job || job.status !== 'queued') continue
    running++
    job.status = 'running'
    job.startedAt = Date.now()
    publish(job)
    job
      .run()
      .then(() => {
        job.status = 'done'
        job.transferredBytes = Math.max(job.transferredBytes, job.totalBytes)
        logSuccess(`${job.direction === 'upload' ? 'Copied to phone' : 'Saved to PC'}: ${job.label}`)
      })
      .catch((e: unknown) => {
        if (job.lostDevice) {
          job.status = 'error'
          job.error = LOST_DEVICE_MESSAGE
          logError(`Transfer stopped: ${job.label} — the phone disconnected`)
        } else if (job.controller.signal.aborted) {
          job.status = 'cancelled'
          logInfo(`Transfer cancelled: ${job.label}`)
        } else {
          job.status = 'error'
          job.error = e instanceof AppError ? e.friendly.message : e instanceof Error ? e.message : String(e)
          logError(`Transfer failed: ${job.label} — ${job.error}`)
        }
      })
      .finally(() => {
        job.finishedAt = Date.now()
        job.bytesPerSecond = 0
        job.session = undefined
        running--
        publish(job)
        pump()
      })
  }
}

function createJob(partial: Omit<TransferJob, 'id' | 'status' | 'transferredBytes' | 'bytesPerSecond' | 'filesDone'>, run: (job: InternalJob) => Promise<void>): string {
  const job: InternalJob = {
    ...partial,
    id: randomUUID(),
    status: 'queued',
    transferredBytes: 0,
    bytesPerSecond: 0,
    filesDone: 0,
    controller: new AbortController(),
    run: async () => run(job)
  }
  jobs.set(job.id, job)
  queue.push(job.id)
  publish(job)
  pump()
  return job.id
}

/** Tracks bytes and publishes throttled progress with a smoothed speed. */
function progressTracker(job: InternalJob): (n: number) => void {
  let windowStart = Date.now()
  let windowBytes = 0
  let lastPublish = 0
  return (n: number) => {
    job.transferredBytes += n
    windowBytes += n
    const now = Date.now()
    const elapsed = now - windowStart
    if (elapsed >= 500) {
      const instant = (windowBytes * 1000) / elapsed
      job.bytesPerSecond = job.bytesPerSecond ? job.bytesPerSecond * 0.6 + instant * 0.4 : instant
      windowStart = now
      windowBytes = 0
    }
    if (now - lastPublish >= 150) {
      lastPublish = now
      publish(job)
    }
  }
}

// ---- upload -----------------------------------------------------------------

interface LocalFile {
  abs: string
  rel: string // posix relative path inside the dropped item
  size: number
  mtime: number
}

function walkLocal(root: string): { files: LocalFile[]; dirs: string[] } {
  const files: LocalFile[] = []
  const dirs: string[] = []
  const st = statSync(root)
  if (st.isFile()) {
    files.push({ abs: root, rel: basename(root), size: st.size, mtime: Math.floor(st.mtimeMs / 1000) })
    return { files, dirs }
  }
  const stack = [root]
  const top = basename(root)
  dirs.push(top)
  while (stack.length) {
    const dir = stack.pop()!
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name)
      let s
      try {
        s = statSync(abs)
      } catch {
        continue
      }
      const rel = [top, ...relative(root, abs).split(/[\\/]/)].join('/')
      if (s.isDirectory()) {
        dirs.push(rel)
        stack.push(abs)
      } else if (s.isFile()) {
        files.push({ abs, rel, size: s.size, mtime: Math.floor(s.mtimeMs / 1000) })
      }
    }
  }
  return { files, dirs }
}

export async function uploadPaths(serial: string, localPaths: string[], remoteDir: string): Promise<string[]> {
  requireOnline(serial)
  const dir = normalizeRemotePath(remoteDir)
  assertUserStorage(dir)
  const existing = new Set((await listDirectory(serial, dir)).map((e) => e.name))
  const ids: string[] = []
  for (const local of localPaths) {
    if (!existsSync(local)) continue
    const { files, dirs } = walkLocal(local)
    const topName = uniqueName(basename(local), (n) => existing.has(n))
    existing.add(topName)
    const rename = (rel: string): string => topName + rel.slice(rel.indexOf('/') === -1 ? rel.length : rel.indexOf('/'))
    const totalBytes = files.reduce((s, f) => s + f.size, 0)
    ids.push(
      createJob(
        {
          serial,
          direction: 'upload',
          label: topName,
          source: local,
          destination: joinRemotePath(dir, topName),
          totalBytes,
          filesTotal: files.length
        },
        async (job) => {
          const onBytes = progressTracker(job)
          // Create folders first so empty ones are preserved.
          if (dirs.length) {
            const mk = dirs.map((d) => joinRemotePath(dir, rename(d)))
            for (let i = 0; i < mk.length; i += 50) {
              await shell(serial, shellCommand('mkdir', '-p', ...mk.slice(i, i + 50)), { signal: job.controller.signal })
            }
          }
          const session = await SyncSession.open(serial)
          job.session = session
          let current = ''
          try {
            for (const f of files) {
              if (job.controller.signal.aborted) throw new Error('Cancelled')
              const relTarget = files.length === 1 && dirs.length === 0 ? topName : rename(f.rel)
              current = joinRemotePath(dir, relTarget)
              job.currentFile = f.rel.slice(f.rel.lastIndexOf('/') + 1)
              await session.push(f.abs, current, { mtime: f.mtime, onBytes, signal: job.controller.signal })
              job.filesDone++
              current = ''
            }
          } finally {
            await session.close()
            if (current) {
              // Cancelled or failed mid-file: remove the half-written file (we created it under a unique
              // name). If the phone is gone this fails quietly; adbd also discards interrupted files.
              await shell(serial, shellCommand('rm', '-f', '--', current), { timeoutMs: 5000 }).catch(() => undefined)
            }
          }
        }
      )
    )
  }
  return ids
}

// ---- download ---------------------------------------------------------------

async function walkRemote(sync: SyncSession, root: string): Promise<{ files: { remote: string; rel: string; size: number; mtime: number }[]; dirs: string[] }> {
  const files: { remote: string; rel: string; size: number; mtime: number }[] = []
  const dirs: string[] = []
  const rootStat = await sync.stat(root)
  if (!rootStat) throw new AppError({ title: 'Not found', message: `“${remoteBasename(root)}” no longer exists on the phone.` })
  const top = remoteBasename(root)
  if (!isDirMode(rootStat.mode)) {
    files.push({ remote: root, rel: top, size: rootStat.size, mtime: rootStat.mtime })
    return { files, dirs }
  }
  dirs.push(top)
  const stack: { remote: string; rel: string }[] = [{ remote: root, rel: top }]
  while (stack.length) {
    const { remote, rel } = stack.pop()!
    let entries: SyncDirent[] = []
    try {
      entries = await sync.list(remote + '/')
    } catch {
      continue
    }
    for (const e of entries) {
      const childRemote = joinRemotePath(remote, e.name)
      const childRel = `${rel}/${e.name}`
      if (isDirMode(e.mode)) {
        dirs.push(childRel)
        stack.push({ remote: childRemote, rel: childRel })
      } else if (!isLinkMode(e.mode)) {
        files.push({ remote: childRemote, rel: childRel, size: e.size, mtime: e.mtime })
      }
    }
  }
  return { files, dirs }
}

function localPathFor(base: string, rel: string): string {
  return join(base, ...rel.split('/').map(sanitizeLocalFileName))
}

export async function downloadPaths(serial: string, remotePaths: string[], localDir?: string): Promise<string[]> {
  requireOnline(serial)
  const target = localDir || getSettings().downloadDir
  mkdirSync(target, { recursive: true })
  const ids: string[] = []
  for (const remote of remotePaths) {
    const root = normalizeRemotePath(remote)
    const topSafe = uniqueName(sanitizeLocalFileName(remoteBasename(root)), (n) => existsSync(join(target, n)))
    ids.push(
      createJob(
        {
          serial,
          direction: 'download',
          label: remoteBasename(root),
          source: root,
          destination: join(target, topSafe),
          totalBytes: 0,
          filesTotal: 0
        },
        async (job) => {
          const session = await SyncSession.open(serial)
          job.session = session
          let current = ''
          try {
            const { files, dirs } = await walkRemote(session, root)
            job.totalBytes = files.reduce((s, f) => s + f.size, 0)
            job.filesTotal = files.length
            publish(job)
            const remap = (rel: string): string => topSafe + rel.slice(rel.indexOf('/') === -1 ? rel.length : rel.indexOf('/'))
            for (const d of dirs) mkdirSync(localPathFor(target, remap(d)), { recursive: true })
            const onBytes = progressTracker(job)
            for (const f of files) {
              if (job.controller.signal.aborted) throw new Error('Cancelled')
              current = files.length === 1 && dirs.length === 0 ? join(target, topSafe) : localPathFor(target, remap(f.rel))
              job.currentFile = remoteBasename(f.remote)
              await session.pull(f.remote, current, { onBytes, signal: job.controller.signal })
              job.filesDone++
              current = ''
            }
          } finally {
            await session.close()
            // Cancelled or failed mid-file: don't leave a truncated file that looks complete.
            if (current) rmSync(current, { force: true })
          }
        }
      )
    )
  }
  return ids
}

/** Pull a single remote file to an exact local path (used by capture & installer). */
export async function pullFile(serial: string, remote: string, local: string): Promise<void> {
  await withSync(serial, (s) => s.pull(remote, local))
}

export async function pushFile(serial: string, local: string, remote: string, onBytes?: (n: number) => void): Promise<void> {
  await withSync(serial, (s) => s.push(local, remote, { onBytes }))
}

export { remoteDirname }
