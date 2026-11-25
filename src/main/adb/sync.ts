// ADB "sync:" file protocol, spoken directly over the adb server socket.
// Gives exact transfer progress, real cancellation and needs no path escaping.
import { createReadStream, createWriteStream } from 'node:fs'
import { deviceFeatures, openTransport, type AdbSocket } from './host'

export const SYNC_DATA_MAX = 64 * 1024

export interface SyncStat {
  mode: number
  size: number
  mtime: number
}

export interface SyncDirent extends SyncStat {
  name: string
}

export const S_IFMT = 0o170000
export const S_IFDIR = 0o040000
export const S_IFREG = 0o100000
export const S_IFLNK = 0o120000

export const isDirMode = (mode: number): boolean => (mode & S_IFMT) === S_IFDIR
export const isLinkMode = (mode: number): boolean => (mode & S_IFMT) === S_IFLNK
export const isFileMode = (mode: number): boolean => (mode & S_IFMT) === S_IFREG

export function encodeSyncRequest(id: string, data: Buffer | string): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  const header = Buffer.alloc(8)
  header.write(id, 0, 4, 'ascii')
  header.writeUInt32LE(payload.length, 4)
  return Buffer.concat([header, payload])
}

/** Decode a v1 DENT/DONE header (20 bytes). */
export function decodeDentV1(buf: Buffer): { id: string; mode: number; size: number; mtime: number; namelen: number } {
  return {
    id: buf.toString('ascii', 0, 4),
    mode: buf.readUInt32LE(4),
    size: buf.readUInt32LE(8),
    mtime: buf.readUInt32LE(12),
    namelen: buf.readUInt32LE(16)
  }
}

/** Decode a v2 DNT2/DONE header (76 bytes). */
export function decodeDentV2(buf: Buffer): { id: string; error: number; mode: number; size: number; mtime: number; namelen: number } {
  return {
    id: buf.toString('ascii', 0, 4),
    error: buf.readUInt32LE(4),
    mode: buf.readUInt32LE(24),
    size: Number(buf.readBigUInt64LE(40)),
    mtime: Number(buf.readBigInt64LE(56)),
    namelen: buf.readUInt32LE(72)
  }
}

export class SyncCancelledError extends Error {
  constructor() {
    super('Cancelled')
    this.name = 'SyncCancelledError'
  }
}

export class SyncSession {
  private constructor(
    private readonly sock: AdbSocket,
    private readonly v2: boolean
  ) {}

  static async open(serial: string): Promise<SyncSession> {
    const features = await deviceFeatures(serial)
    const sock = await openTransport(serial)
    try {
      await sock.request('sync:')
    } catch (e) {
      sock.close()
      throw e
    }
    return new SyncSession(sock, features.has('ls_v2') && features.has('stat_v2'))
  }

  private async readFailMessage(len: number): Promise<string> {
    return (await this.sock.read(len)).toString('utf8')
  }

  async list(path: string): Promise<SyncDirent[]> {
    const out: SyncDirent[] = []
    if (this.v2) {
      await this.sock.write(encodeSyncRequest('LIS2', path))
      for (;;) {
        const header = await this.sock.read(76)
        const id = header.toString('ascii', 0, 4)
        if (id === 'FAIL') {
          const len = header.readUInt32LE(4)
          const first = header.subarray(8, 8 + Math.min(len, 68))
          const rest = len > 68 ? await this.sock.read(len - 68) : Buffer.alloc(0)
          throw new Error(Buffer.concat([first, rest]).toString('utf8'))
        }
        const d = decodeDentV2(header)
        if (d.id === 'DONE') break
        if (d.id !== 'DNT2') throw new Error(`Unexpected sync reply ${d.id}`)
        const name = (await this.sock.read(d.namelen)).toString('utf8')
        if (name === '.' || name === '..' || d.error !== 0) continue
        out.push({ name, mode: d.mode, size: d.size, mtime: d.mtime })
      }
    } else {
      await this.sock.write(encodeSyncRequest('LIST', path))
      for (;;) {
        const header = await this.sock.read(20)
        const d = decodeDentV1(header)
        if (d.id === 'DONE') break
        if (d.id !== 'DENT') throw new Error(`Unexpected sync reply ${d.id}`)
        const name = (await this.sock.read(d.namelen)).toString('utf8')
        if (name === '.' || name === '..') continue
        out.push({ name, mode: d.mode, size: d.size, mtime: d.mtime })
      }
    }
    return out
  }

