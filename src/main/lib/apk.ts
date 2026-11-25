// Minimal, dependency-free readers for the parts of an APK we need to show a
// human-friendly app name and icon: the ZIP central directory, Android binary XML
// (AndroidManifest.xml) and the compiled resource table (resources.arsc).
import { inflateRawSync } from 'node:zlib'

// ---------------------------------------------------------------------------
// ZIP

export interface ZipEntryInfo {
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}

export interface ZipDirectoryLocation {
  cdOffset: number
  cdSize: number
  entries: number
}

const EOCD_SIG = 0x06054b50
const ZIP64_LOCATOR_SIG = 0x07064b50
const ZIP64_EOCD_SIG = 0x06064b50
const CD_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

/**
 * Find the central directory from the tail of a zip file.
 * `tail` must be the last bytes of the file and `tailOffset` its absolute position.
 * Returns `needZip64At` when the zip64 record lies outside the tail.
 */
export function findCentralDirectory(tail: Buffer, tailOffset: number): ZipDirectoryLocation | { needZip64At: number } | null {
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) !== EOCD_SIG) continue
    const commentLen = tail.readUInt16LE(i + 20)
    if (i + 22 + commentLen > tail.length) continue
    let entries = tail.readUInt16LE(i + 10)
    let cdSize = tail.readUInt32LE(i + 12)
    let cdOffset = tail.readUInt32LE(i + 16)
    if (cdOffset === 0xffffffff || cdSize === 0xffffffff || entries === 0xffff) {
      const loc = i - 20
      if (loc < 0 || tail.readUInt32LE(loc) !== ZIP64_LOCATOR_SIG) return null
      const zip64Offset = Number(tail.readBigUInt64LE(loc + 8))
      const rel = zip64Offset - tailOffset
      if (rel < 0 || rel + 56 > tail.length) return { needZip64At: zip64Offset }
      if (tail.readUInt32LE(rel) !== ZIP64_EOCD_SIG) return null
      entries = Number(tail.readBigUInt64LE(rel + 32))
      cdSize = Number(tail.readBigUInt64LE(rel + 40))
      cdOffset = Number(tail.readBigUInt64LE(rel + 48))
    }
    return { cdOffset, cdSize, entries }
  }
  return null
}

export function parseZip64Eocd(buf: Buffer): ZipDirectoryLocation | null {
  if (buf.length < 56 || buf.readUInt32LE(0) !== ZIP64_EOCD_SIG) return null
  return {
    entries: Number(buf.readBigUInt64LE(32)),
    cdSize: Number(buf.readBigUInt64LE(40)),
    cdOffset: Number(buf.readBigUInt64LE(48))
  }
}

export function parseCentralDirectory(cd: Buffer): ZipEntryInfo[] {
  const out: ZipEntryInfo[] = []
  let p = 0
  while (p + 46 <= cd.length && cd.readUInt32LE(p) === CD_SIG) {
    const method = cd.readUInt16LE(p + 10)
    let compressedSize = cd.readUInt32LE(p + 20)
    let uncompressedSize = cd.readUInt32LE(p + 24)
    const nameLen = cd.readUInt16LE(p + 28)
    const extraLen = cd.readUInt16LE(p + 30)
    const commentLen = cd.readUInt16LE(p + 32)
    let localHeaderOffset = cd.readUInt32LE(p + 42)
    const name = cd.toString('utf8', p + 46, p + 46 + nameLen)
    // zip64 extended information extra field
    let e = p + 46 + nameLen
    const extraEnd = e + extraLen
    while (e + 4 <= extraEnd) {
      const id = cd.readUInt16LE(e)
      const size = cd.readUInt16LE(e + 2)
      if (id === 0x0001) {
        let q = e + 4
        if (uncompressedSize === 0xffffffff && q + 8 <= e + 4 + size) {
          uncompressedSize = Number(cd.readBigUInt64LE(q))
          q += 8
        }
        if (compressedSize === 0xffffffff && q + 8 <= e + 4 + size) {
          compressedSize = Number(cd.readBigUInt64LE(q))
          q += 8
        }
        if (localHeaderOffset === 0xffffffff && q + 8 <= e + 4 + size) {
          localHeaderOffset = Number(cd.readBigUInt64LE(q))
        }
      }
      e += 4 + size
    }
    out.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset })
    p = extraEnd + commentLen
  }
  return out
}

