// Resolves real app names and icons by reading only the needed byte ranges of an
// APK on the device (zip central directory, manifest, resource table and the icon).
// Vector and adaptive icons are converted to SVG.
import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppMeta } from '@shared/types'
import {
  ATTR_DRAWABLE,
  childElements,
  extractLocalEntry,
  findAttr,
  findCentralDirectory,
  parseBinaryXml,
  parseCentralDirectory,
  parseZip64Eocd,
  ResourceTable,
  summarizeManifest,
  TYPE_INT_COLOR_ARGB8,
  TYPE_INT_COLOR_RGB4,
  TYPE_REFERENCE,
  TYPE_STRING,
  type TypedValue,
  type XmlElement,
  type ZipEntryInfo
} from '../lib/apk'
import { shellCommand, shellQuote } from '../lib/paths'
import { argbToRgba, composeAdaptiveIcon, numberValue, svgDataUrl, vectorToSvg, type Layer, type Rgba } from '../lib/vector'
import { adbBinary, shell } from './runner'
import { withSync } from './sync'

const BLOCK = 4096
const TAIL = 65_557 + 1024
const MAX_ARSC = 24 * 1024 * 1024
/** Icons bigger than this (e.g. huge preview art) are skipped in favour of a smaller variant. */
const MAX_ICON = 200 * 1024
const CACHE_VERSION = 'v6'

interface CacheRecord {
  label?: string
  icon?: string
}

function cacheDir(): string {
  const dir = join(app.getPath('userData'), 'app-meta-cache')
  mkdirSync(dir, { recursive: true })
  return dir
}

function cacheFile(pkg: string, version: number | undefined, cacheVersion = CACHE_VERSION): string {
  return join(cacheDir(), `${pkg}@${version ?? 0}.${cacheVersion}.json`)
}