  /** Stat following symlinks. Returns null when the path doesn't exist. */
  async stat(path: string): Promise<SyncStat | null> {
    if (this.v2) {
      await this.sock.write(encodeSyncRequest('STA2', path))
      const buf = await this.sock.read(72)
      const id = buf.toString('ascii', 0, 4)
      if (id !== 'STA2') throw new Error(`Unexpected sync reply ${id}`)
      const error = buf.readUInt32LE(4)
      if (error !== 0) return null
      return { mode: buf.readUInt32LE(24), size: Number(buf.readBigUInt64LE(40)), mtime: Number(buf.readBigInt64LE(56)) }
    }
    await this.sock.write(encodeSyncRequest('STAT', path))
    const buf = await this.sock.read(16)
    const id = buf.toString('ascii', 0, 4)
    if (id !== 'STAT') throw new Error(`Unexpected sync reply ${id}`)
    const mode = buf.readUInt32LE(4)
    if (mode === 0) return null
    return { mode, size: buf.readUInt32LE(8), mtime: buf.readUInt32LE(12) }
  }

  /** Upload a local file. `onBytes` receives the number of new bytes sent. */
  async push(
    localPath: string,
    remotePath: string,
    opts: { mode?: number; mtime?: number; onBytes?: (n: number) => void; signal?: AbortSignal } = {}
  ): Promise<void> {
    const mode = S_IFREG | ((opts.mode ?? 0o644) & 0o777)
    await this.sock.write(encodeSyncRequest('SEND', `${remotePath},${mode}`))
    const stream = createReadStream(localPath, { highWaterMark: SYNC_DATA_MAX })
    try {
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        if (opts.signal?.aborted) throw new SyncCancelledError()
        for (let off = 0; off < chunk.length; off += SYNC_DATA_MAX) {
          const piece = chunk.subarray(off, off + SYNC_DATA_MAX)
          const header = Buffer.alloc(8)
          header.write('DATA', 0, 4, 'ascii')
          header.writeUInt32LE(piece.length, 4)
          await this.sock.writeBuffered(Buffer.concat([header, piece]))
          opts.onBytes?.(piece.length)
        }
      }
    } finally {
      stream.destroy()
    }
    const done = Buffer.alloc(8)
    done.write('DONE', 0, 4, 'ascii')
    done.writeUInt32LE((opts.mtime ?? Math.floor(Date.now() / 1000)) >>> 0, 4)
    await this.sock.write(done)
    const status = await this.sock.read(8)
    const id = status.toString('ascii', 0, 4)
    const len = status.readUInt32LE(4)
    if (id === 'OKAY') return
    if (id === 'FAIL') throw new Error(await this.readFailMessage(len))
    throw new Error(`Unexpected sync reply ${id}`)
  }

  /** Download a remote file to a local path. */
  async pull(
    remotePath: string,
    localPath: string,
    opts: { onBytes?: (n: number) => void; signal?: AbortSignal } = {}
  ): Promise<void> {
    await this.sock.write(encodeSyncRequest('RECV', remotePath))
    const out = createWriteStream(localPath)
    let failure: Error | null = null
    out.on('error', (e) => {
      failure = e
    })
    try {
      for (;;) {
        if (opts.signal?.aborted) throw new SyncCancelledError()
        if (failure) throw failure
        const header = await this.sock.read(8)
        const id = header.toString('ascii', 0, 4)
        const len = header.readUInt32LE(4)
        if (id === 'DONE') break
        if (id === 'FAIL') throw new Error(await this.readFailMessage(len))
        if (id !== 'DATA') throw new Error(`Unexpected sync reply ${id}`)
        const data = await this.sock.read(len)
        if (!out.write(data)) await new Promise<void>((r) => out.once('drain', () => r()))
        opts.onBytes?.(len)
      }
    } finally {
      await new Promise<void>((r) => out.end(() => r()))
    }
    if (failure) throw failure
  }

  async close(): Promise<void> {
    try {
      if (!this.sock.closed) await this.sock.write(encodeSyncRequest('QUIT', Buffer.alloc(0)))
    } catch {
      /* ignore */
    }
    this.sock.close()
  }

  /** Abort immediately (used for cancellation). */
  destroy(): void {
    this.sock.close()
  }
}

/** Run a callback with a short-lived sync session. */
export async function withSync<T>(serial: string, fn: (s: SyncSession) => Promise<T>): Promise<T> {
  const session = await SyncSession.open(serial)
  try {
    return await fn(session)
  } finally {
    await session.close()
  }
}
