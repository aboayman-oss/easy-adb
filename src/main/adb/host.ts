// Minimal client for the adb server's "smart socket" protocol on localhost:5037.
import { connect, type Socket } from 'node:net'

export function serverPort(): number {
  const env = Number(process.env.ANDROID_ADB_SERVER_PORT)
  return Number.isInteger(env) && env > 0 ? env : 5037
}

export function encodeHostRequest(request: string): Buffer {
  const body = Buffer.from(request, 'utf8')
  const len = body.length.toString(16).padStart(4, '0')
  return Buffer.concat([Buffer.from(len, 'ascii'), body])
}

/** A socket with an internal buffer that supports "read exactly N bytes". */
export class AdbSocket {
  private chunks: Buffer[] = []
  private buffered = 0
  private waiter: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | null = null
  private ended = false
  private error: Error | null = null
  onData?: (chunk: Buffer) => void

  private constructor(private readonly socket: Socket) {
    socket.setNoDelay(true)
    socket.on('data', (chunk: Buffer) => {
      if (this.onData) {
        this.onData(chunk)
        return
      }
      this.chunks.push(chunk)
      this.buffered += chunk.length
      this.flush()
    })
    socket.on('end', () => {
      this.ended = true
      this.flush()
    })
    socket.on('close', () => {
      this.ended = true
      this.flush()
    })
    socket.on('error', (e) => {
      this.error = e
      this.flush()
    })
  }

  static open(port = serverPort(), timeoutMs = 5000): Promise<AdbSocket> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port })
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error('Timed out connecting to the adb server'))
      }, timeoutMs)
      socket.once('connect', () => {
        clearTimeout(timer)
        resolve(new AdbSocket(socket))
      })
      socket.once('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
    })
  }

  private take(n: number): Buffer {
    const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks)
    const out = all.subarray(0, n)
    const rest = all.subarray(n)
    this.chunks = rest.length ? [rest] : []
    this.buffered = rest.length
    return out
  }

  private flush(): void {
    if (!this.waiter) return
    const { n, resolve, reject } = this.waiter
    if (this.buffered >= n) {
      this.waiter = null
      resolve(this.take(n))
    } else if (this.error) {
      this.waiter = null
      reject(this.error)
    } else if (this.ended) {
      this.waiter = null
      reject(new Error('Connection to the phone closed unexpectedly'))
    }
  }

  read(n: number): Promise<Buffer> {
    if (n === 0) return Promise.resolve(Buffer.alloc(0))
    if (this.waiter) return Promise.reject(new Error('Concurrent read on AdbSocket'))
    return new Promise((resolve, reject) => {
      this.waiter = { n, resolve, reject }
      this.flush()
    })
  }

  /** Read everything until the server closes the connection. */
  readAll(): Promise<Buffer> {
    if (this.ended || this.error) return Promise.resolve(this.take(this.buffered))
    return new Promise((resolve) => {
      this.socket.once('close', () => resolve(this.take(this.buffered)))
    })
  }

  write(data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.error) return reject(this.error)
      this.socket.write(data, (err) => (err ? reject(err) : resolve()))
    })
  }

  /** Write without waiting for the flush callback; only pauses when the socket asks for it. */
  async writeBuffered(data: Buffer): Promise<void> {
    if (this.error) throw this.error
    if (this.ended) throw new Error('Connection to the phone closed unexpectedly')
    if (!this.socket.write(data)) {
      await new Promise<void>((resolve, reject) => {
        const onDrain = (): void => {
          cleanup()
          resolve()
        }
        const onClose = (): void => {
          cleanup()
          reject(this.error ?? new Error('Connection to the phone closed unexpectedly'))
        }
        const cleanup = (): void => {
          this.socket.off('drain', onDrain)
          this.socket.off('close', onClose)
        }
        this.socket.once('drain', onDrain)
        this.socket.once('close', onClose)
      })
    }
  }

  async readStatus(): Promise<void> {
    const status = (await this.read(4)).toString('ascii')
    if (status === 'OKAY') return
    if (status === 'FAIL') {
      const len = parseInt((await this.read(4)).toString('ascii'), 16)
      const msg = (await this.read(len)).toString('utf8')
      throw new Error(msg || 'adb server refused the request')
    }
    throw new Error(`Unexpected adb server reply: ${status}`)
  }

  async readLengthPrefixed(): Promise<string> {
    const len = parseInt((await this.read(4)).toString('ascii'), 16)
    return (await this.read(len)).toString('utf8')
  }

  /** Send a host request and wait for OKAY. */
  async request(req: string): Promise<void> {
    await this.write(encodeHostRequest(req))
    await this.readStatus()
  }

  close(): void {
    this.socket.destroy()
  }

  onClose(cb: () => void): void {
    this.socket.once('close', cb)
  }

  /**
   * Switch to streaming mode: hand every future chunk to `cb`, starting with any bytes
   * already buffered (the server often sends OKAY and the first payload in one packet).
   */
  stream(cb: (chunk: Buffer) => void): void {
    this.onData = cb
    if (this.buffered > 0) cb(this.take(this.buffered))
  }

  get closed(): boolean {
    return this.ended || this.error !== null
  }
}

/** Run a host query that returns a length-prefixed string (e.g. host:version). */
export async function hostQuery(request: string): Promise<string> {
  const sock = await AdbSocket.open()
  try {
    await sock.request(request)
    return await sock.readLengthPrefixed()
  } finally {
    sock.close()
  }
}

export async function isServerRunning(): Promise<boolean> {
  try {
    const sock = await AdbSocket.open(serverPort(), 1500)
    sock.close()
    return true
  } catch {
    return false
  }
}

/** Open a socket already switched to the given device's transport. */
export async function openTransport(serial: string): Promise<AdbSocket> {
  const sock = await AdbSocket.open()
  try {
    await sock.request(`host:transport:${serial}`)
    return sock
  } catch (e) {
    sock.close()
    throw e
  }
}

const featureCache = new Map<string, Set<string>>()

export async function deviceFeatures(serial: string): Promise<Set<string>> {
  const cached = featureCache.get(serial)
  if (cached) return cached
  try {
    const text = await hostQuery(`host-serial:${serial}:features`)
    const set = new Set(text.split(',').map((s) => s.trim()).filter(Boolean))
    featureCache.set(serial, set)
    return set
  } catch {
    return new Set()
  }
}

export function forgetFeatures(serial: string): void {
  featureCache.delete(serial)
}