/** Older entries that found an icon are still valid; ones without may predate newer icon support. */
function legacyRecord(pkg: string, version: number | undefined): CacheRecord | null {
  for (const v of ['v5', 'v4', 'v3', 'v2']) {
    const file = cacheFile(pkg, version, v)
    if (!existsSync(file)) continue
    try {
      const rec = JSON.parse(readFileSync(file, 'utf8')) as CacheRecord
      // Reuse only icons within today's size limit (base64 adds a third).
      if (rec.icon && rec.icon.length < (MAX_ICON * 4) / 3 + 64) return rec
    } catch {
      /* ignore */
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Byte-range reads with as few adb round-trips as possible

interface Range {
  offset: number
  length: number
}

function ddPlan(fileSize: number, r: Range): { skip: number; count: number; expected: number; start: number; end: number } {
  const end = Math.min(fileSize, r.offset + r.length)
  const skip = Math.floor(r.offset / BLOCK)
  const count = Math.max(1, Math.ceil(end / BLOCK) - skip)
  const expected = Math.max(0, Math.min(fileSize, (skip + count) * BLOCK) - skip * BLOCK)
  return { skip, count, expected, start: r.offset - skip * BLOCK, end }
}

/** Read several ranges in a single `adb exec-out` call (dd commands back-to-back). */
async function readRanges(serial: string, path: string, fileSize: number, ranges: Range[]): Promise<Buffer[]> {
  const plans = ranges.map((r) => ddPlan(fileSize, r))
  const cmd = plans.map((p) => `dd if=${shellQuote(path)} bs=${BLOCK} skip=${p.skip} count=${p.count} 2>/dev/null`).join('; ')
  const out = await adbBinary(['exec-out', cmd], { serial, log: false, timeoutMs: 90_000 })
  const total = plans.reduce((s, p) => s + p.expected, 0)
  if (out.length !== total) {
    if (ranges.length === 1) throw new Error('Short read from device')
    // Something didn't line up — fall back to one call per range.
    const results: Buffer[] = []
    for (const r of ranges) results.push((await readRanges(serial, path, fileSize, [r]))[0])
    return results
  }
  const results: Buffer[] = []
  let off = 0
  for (let i = 0; i < plans.length; i++) {
    const chunk = out.subarray(off, off + plans[i].expected)
    off += plans[i].expected
    results.push(chunk.subarray(plans[i].start, plans[i].start + (plans[i].end - ranges[i].offset)))
  }
  return results
}

/** File size + last bytes of the file in one round-trip. */
async function readHead(serial: string, path: string): Promise<{ size: number; tail: Buffer }> {
  const q = shellQuote(path)
  const out = await adbBinary(['exec-out', `stat -c %s ${q} && tail -c ${TAIL} ${q} 2>/dev/null`], { serial, log: false, timeoutMs: 60_000 })
  const nl = out.indexOf(0x0a)
  const size = nl > 0 ? Number(out.subarray(0, nl).toString('ascii').trim()) : NaN
  const tail = nl > 0 ? out.subarray(nl + 1) : Buffer.alloc(0)
  if (Number.isFinite(size) && size > 0 && tail.length === Math.min(size, TAIL)) return { size, tail }
  // Fallback: sync STAT + dd.
  const stat = await withSync(serial, (s) => s.stat(path))
  if (!stat || stat.size === 0) throw new Error('Missing APK')
  const len = Math.min(stat.size, TAIL)
  const [t] = await readRanges(serial, path, stat.size, [{ offset: stat.size - len, length: len }])
  return { size: stat.size, tail: t }
}

class RemoteApk {
  private entries = new Map<string, ZipEntryInfo>()
  private constructor(
    private readonly serial: string,
    private readonly path: string,
    private readonly size: number
  ) {}

  static async open(serial: string, path: string): Promise<RemoteApk> {
    const { size, tail } = await readHead(serial, path)
    const apk = new RemoteApk(serial, path, size)
    const tailOffset = size - tail.length
    let loc = findCentralDirectory(tail, tailOffset)
    if (loc && 'needZip64At' in loc) loc = parseZip64Eocd((await readRanges(serial, path, size, [{ offset: loc.needZip64At, length: 56 }]))[0])
    if (!loc || 'needZip64At' in loc) throw new Error('Not a zip')
    const rel = loc.cdOffset - tailOffset
    const cd =
      rel >= 0 && rel + loc.cdSize <= tail.length
        ? tail.subarray(rel, rel + loc.cdSize)
        : (await readRanges(serial, path, size, [{ offset: loc.cdOffset, length: loc.cdSize }]))[0]
    apk.entries = new Map(parseCentralDirectory(cd).map((e) => [e.name, e]))
    return apk
  }

  has(name: string): boolean {
    return this.entries.has(name)
  }

  /** Read several entries in one round-trip (missing/oversized entries come back null). */
  async readMany(names: string[], maxSize: number): Promise<(Buffer | null)[]> {
    const wanted = names.map((n) => {
      const e = this.entries.get(n)
      return e && e.uncompressedSize <= maxSize ? e : null
    })
    const ranges = wanted.filter((e): e is ZipEntryInfo => !!e).map((e) => ({ offset: e.localHeaderOffset, length: 30 + Buffer.byteLength(e.name) + 256 + e.compressedSize }))
    if (!ranges.length) return names.map(() => null)
    const bufs = await readRanges(this.serial, this.path, this.size, ranges)
    const out: (Buffer | null)[] = []
    let i = 0
    for (const e of wanted) {
      if (!e) {
        out.push(null)
        continue
      }
      let res = extractLocalEntry(bufs[i++], e)
      if (!Buffer.isBuffer(res)) {
        const [again] = await readRanges(this.serial, this.path, this.size, [{ offset: e.localHeaderOffset, length: res.needBytes }])
        res = extractLocalEntry(again, e)
      }
      out.push(Buffer.isBuffer(res) ? res : null)
    }
    return out
  }

  async read(name: string, maxSize: number): Promise<Buffer | null> {
    return (await this.readMany([name], maxSize))[0]
  }
}

export interface EntryReader {
  read(name: string, maxSize: number): Promise<Buffer | null>
}

/**
 * The base APK plus its split APKs. Apps installed from Play as bundles keep their
 * density-specific launcher icons in a split such as split_config.xxhdpi.apk.
 */
class ApkSet implements EntryReader {
  private splitPaths: string[] | null = null
  private readonly opened = new Map<string, RemoteApk | null>()
  constructor(
    private readonly serial: string,
    private readonly pkg: string,
    private readonly base: RemoteApk,
    private readonly basePath: string
  ) {}

  private async paths(): Promise<string[]> {
    if (this.splitPaths) return this.splitPaths
    const out = await shell(this.serial, shellCommand('pm', 'path', this.pkg), { timeoutMs: 15_000 }).catch(() => '')
    this.splitPaths = out
      .split(/\r?\n/)
      .map((l) => l.trim().replace(/^package:/, ''))
      .filter((p) => p.startsWith('/') && p !== this.basePath)
      .sort((a, b) => Number(/dpi/.test(b)) - Number(/dpi/.test(a)))
    return this.splitPaths
  }

  private async open(path: string): Promise<RemoteApk | null> {
    if (!this.opened.has(path)) this.opened.set(path, await RemoteApk.open(this.serial, path).catch(() => null))
    return this.opened.get(path) ?? null
  }

  async read(name: string, maxSize: number): Promise<Buffer | null> {
    if (this.base.has(name)) return this.base.read(name, maxSize)
    for (const path of await this.paths()) {
      const apk = await this.open(path)
      if (apk?.has(name)) return apk.read(name, maxSize)
    }
    return null
  }

  /** Resource tables of config splits (density splits carry their own resources.arsc). */
  async splitTables(): Promise<ResourceTable[]> {
    const tables: ResourceTable[] = []
    for (const path of (await this.paths()).filter((p) => /dpi/.test(p))) {
      const apk = await this.open(path)
      const arsc = apk?.has('resources.arsc') ? await apk.read('resources.arsc', MAX_ARSC) : null
      if (arsc) {
        try {
          tables.push(new ResourceTable(arsc))
        } catch {
          /* ignore malformed split tables */
        }
      }
    }
    return tables
  }
}

/** The lookups icon rendering needs; implemented by one table or a base table plus split tables. */
export interface ResourceLookup {
  string(index: number): string | undefined
  resolveString(value: TypedValue | undefined): string | undefined
  resolveFiles(value: TypedValue | undefined): string[]
  resolveArgb(value: TypedValue | undefined): number | undefined
}

/** Base table first, then split tables (same resource ids, extra configurations). */
export class ResourceTables implements ResourceLookup {
  constructor(private readonly tables: ResourceTable[]) {}
  string(index: number): string | undefined {
    return this.tables[0]?.string(index)
  }
  resolveString(value: TypedValue | undefined): string | undefined {
    for (const t of this.tables) {
      const s = t.resolveString(value)
      if (s) return s
    }
    return undefined
  }
  resolveFiles(value: TypedValue | undefined): string[] {
    return [...new Set(this.tables.flatMap((t) => t.resolveFiles(value)))]
  }
  resolveArgb(value: TypedValue | undefined): number | undefined {
    for (const t of this.tables) {
      const c = t.resolveArgb(value)
      if (c !== undefined) return c
    }
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Icon rendering

function mimeFor(path: string): string | null {
  if (/\.png$/i.test(path)) return 'image/png'
  if (/\.webp$/i.test(path)) return 'image/webp'
  if (/\.jpe?g$/i.test(path)) return 'image/jpeg'
  return null
}

const isColorType = (v: TypedValue): boolean => v.type >= TYPE_INT_COLOR_ARGB8 && v.type <= TYPE_INT_COLOR_RGB4

export class IconRenderer {
  private xmlCache = new Map<string, XmlElement[] | null>()
  constructor(
    private readonly apk: EntryReader,
    private readonly table: ResourceLookup
  ) {}

  private async xml(file: string): Promise<XmlElement[] | null> {
    if (this.xmlCache.has(file)) return this.xmlCache.get(file)!
    let els: XmlElement[] | null = null
    try {
      const buf = await this.apk.read(file, 512 * 1024)
      els = buf ? parseBinaryXml(buf) : null
    } catch {
      els = null
    }
    this.xmlCache.set(file, els)
    return els
  }

  /** First solid color found in a color-state-list / gradient / shape file. */
  private async colorFromFile(file: string): Promise<number | undefined> {
    const els = await this.xml(file)
    for (const el of els ?? []) {
      for (const a of el.attributes) {
        if (isColorType(a.value)) return this.table.resolveArgb(a.value)
        if (a.value.type === TYPE_REFERENCE && /color/i.test(a.name)) {
          const c = this.table.resolveArgb(a.value)
          if (c !== undefined) return c
        }
      }
    }
    return undefined
  }

  private async vectorLayer(els: XmlElement[]): Promise<Layer | null> {
    // Pre-resolve colors that live in separate XML files (color state lists, gradients).
    const fileColors = new Map<number, number>()
    for (const el of els) {
      for (const a of el.attributes) {
        if (a.value.type !== TYPE_REFERENCE || !/color/i.test(a.name)) continue
        if (this.table.resolveArgb(a.value) !== undefined || fileColors.has(a.value.data)) continue
        const file = this.table.resolveFiles(a.value).find((f) => f.endsWith('.xml'))
        const c = file ? await this.colorFromFile(file) : undefined
        if (c !== undefined) fileColors.set(a.value.data, c)
      }
    }
    const color = (v: TypedValue): Rgba | undefined => {
      const argb = this.table.resolveArgb(v) ?? (v.type === TYPE_REFERENCE ? fileColors.get(v.data) : undefined)
      return argb === undefined ? undefined : argbToRgba(argb)
    }
    const string = (v: TypedValue): string | undefined => (v.type === TYPE_STRING ? (v.raw ?? this.table.string(v.data)) : this.table.resolveString(v))
    const res = vectorToSvg(els, { color, string })
    return res ? { kind: 'svg', svg: res.svg } : null
  }

  /** Render a drawable file to a layer (bitmap, vector, nested bitmap/inset/layer-list). */
  async fileLayer(file: string, depth = 0): Promise<{ layer: Layer; inset: number } | null> {
    if (depth > 4) return null
    const mime = mimeFor(file)
    if (mime) {
      const data = await this.apk.read(file, MAX_ICON)
      return data && data.length ? { layer: { kind: 'image', dataUrl: `data:${mime};base64,${data.toString('base64')}` }, inset: 0 } : null
    }
    if (!file.endsWith('.xml')) return null
    const els = await this.xml(file)
    if (!els?.length) return null
    const root = els[0]
    if (root.name === 'vector') {
      const layer = await this.vectorLayer(els)
      return layer ? { layer, inset: 0 } : null
    }
    if (root.name === 'inset') {
      const inner = await this.refLayer(findAttr(root, ATTR_DRAWABLE, 'drawable'), depth + 1)
      if (!inner) return null
      const v = findAttr(root, 0x010104b5, 'inset')
      const n = numberValue(v)
      const inset = n === undefined ? 0 : v?.type === 0x06 ? (n / 100) * 108 : n
      return { layer: inner.layer, inset: inner.inset + inset }
    }
    if (root.name === 'bitmap' || root.name === 'nine-patch') {
      return this.refLayer(findAttr(root, 0x01010119, 'src'), depth + 1)
    }
    if (root.name === 'layer-list') {
      for (const item of els.filter((e) => e.name === 'item').reverse()) {
        const l = await this.refLayer(findAttr(item, ATTR_DRAWABLE, 'drawable'), depth + 1)
        if (l) return l
      }
      return null
    }
    if (root.name === 'shape') {
      const solid = els.find((e) => e.name === 'solid')
      const c = solid ? this.table.resolveArgb(findAttr(solid, 0x010101a5, 'color')) : undefined
      return c !== undefined ? { layer: { kind: 'color', color: argbToRgba(c) }, inset: 0 } : null
    }
    return null
  }

  /** Resolve an attribute value (color literal or drawable reference) to a layer. */
  async refLayer(v: TypedValue | undefined, depth = 0): Promise<{ layer: Layer; inset: number } | null> {
    if (!v) return null
    const argb = this.table.resolveArgb(v)
    if (argb !== undefined) return { layer: { kind: 'color', color: argbToRgba(argb) }, inset: 0 }
    for (const file of this.table.resolveFiles(v).slice(0, 3)) {
      const l = await this.fileLayer(file, depth)
      if (l) return l
    }
    return null
  }

  /** An adaptive-icon layer: either a `drawable` attribute or an inline child (<bitmap>, <inset>, …). */
  private async adaptiveLayer(els: XmlElement[], name: 'background' | 'foreground'): Promise<{ layer: Layer; inset: number } | null> {
    const index = els.findIndex((e) => e.name === name)
    if (index < 0) return null
    const direct = findAttr(els[index], ATTR_DRAWABLE, 'drawable')
    if (direct) return this.refLayer(direct)
    const child = childElements(els, index)[0]
    if (!child) return null
    if (child.name === 'bitmap' || child.name === 'nine-patch') return this.refLayer(findAttr(child, 0x01010119, 'src'))
    if (child.name === 'color') return this.refLayer(findAttr(child, 0x010101a5, 'color'))
    if (child.name === 'inset') {
      const inner = await this.refLayer(findAttr(child, ATTR_DRAWABLE, 'drawable'))
      const v = findAttr(child, 0x010104b5, 'inset')
      const n = numberValue(v)
      const inset = n === undefined ? 0 : v?.type === 0x06 ? (n / 100) * 108 : n
      return inner ? { layer: inner.layer, inset: inner.inset + inset } : null
    }
    return null
  }

  async icon(files: string[]): Promise<string | undefined> {
    for (const file of files.slice(0, 4)) {
      if (mimeFor(file)) {
        const l = await this.fileLayer(file)
        if (l?.layer.kind === 'image') return l.layer.dataUrl
        continue
      }
      const els = await this.xml(file)
      if (!els?.length) continue
      if (els[0].name === 'adaptive-icon') {
        const bg = await this.adaptiveLayer(els, 'background')
        const fg = await this.adaptiveLayer(els, 'foreground')
        if (!bg && !fg) continue
        return svgDataUrl(composeAdaptiveIcon(bg?.layer ?? null, fg?.layer ?? null, fg?.inset ?? 0))
      }
      const l = await this.fileLayer(file)
      if (!l) continue
      if (l.layer.kind === 'image') return l.layer.dataUrl
      if (l.layer.kind === 'svg') return svgDataUrl(l.layer.svg)
    }
    return undefined
  }
}

// ---------------------------------------------------------------------------

/** Resolve label + icon for one package (no caching). */
async function resolveMeta(serial: string, pkg: string, apkPath: string): Promise<CacheRecord> {
  const apk = await RemoteApk.open(serial, apkPath)
  // Manifest and resource table in one round-trip.
  const [manifestXml, arsc] = await apk.readMany(['AndroidManifest.xml', 'resources.arsc'], MAX_ARSC)
  if (!manifestXml) return {}
  const manifest = summarizeManifest(manifestXml)
  if (!arsc) return { label: manifest.label?.raw }
  const table = new ResourceTable(arsc)
  const label = table.resolveString(manifest.label)?.trim()
  let icon: string | undefined
  try {
    // App icon → round icon → launcher activity icon → a resource named like a launcher icon
    // (Samsung "icon container" apps declare no icon at all).
    const named = table.findByName(['mipmap', 'drawable'], ['ic_launcher', 'app_icon', 'ic_launcher_round', 'launcher_icon', 'icon'])
    const candidates = (lookup: ResourceLookup): string[] => [
      ...new Set([
        ...lookup.resolveFiles(manifest.icon),
        ...lookup.resolveFiles(manifest.roundIcon),
        ...lookup.resolveFiles(manifest.launcherIcon),
        ...(named !== undefined ? lookup.resolveFiles({ type: TYPE_REFERENCE, data: named }) : [])
      ])
    ]
    const files = new ApkSet(serial, pkg, apk, apkPath)
    icon = await new IconRenderer(files, table).icon(candidates(table))
    if (!icon) {
      // Bundle installs keep density-specific resource entries in the split's own table.
      const splits = await files.splitTables()
      if (splits.length) {
        const all = new ResourceTables([table, ...splits])
        icon = await new IconRenderer(files, all).icon(candidates(all))
      }
    }
  } catch {
    /* icon is optional */
  }
  return { label: label || undefined, icon }
}

const inflight = new Map<string, Promise<AppMeta>>()

/** Global cap on concurrent APK reads, whatever asks for them (protects slow Wi-Fi links). */
const MAX_CONCURRENT_READS = 6
let activeReads = 0
const readQueue: (() => void)[] = []

async function withReadSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeReads >= MAX_CONCURRENT_READS) await new Promise<void>((resolve) => readQueue.push(resolve))
  activeReads++
  try {
    return await fn()
  } finally {
    activeReads--
    readQueue.shift()?.()
  }
}

export function getAppMeta(serial: string, pkg: string, apkPath: string | undefined, versionCode: number | undefined): Promise<AppMeta> {
  const key = `${serial}|${pkg}|${versionCode ?? 0}`
  const existing = inflight.get(key)
  if (existing) return existing
  const task = (async (): Promise<AppMeta> => {
    const file = cacheFile(pkg, versionCode)
    const legacy = !existsSync(file) ? legacyRecord(pkg, versionCode) : null
    if (legacy) {
      try {
        writeFileSync(file, JSON.stringify(legacy))
        rememberLabel(pkg, versionCode, legacy.label)
      } catch {
        /* best effort */
      }
      return { packageName: pkg, ...legacy }
    }
    if (existsSync(file)) {
      try {
        return { packageName: pkg, ...(JSON.parse(readFileSync(file, 'utf8')) as CacheRecord) }
      } catch {
        /* rebuild */
      }
    }
    if (!apkPath) return { packageName: pkg }
    let record: CacheRecord
    try {
      record = await withReadSlot(() => resolveMeta(serial, pkg, apkPath))
    } catch {
      // Device dropped / timed out: don't cache, so it's retried.
      return { packageName: pkg, retry: true }
    }
    try {
      writeFileSync(file, JSON.stringify(record))
      rememberLabel(pkg, versionCode, record.label)
    } catch {
      /* cache is best-effort */
    }
    return { packageName: pkg, ...record }
  })().finally(() => inflight.delete(key))
  inflight.set(key, task)
  return task
}

/** Read the cache only (fast path for list rendering). */
export function cachedAppMeta(pkg: string, versionCode: number | undefined): CacheRecord | null {
  const file = cacheFile(pkg, versionCode)
  if (!existsSync(file)) return legacyRecord(pkg, versionCode)
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as CacheRecord
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Name index: the app list needs every app's name (for sorting and search) but not its
// icon, so names are kept in one small file instead of opening hundreds of cache files.

const LABELS_FILE = 'labels.json'
let labelIndex: Record<string, string> | null = null
let labelSaveTimer: NodeJS.Timeout | null = null

function labelKey(pkg: string, version: number | undefined): string {
  return `${pkg}@${version ?? 0}`
}

function loadLabelIndex(): Record<string, string> {
  if (labelIndex) return labelIndex
  try {
    labelIndex = JSON.parse(readFileSync(join(cacheDir(), LABELS_FILE), 'utf8')) as Record<string, string>
  } catch {
    // One-time migration from the per-app cache files.
    labelIndex = {}
    for (const f of readdirSync(cacheDir())) {
      const m = /^(.+)@(\d+)\.v\d+\.json$/.exec(f)
      if (!m || labelIndex[labelKey(m[1], Number(m[2]))]) continue
      try {
        const rec = JSON.parse(readFileSync(join(cacheDir(), f), 'utf8')) as CacheRecord
        if (rec.label) labelIndex[labelKey(m[1], Number(m[2]))] = rec.label
      } catch {
        /* skip unreadable entries */
      }
    }
    scheduleLabelSave()
  }
  return labelIndex
}

function scheduleLabelSave(): void {
  if (labelSaveTimer) return
  labelSaveTimer = setTimeout(() => {
    labelSaveTimer = null
    try {
      writeFileSync(join(cacheDir(), LABELS_FILE), JSON.stringify(labelIndex ?? {}))
    } catch {
      /* best effort */
    }
  }, 2000)
}

function rememberLabel(pkg: string, version: number | undefined, label: string | undefined): void {
  if (!label) return
  const index = loadLabelIndex()
  if (index[labelKey(pkg, version)] === label) return
  index[labelKey(pkg, version)] = label
  scheduleLabelSave()
}

/** The cached real app name, if one is known (cheap: no icon data is read). */
export function cachedLabel(pkg: string, version: number | undefined): string | undefined {
  return loadLabelIndex()[labelKey(pkg, version)]
}
