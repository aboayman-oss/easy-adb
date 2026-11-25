import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AdbSocket, encodeHostRequest } from '../src/main/adb/host'
import { decodeDentV1, encodeSyncRequest, isDirMode, SyncSession, S_IFDIR, S_IFREG } from '../src/main/adb/sync'

/** A tiny fake adb server that implements host:transport + the v1 sync protocol in memory. */
function fakeAdbServer(files: Map<string, Buffer>): Server {
  return createServer((sock: Socket) => {
    let buf = Buffer.alloc(0)
    let mode: 'host' | 'sync' = 'host'
    let sending: { path: string; chunks: Buffer[] } | null = null

    const reply = (id: string, payload: Buffer = Buffer.alloc(0)): void => {
      sock.write(Buffer.concat([Buffer.from(id, 'ascii'), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(payload.length); return b })(), payload]))
    }

    const handle = (): void => {
      for (;;) {
        if (mode === 'host') {
          if (buf.length < 4) return
          const len = parseInt(buf.subarray(0, 4).toString('ascii'), 16)
          if (buf.length < 4 + len) return
          const req = buf.subarray(4, 4 + len).toString('utf8')
          buf = buf.subarray(4 + len)
          if (req.endsWith(':features')) {
            const body = 'shell_v2,cmd'
            sock.end(`OKAY${body.length.toString(16).padStart(4, '0')}${body}`)
            return
          }
          if (req.startsWith('host:transport:')) sock.write('OKAY')
          else if (req === 'sync:') {
            sock.write('OKAY')
            mode = 'sync'
          } else {
            const msg = 'unknown host service'
            sock.end(`FAIL${msg.length.toString(16).padStart(4, '0')}${msg}`)
            return
          }
          continue
        }
        if (buf.length < 8) return
        const id = buf.subarray(0, 4).toString('ascii')
        const len = buf.readUInt32LE(4)
        const hasPayload = id !== 'DONE' && id !== 'QUIT'
        if (hasPayload && buf.length < 8 + len) return
        const payload = hasPayload ? buf.subarray(8, 8 + len) : Buffer.alloc(0)
        buf = buf.subarray(hasPayload ? 8 + len : 8)
        const text = payload.toString('utf8')

        if (id === 'STAT') {
          const out = Buffer.alloc(16)
          out.write('STAT', 0, 'ascii')
          const f = files.get(text)
          const isDir = [...files.keys()].some((k) => k.startsWith(text.replace(/\/$/, '') + '/'))
          if (f) {
            out.writeUInt32LE(S_IFREG | 0o644, 4)
            out.writeUInt32LE(f.length, 8)
            out.writeUInt32LE(1_700_000_000, 12)
          } else if (isDir) {
            out.writeUInt32LE(S_IFDIR | 0o755, 4)
          }
          sock.write(out)
        } else if (id === 'LIST') {
          const dir = text.replace(/\/$/, '')
          for (const [path, data] of files) {
            if (!path.startsWith(dir + '/') || path.slice(dir.length + 1).includes('/')) continue
            const name = Buffer.from(path.slice(dir.length + 1), 'utf8')
            const h = Buffer.alloc(20)
            h.write('DENT', 0, 'ascii')
            h.writeUInt32LE(S_IFREG | 0o644, 4)
            h.writeUInt32LE(data.length, 8)
            h.writeUInt32LE(1_700_000_000, 12)
            h.writeUInt32LE(name.length, 16)
            sock.write(Buffer.concat([h, name]))
          }
          const done = Buffer.alloc(20)
          done.write('DONE', 0, 'ascii')
          sock.write(done)
        } else if (id === 'SEND') {
          sending = { path: text.slice(0, text.lastIndexOf(',')), chunks: [] }
        } else if (id === 'DATA' && sending) {
          expect(payload.length).toBeLessThanOrEqual(64 * 1024)
          sending.chunks.push(Buffer.from(payload))
        } else if (id === 'DONE' && sending) {
          files.set(sending.path, Buffer.concat(sending.chunks))
          sending = null
          reply('OKAY')
        } else if (id === 'RECV') {
          const f = files.get(text)
          if (!f) reply('FAIL', Buffer.from('No such file or directory'))
          else {
            for (let off = 0; off < f.length; off += 64 * 1024) reply('DATA', f.subarray(off, off + 64 * 1024))
            reply('DONE')
          }
        } else if (id === 'QUIT') {
          sock.end()
          return
        }
      }
    }

    sock.on('data', (c: Buffer) => {
      buf = Buffer.concat([buf, c])
      handle()
    })
    sock.on('error', () => undefined)
  })
}