/** Given bytes read starting at an entry's local header, return the uncompressed data. */
export function extractLocalEntry(buf: Buffer, entry: ZipEntryInfo): Buffer | { needBytes: number } {
  if (buf.length < 30 || buf.readUInt32LE(0) !== LOCAL_SIG) throw new Error('Bad local header')
  const nameLen = buf.readUInt16LE(26)
  const extraLen = buf.readUInt16LE(28)
  const start = 30 + nameLen + extraLen
  const end = start + entry.compressedSize
  if (end > buf.length) return { needBytes: end }
  const raw = buf.subarray(start, end)
  if (entry.method === 0) return raw
  if (entry.method === 8) return inflateRawSync(raw)
  throw new Error(`Unsupported compression method ${entry.method}`)
}

// ---------------------------------------------------------------------------
// Resource chunks

const RES_STRING_POOL_TYPE = 0x0001
const RES_TABLE_TYPE = 0x0002
const RES_XML_TYPE = 0x0003
const RES_XML_START_ELEMENT_TYPE = 0x0102
const RES_XML_RESOURCE_MAP_TYPE = 0x0180
const RES_TABLE_PACKAGE_TYPE = 0x0200
const RES_TABLE_TYPE_TYPE = 0x0201

export const TYPE_NULL = 0x00
export const TYPE_REFERENCE = 0x01
export const TYPE_STRING = 0x03
export const TYPE_INT_COLOR_ARGB8 = 0x1c
export const TYPE_INT_COLOR_RGB8 = 0x1d
export const TYPE_INT_COLOR_ARGB4 = 0x1e
export const TYPE_INT_COLOR_RGB4 = 0x1f

/** Lazily-decoded string pool. */
export class StringPool {
  private readonly cache = new Map<number, string>()
  readonly count: number
  private readonly utf8: boolean
  private readonly offsetsAt: number
  private readonly stringsAt: number

  constructor(
    private readonly buf: Buffer,
    start: number
  ) {
    const headerSize = buf.readUInt16LE(start + 2)
    this.count = buf.readUInt32LE(start + 8)
    const flags = buf.readUInt32LE(start + 16)
    this.utf8 = (flags & (1 << 8)) !== 0
    this.stringsAt = start + buf.readUInt32LE(start + 20)
    this.offsetsAt = start + headerSize
  }

  get(index: number): string | undefined {
    if (index < 0 || index >= this.count || index === 0xffffffff) return undefined
    const cached = this.cache.get(index)
    if (cached !== undefined) return cached
    let p = this.stringsAt + this.buf.readUInt32LE(this.offsetsAt + index * 4)
    let value: string
    if (this.utf8) {
      // utf-16 length (skip), then utf-8 byte length
      p += (this.buf[p] & 0x80) !== 0 ? 2 : 1
      let len = this.buf[p]
      if ((len & 0x80) !== 0) {
        len = ((len & 0x7f) << 8) | this.buf[p + 1]
        p += 2
      } else p += 1
      value = this.buf.toString('utf8', p, p + len)
    } else {
      let len = this.buf.readUInt16LE(p)
      if ((len & 0x8000) !== 0) {
        len = ((len & 0x7fff) << 16) | this.buf.readUInt16LE(p + 2)
        p += 4
      } else p += 2
      value = this.buf.toString('utf16le', p, p + len * 2)
    }
    this.cache.set(index, value)
    return value
  }
}

