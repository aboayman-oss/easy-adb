// Streaming downloads (through Chromium's network stack so system proxies work)
// plus archive extraction with zip-slip protection.
import { net } from 'electron'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, mkdirSync } from 'node:fs'
import { chmod } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import * as tar from 'tar'
import yauzl from 'yauzl'

export interface DownloadProgress {
  received: number
  total: number
}

export async function fetchText(url: string, timeoutMs = 30_000): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await net.fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'EasyADB', Accept: 'application/json, text/plain, */*' }
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

export async function downloadFile(
  url: string,
  dest: string,
  onProgress?: (p: DownloadProgress) => void,
  signal?: AbortSignal
): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true })
  const res = await net.fetch(url, { signal, headers: { 'User-Agent': 'EasyADB' } })
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`)
  const total = Number(res.headers.get('content-length') ?? 0)
  const out = createWriteStream(dest)
  const reader = res.body.getReader()
  let received = 0
  let lastEmit = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()))
      const now = Date.now()
      if (onProgress && now - lastEmit > 100) {
        lastEmit = now
        onProgress({ received, total })
      }
    }
    onProgress?.({ received, total })
  } finally {
    await new Promise<void>((r) => out.end(() => r()))
  }
  if (total && received !== total) throw new Error('The download was interrupted. Please try again.')
}

export async function hashFile(file: string, algorithm: 'sha1' | 'sha256'): Promise<string> {
  const hash = createHash(algorithm)
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

function safeJoin(root: string, entryName: string): string {
  const target = resolve(root, entryName)
  const normalizedRoot = resolve(root) + sep
  if (!target.startsWith(normalizedRoot)) throw new Error(`Blocked unsafe archive entry: ${entryName}`)
  return target
}

/** Extract a zip archive. Returns the list of extracted file paths. */
export function extractZip(
  zipPath: string,
  destDir: string,
  options: { filter?: (entryName: string) => boolean; onEntry?: (name: string) => void } = {}
): Promise<string[]> {
  return new Promise((resolvePromise, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, decodeStrings: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('Could not open archive'))
      const files: string[] = []
      zip.on('error', reject)
      zip.on('end', () => resolvePromise(files))
      zip.on('entry', (entry: yauzl.Entry) => {
        const name = entry.fileName
        if (options.filter && !options.filter(name)) return zip.readEntry()
        let target: string
        try {
          target = safeJoin(destDir, name)
        } catch (e) {
          zip.close()
          return reject(e)
        }
        if (/\/$/.test(name)) {
          mkdirSync(target, { recursive: true })
          return zip.readEntry()
        }
        mkdirSync(dirname(target), { recursive: true })
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) return reject(streamErr ?? new Error('Could not read archive entry'))
          const mode = (entry.externalFileAttributes >>> 16) & 0o777
          pipeline(stream, createWriteStream(target))
            .then(async () => {
              if (process.platform !== 'win32' && mode) await chmod(target, mode).catch(() => undefined)
              files.push(target)
              options.onEntry?.(name)
              zip.readEntry()
            })
            .catch(reject)
        })
      })
      zip.readEntry()
    })
  })
}

/** List entries of a zip without extracting. */
export function listZip(zipPath: string): Promise<{ name: string; size: number }[]> {
  return new Promise((resolvePromise, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, decodeStrings: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('Could not open archive'))
      const entries: { name: string; size: number }[] = []
      zip.on('error', reject)
      zip.on('end', () => resolvePromise(entries))
      zip.on('entry', (entry: yauzl.Entry) => {
        entries.push({ name: entry.fileName, size: entry.uncompressedSize })
        zip.readEntry()
      })
      zip.readEntry()
    })
  })
}

/** Read one small entry of a zip into memory (e.g. manifest.json). */
export function readZipEntry(zipPath: string, entryName: string, maxBytes = 4 * 1024 * 1024): Promise<Buffer | null> {
  return new Promise((resolvePromise, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, decodeStrings: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('Could not open archive'))
      let found = false
      zip.on('error', reject)
      zip.on('end', () => {
        if (!found) resolvePromise(null)
      })
      zip.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName !== entryName) return zip.readEntry()
        found = true
        if (entry.uncompressedSize > maxBytes) {
          zip.close()
          return resolvePromise(null)
        }
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return reject(e)
          const chunks: Buffer[] = []
          stream.on('data', (c: Buffer) => chunks.push(c))
          stream.on('end', () => {
            zip.close()
            resolvePromise(Buffer.concat(chunks))
          })
          stream.on('error', reject)
        })
      })
      zip.readEntry()
    })
  })
}

export async function extractTarGz(file: string, destDir: string): Promise<void> {
  mkdirSync(destDir, { recursive: true })
  await tar.x({ file, cwd: destDir, strict: true, preservePaths: false })
}

export function joinPath(...parts: string[]): string {
  return join(...parts)
}