describe('sync protocol framing', () => {
  it('encodes host requests with a hex length prefix', () => {
    expect(encodeHostRequest('host:version').toString()).toBe('000chost:version')
    expect(encodeHostRequest('host:transport:عربي').subarray(0, 4).toString()).toBe((15 + Buffer.byteLength('عربي')).toString(16).padStart(4, '0'))
  })

  it('encodes sync requests as id + little-endian length + payload', () => {
    const b = encodeSyncRequest('STAT', '/sdcard/صورة.jpg')
    expect(b.subarray(0, 4).toString()).toBe('STAT')
    expect(b.readUInt32LE(4)).toBe(Buffer.byteLength('/sdcard/صورة.jpg'))
    expect(b.subarray(8).toString('utf8')).toBe('/sdcard/صورة.jpg')
  })

  it('decodes v1 directory entries', () => {
    const h = Buffer.alloc(20)
    h.write('DENT', 0, 'ascii')
    h.writeUInt32LE(S_IFDIR | 0o771, 4)
    h.writeUInt32LE(4096, 8)
    h.writeUInt32LE(123, 12)
    h.writeUInt32LE(4, 16)
    const d = decodeDentV1(h)
    expect(d).toEqual({ id: 'DENT', mode: S_IFDIR | 0o771, size: 4096, mtime: 123, namelen: 4 })
    expect(isDirMode(d.mode)).toBe(true)
  })
})

describe('AdbSocket streaming', () => {
  it('delivers a payload that arrived in the same packet as OKAY', async () => {
    const body = 'R5CX1234ABC\tdevice\n'
    const server = createServer((sock) => {
      sock.once('data', () => sock.write(`OKAY${body.length.toString(16).padStart(4, '0')}${body}`))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    const sock = await AdbSocket.open(port)
    await sock.request('host:track-devices-l')
    const received = await new Promise<string>((resolve) => {
      // Give the trailing payload time to land in the internal buffer first.
      setTimeout(() => sock.stream((c) => resolve(c.toString())), 50)
    })
    expect(received).toBe(`${body.length.toString(16).padStart(4, '0')}${body}`)
    sock.close()
    await new Promise<void>((r) => server.close(() => r()))
  })
})

describe('SyncSession against a fake adb server', () => {
  const files = new Map<string, Buffer>()
  let server: Server
  let dir: string
  const prevPort = process.env.ANDROID_ADB_SERVER_PORT

  beforeAll(async () => {
    server = fakeAdbServer(files)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const addr = server.address()
    process.env.ANDROID_ADB_SERVER_PORT = String(typeof addr === 'object' && addr ? addr.port : 0)
    dir = mkdtempSync(join(tmpdir(), 'easyadb-sync-'))
  })

  afterAll(async () => {
    process.env.ANDROID_ADB_SERVER_PORT = prevPort
    rmSync(dir, { recursive: true, force: true })
    await new Promise<void>((r) => server.close(() => r()))
  })

  it('pushes, lists, stats and pulls a multi-chunk file with a Unicode name', async () => {
    const content = randomBytes(300 * 1024 + 17)
    const local = join(dir, 'upload.bin')
    writeFileSync(local, content)
    const remote = '/sdcard/Download/ملف تجريبي 😀.bin'

    const session = await SyncSession.open('fake-serial-1')
    let pushed = 0
    await session.push(local, remote, { onBytes: (n) => (pushed += n) })
    expect(pushed).toBe(content.length)
    expect(files.get(remote)?.equals(content)).toBe(true)

    const listing = await session.list('/sdcard/Download/')
    expect(listing).toEqual([{ name: 'ملف تجريبي 😀.bin', mode: S_IFREG | 0o644, size: content.length, mtime: 1_700_000_000 }])

    expect(await session.stat(remote)).toMatchObject({ size: content.length })
    expect(await session.stat('/sdcard/missing.txt')).toBeNull()

    const back = join(dir, 'download.bin')
    let pulled = 0
    await session.pull(remote, back, { onBytes: (n) => (pulled += n) })
    expect(pulled).toBe(content.length)
    expect(readFileSync(back).equals(content)).toBe(true)
    await session.close()
  })

  it('reports device-side failures', async () => {
    const session = await SyncSession.open('fake-serial-2')
    await expect(session.pull('/sdcard/nope.txt', join(dir, 'nope.txt'))).rejects.toThrow(/No such file/)
    session.destroy()
  })

  it('cancels a push when the signal aborts', async () => {
    const local = join(dir, 'big.bin')
    writeFileSync(local, randomBytes(2 * 1024 * 1024))
    const session = await SyncSession.open('fake-serial-3')
    const controller = new AbortController()
    let sent = 0
    const p = session.push(local, '/sdcard/big.bin', {
      signal: controller.signal,
      onBytes: (n) => {
        sent += n
        if (sent > 256 * 1024) controller.abort()
      }
    })
    await expect(p).rejects.toThrow(/Cancelled/)
    session.destroy()
    expect(files.has('/sdcard/big.bin')).toBe(false)
  })
})