export interface TypedValue {
  type: number
  data: number
  raw?: string
}

export interface XmlAttribute {
  name: string
  resId?: number
  value: TypedValue
}

export interface XmlElement {
  name: string
  attributes: XmlAttribute[]
  depth: number
}

/** Parse Android binary XML into a flat list of start elements (with depth). */
export function parseBinaryXml(buf: Buffer): XmlElement[] {
  if (buf.length < 8 || buf.readUInt16LE(0) !== RES_XML_TYPE) throw new Error('Not a binary XML file')
  const total = Math.min(buf.readUInt32LE(4), buf.length)
  let p = buf.readUInt16LE(2)
  let pool: StringPool | null = null
  let resMap: number[] = []
  const elements: XmlElement[] = []
  let depth = 0
  while (p + 8 <= total) {
    const type = buf.readUInt16LE(p)
    const headerSize = buf.readUInt16LE(p + 2)
    const size = buf.readUInt32LE(p + 4)
    if (size < 8) break
    if (type === RES_STRING_POOL_TYPE) pool = new StringPool(buf, p)
    else if (type === RES_XML_RESOURCE_MAP_TYPE) {
      resMap = []
      for (let q = p + headerSize; q + 4 <= p + size; q += 4) resMap.push(buf.readUInt32LE(q))
    } else if (type === RES_XML_START_ELEMENT_TYPE && pool) {
      const ext = p + headerSize
      const nameIdx = buf.readUInt32LE(ext + 4)
      const attrStart = buf.readUInt16LE(ext + 8)
      const attrSize = buf.readUInt16LE(ext + 10)
      const attrCount = buf.readUInt16LE(ext + 12)
      const attributes: XmlAttribute[] = []
      for (let i = 0; i < attrCount; i++) {
        const a = ext + attrStart + i * attrSize
        const attrNameIdx = buf.readUInt32LE(a + 4)
        const rawIdx = buf.readUInt32LE(a + 8)
        const dataType = buf.readUInt8(a + 15)
        const data = buf.readUInt32LE(a + 16)
        attributes.push({
          name: pool.get(attrNameIdx) ?? '',
          resId: attrNameIdx < resMap.length ? resMap[attrNameIdx] : undefined,
          value: { type: dataType, data, raw: rawIdx !== 0xffffffff ? pool.get(rawIdx) : undefined }
        })
      }
      elements.push({ name: pool.get(nameIdx) ?? '', attributes, depth })
      depth++
    } else if (type === 0x0103) {
      depth = Math.max(0, depth - 1)
    }
    p += size
  }
  return elements
}

export const ATTR_LABEL = 0x01010001
export const ATTR_ICON = 0x01010002
export const ATTR_ROUND_ICON = 0x0101052c
export const ATTR_DRAWABLE = 0x01010199

export function findAttr(el: XmlElement | undefined, resId: number, name: string): TypedValue | undefined {
  if (!el) return undefined
  return (el.attributes.find((a) => a.resId === resId) ?? el.attributes.find((a) => a.name === name))?.value
}

export interface ManifestSummary {
  packageName?: string
  versionName?: string
  label?: TypedValue
  icon?: TypedValue
  roundIcon?: TypedValue
  /** Icon of the MAIN/LAUNCHER activity (some apps only set it there). */
  launcherIcon?: TypedValue
}

/** Children of the element at `index` in a flat, depth-annotated element list. */
export function childElements(els: XmlElement[], index: number): XmlElement[] {
  const depth = els[index].depth
  const out: XmlElement[] = []
  for (let i = index + 1; i < els.length && els[i].depth > depth; i++) if (els[i].depth === depth + 1) out.push(els[i])
  return out
}

function launcherActivityIcon(elements: XmlElement[]): TypedValue | undefined {
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i]
    if (el.name !== 'activity' && el.name !== 'activity-alias') continue
    const icon = findAttr(el, ATTR_ICON, 'icon')
    if (!icon) continue
    let main = false
    let launcher = false
    for (let j = i + 1; j < elements.length && elements[j].depth > el.depth; j++) {
      const name = elements[j].attributes.find((a) => a.name === 'name' || a.resId === 0x01010003)?.value.raw
      if (elements[j].name === 'action' && name === 'android.intent.action.MAIN') main = true
      if (elements[j].name === 'category' && name === 'android.intent.category.LAUNCHER') launcher = true
    }
    if (main && launcher) return icon
  }
  return undefined
}

export function summarizeManifest(xml: Buffer): ManifestSummary {
  const elements = parseBinaryXml(xml)
  const manifest = elements.find((e) => e.name === 'manifest')
  const application = elements.find((e) => e.name === 'application')
  return {
    packageName: manifest?.attributes.find((a) => a.name === 'package')?.value.raw,
    versionName: findAttr(manifest, 0x0101021c, 'versionName')?.raw,
    label: findAttr(application, ATTR_LABEL, 'label'),
    icon: findAttr(application, ATTR_ICON, 'icon'),
    roundIcon: findAttr(application, ATTR_ROUND_ICON, 'roundIcon'),
    launcherIcon: launcherActivityIcon(elements)
  }
}

// ---------------------------------------------------------------------------
// Resource table

export interface ResourceCandidate {
  language: string
  country: string
  density: number
  sdk: number
  value: TypedValue
}

export class ResourceTable {
  private readonly globalPool: StringPool | null = null
  private readonly packages = new Map<number, { start: number; size: number; headerSize: number }>()

  constructor(private readonly buf: Buffer) {
    if (buf.length < 12 || buf.readUInt16LE(0) !== RES_TABLE_TYPE) throw new Error('Not a resource table')
    const headerSize = buf.readUInt16LE(2)
    const total = Math.min(buf.readUInt32LE(4), buf.length)
    let p = headerSize
    while (p + 8 <= total) {
      const type = buf.readUInt16LE(p)
      const size = buf.readUInt32LE(p + 4)
      if (size < 8) break
      if (type === RES_STRING_POOL_TYPE && !this.globalPool) this.globalPool = new StringPool(buf, p)
      else if (type === RES_TABLE_PACKAGE_TYPE) {
        const id = buf.readUInt32LE(p + 8)
        this.packages.set(id, { start: p, size, headerSize: buf.readUInt16LE(p + 2) })
      }
      p += size
    }
  }

  string(index: number): string | undefined {
    return this.globalPool?.get(index)
  }

  /**
   * Find a resource id by type and entry name (e.g. mipmap/ic_launcher). Used for apps
   * that don't declare an icon in the manifest (Samsung's "icon container" apps).
   */
  findByName(typeNames: string[], keyNames: string[]): number | undefined {
    const b = this.buf
    const found = new Map<string, number>()
    for (const [pkgId, pkg] of this.packages) {
      if (pkg.headerSize < 284) continue
      const typePool = new StringPool(b, pkg.start + b.readUInt32LE(pkg.start + 268))
      const keyPool = new StringPool(b, pkg.start + b.readUInt32LE(pkg.start + 276))
      let p = pkg.start + pkg.headerSize
      const end = pkg.start + pkg.size
      while (p + 8 <= end) {
        const type = b.readUInt16LE(p)
        const headerSize = b.readUInt16LE(p + 2)
        const size = b.readUInt32LE(p + 4)
        if (size < 8) break
        if (type === RES_TABLE_TYPE_TYPE) {
          const typeId = b.readUInt8(p + 8)
          const typeName = typePool.get(typeId - 1)
          if (typeName && typeNames.includes(typeName)) {
            const flags = b.readUInt8(p + 9)
            const entryCount = b.readUInt32LE(p + 12)
            const entriesStart = b.readUInt32LE(p + 16)
            const offsetsAt = p + headerSize
            for (let i = 0; i < entryCount; i++) {
              let index = i
              let offset: number
              if (flags & 0x01) {
                index = b.readUInt16LE(offsetsAt + i * 4)
                offset = b.readUInt16LE(offsetsAt + i * 4 + 2) * 4
              } else if (flags & 0x02) {
                const o = b.readUInt16LE(offsetsAt + i * 2)
                if (o === 0xffff) continue
                offset = o * 4
              } else {
                const o = b.readUInt32LE(offsetsAt + i * 4)
                if (o === 0xffffffff) continue
                offset = o
              }
              const e = p + entriesStart + offset
              const entryFlags = b.readUInt16LE(e + 2)
              const keyIndex = entryFlags & 0x0008 ? b.readUInt16LE(e) : b.readUInt32LE(e + 4)
              const key = keyPool.get(keyIndex)
              if (key && keyNames.includes(key)) {
                const id = ((pkgId & 0xff) << 24) | (typeId << 16) | index
                const k = `${typeName}/${key}`
                if (!found.has(k)) found.set(k, id >>> 0)
              }
            }
          }
        }
        p += size
      }
    }
    for (const key of keyNames) for (const t of typeNames) if (found.has(`${t}/${key}`)) return found.get(`${t}/${key}`)
    return undefined
  }

  /** All values for a resource id across configurations. */
  candidates(resId: number): ResourceCandidate[] {
    const pkgId = (resId >>> 24) & 0xff
    const typeId = (resId >>> 16) & 0xff
    const entryId = resId & 0xffff
    const pkg = this.packages.get(pkgId) ?? (this.packages.size === 1 ? [...this.packages.values()][0] : undefined)
    if (!pkg) return []
    const out: ResourceCandidate[] = []
    const b = this.buf
    let p = pkg.start + pkg.headerSize
    const end = pkg.start + pkg.size
    while (p + 8 <= end) {
      const type = b.readUInt16LE(p)
      const headerSize = b.readUInt16LE(p + 2)
      const size = b.readUInt32LE(p + 4)
      if (size < 8) break
      if (type === RES_TABLE_TYPE_TYPE && b.readUInt8(p + 8) === typeId) {
        const flags = b.readUInt8(p + 9)
        const entryCount = b.readUInt32LE(p + 12)
        const entriesStart = b.readUInt32LE(p + 16)
        const config = p + 20
        const offsetsAt = p + headerSize
        let offset = -1
        if (flags & 0x01) {
          // sparse: (u16 index, u16 offset/4) pairs sorted by index
          let lo = 0
          let hi = entryCount - 1
          while (lo <= hi) {
            const mid = (lo + hi) >> 1
            const idx = b.readUInt16LE(offsetsAt + mid * 4)
            if (idx === entryId) {
              offset = b.readUInt16LE(offsetsAt + mid * 4 + 2) * 4
              break
            }
            if (idx < entryId) lo = mid + 1
            else hi = mid - 1
          }
        } else if (entryId < entryCount) {
          if (flags & 0x02) {
            const o = b.readUInt16LE(offsetsAt + entryId * 2)
            offset = o === 0xffff ? -1 : o * 4
          } else {
            const o = b.readUInt32LE(offsetsAt + entryId * 4)
            offset = o === 0xffffffff ? -1 : o
          }
        }
        if (offset >= 0) {
          const e = p + entriesStart + offset
          const entrySizeOrKey = b.readUInt16LE(e)
          const entryFlags = b.readUInt16LE(e + 2)
          let value: TypedValue | null = null
          if (entryFlags & 0x0008) {
            // compact entry: key u16, flags u16 (type in high byte), data u32
            value = { type: (entryFlags >> 8) & 0xff, data: b.readUInt32LE(e + 4) }
          } else if (!(entryFlags & 0x0001)) {
            const v = e + entrySizeOrKey
            value = { type: b.readUInt8(v + 3), data: b.readUInt32LE(v + 4) }
          }
          if (value) {
            const lang = b.readUInt16LE(config + 8)
            const country = b.readUInt16LE(config + 10)
            out.push({
              language: lang ? b.toString('latin1', config + 8, config + 10) : '',
              country: country ? b.toString('latin1', config + 10, config + 12) : '',
              density: b.readUInt16LE(config + 14),
              sdk: b.readUInt16LE(config + 24),
              value
            })
          }
        }
      }
      p += size
    }
    return out
  }

  /** Resolve a label: prefer default language, then English, then anything. */
  resolveString(value: TypedValue | undefined, depth = 0): string | undefined {
    if (!value || depth > 6) return undefined
    if (value.type === TYPE_STRING) return value.raw ?? this.string(value.data)
    if (value.type !== TYPE_REFERENCE || value.data === 0) return value.raw
    const cands = this.candidates(value.data)
    const pick =
      cands.find((c) => !c.language) ?? cands.find((c) => c.language === 'en' && (!c.country || c.country === 'US')) ?? cands.find((c) => c.language === 'en') ?? cands[0]
    if (!pick) return undefined
    return this.resolveString(pick.value, depth + 1)
  }

  /** Resolve a drawable reference to candidate file paths, best first. */
  resolveFiles(value: TypedValue | undefined, depth = 0): string[] {
    if (!value || depth > 6) return []
    if (value.type === TYPE_STRING) {
      const s = value.raw ?? this.string(value.data)
      return s ? [s] : []
    }
    if (value.type !== TYPE_REFERENCE || value.data === 0) return []
    const cands = this.candidates(value.data).filter((c) => !c.language)
    const scored = cands
      .map((c) => {
        const files = this.resolveFiles(c.value, depth + 1)
        return files.map((f) => ({ f, density: c.density }))
      })
      .flat()
    const rank = (x: { f: string; density: number }): number => {
      const bitmap = /\.(png|webp|jpe?g)$/i.test(x.f)
      const d = x.density === 0xffff || x.density === 0xfffe ? 0 : x.density
      // Bitmaps first. Prefer xxhdpi/xhdpi: sharp at list size without xxxhdpi's file size.
      const densityScore = d >= 320 && d <= 480 ? 1000 + d : d > 480 ? 900 - (d - 480) : d
      return (bitmap ? 10_000 : 0) + densityScore
    }
    return [...new Set(scored.sort((a, b) => rank(b) - rank(a)).map((x) => x.f))]
  }

  /** Resolve a color value to 0xAARRGGBB (literal or via references). */
  resolveArgb(value: TypedValue | undefined, depth = 0): number | undefined {
    if (!value || depth > 6) return undefined
    if (value.type >= TYPE_INT_COLOR_ARGB8 && value.type <= TYPE_INT_COLOR_RGB4) {
      const opaque = value.type === TYPE_INT_COLOR_RGB8 || value.type === TYPE_INT_COLOR_RGB4
      return opaque ? (value.data | 0xff000000) >>> 0 : value.data >>> 0
    }
    if (value.type !== TYPE_REFERENCE) return undefined
    const cand = this.candidates(value.data).find((c) => !c.language)
    return cand ? this.resolveArgb(cand.value, depth + 1) : undefined
  }

  /** Resolve a color value (for adaptive icon backgrounds). */
  resolveColor(value: TypedValue | undefined, depth = 0): string | undefined {
    if (!value || depth > 6) return undefined
    if (value.type >= TYPE_INT_COLOR_ARGB8 && value.type <= TYPE_INT_COLOR_RGB4) {
      const argb = value.data >>> 0
      const hex = (argb & 0xffffff).toString(16).padStart(6, '0')
      return `#${hex}`
    }
    if (value.type !== TYPE_REFERENCE) return undefined
    const cand = this.candidates(value.data).find((c) => !c.language)
    return cand ? this.resolveColor(cand.value, depth + 1) : undefined
  }
}
