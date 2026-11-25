import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  childElements,
  extractLocalEntry,
  findCentralDirectory,
  parseBinaryXml,
  parseCentralDirectory,
  ResourceTable,
  StringPool,
  summarizeManifest,
  TYPE_REFERENCE,
  TYPE_STRING
} from '../src/main/lib/apk'

// ---------------------------------------------------------------------------
// Tiny builders for Android binary formats (test-only)

function u16(n: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n)
  return b
}
function u32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n >>> 0)
  return b
}
function pad4(b: Buffer): Buffer {
  return b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b
}
function chunk(type: number, headerSize: number, header: Buffer, body: Buffer): Buffer {
  const size = 8 + header.length + body.length
  expect(8 + header.length).toBe(headerSize)
  return Buffer.concat([u16(type), u16(headerSize), u32(size), header, body])
}

function stringPool(strings: string[], utf8 = false): Buffer {
  const datas: Buffer[] = []
  const offsets: number[] = []
  let off = 0
  for (const s of strings) {
    offsets.push(off)
    let b: Buffer
    if (utf8) {
      const bytes = Buffer.from(s, 'utf8')
      b = Buffer.concat([Buffer.from([s.length, bytes.length]), bytes, Buffer.from([0])])
    } else {
      b = Buffer.concat([u16(s.length), Buffer.from(s, 'utf16le'), u16(0)])
    }
    datas.push(b)
    off += b.length
  }
  const data = pad4(Buffer.concat(datas))
  const headerSize = 28
  const stringsStart = headerSize + strings.length * 4
  const header = Buffer.concat([u32(strings.length), u32(0), u32(utf8 ? 0x100 : 0), u32(stringsStart), u32(0)])
  return chunk(0x0001, headerSize, header, Buffer.concat([...offsets.map(u32), data]))
}

interface Attr {
  name: number
  type: number
  data: number
  raw?: number
}

function startElement(name: number, attrs: Attr[]): Buffer {
  const header = Buffer.concat([u32(1), u32(0xffffffff)])
  const ext = Buffer.concat([u32(0xffffffff), u32(name), u16(20), u16(20), u16(attrs.length), u16(0), u16(0), u16(0)])
  const body = attrs.map((a) => Buffer.concat([u32(0xffffffff), u32(a.name), u32(a.raw ?? 0xffffffff), u16(8), Buffer.from([0, a.type]), u32(a.data)]))
  return chunk(0x0102, 16, header, Buffer.concat([ext, ...body]))
}

function endElement(name: number): Buffer {
  return chunk(0x0103, 16, Buffer.concat([u32(1), u32(0xffffffff)]), Buffer.concat([u32(0xffffffff), u32(name)]))
}

const LABEL_REF = 0x7f010000
const ICON_REF = 0x7f020000

function buildManifest(): Buffer {
  // 0 label, 1 icon, 2 package, 3 manifest, 4 application, 5 com.example.app, 6 versionName, 7 1.2.3
  const pool = stringPool(['label', 'icon', 'package', 'manifest', 'application', 'com.example.app', 'versionName', '1.2.3'])
  const resMap = chunk(0x0180, 8, Buffer.alloc(0), Buffer.concat([u32(0x01010001), u32(0x01010002)]))
  const body = Buffer.concat([
    pool,
    resMap,
    startElement(3, [
      { name: 2, type: TYPE_STRING, data: 5, raw: 5 },
      { name: 6, type: TYPE_STRING, data: 7, raw: 7 }
    ]),
    startElement(4, [
      { name: 0, type: TYPE_REFERENCE, data: LABEL_REF },
      { name: 1, type: TYPE_REFERENCE, data: ICON_REF }
    ]),
    endElement(4),
    endElement(3)
  ])
  return chunk(0x0003, 8, Buffer.alloc(0), body)
}

function config(opts: { lang?: string; density?: number }): Buffer {
  const c = Buffer.alloc(64)
  c.writeUInt32LE(64, 0)
  if (opts.lang) c.write(opts.lang, 8, 'latin1')
  if (opts.density) c.writeUInt16LE(opts.density, 14)
  return c
}

function typeChunk(typeId: number, cfg: Buffer, entry: Buffer): Buffer {
  const headerSize = 20 + cfg.length
  const entriesStart = headerSize + 4
  const header = Buffer.concat([Buffer.from([typeId, 0]), u16(0), u32(1), u32(entriesStart), cfg])
  return chunk(0x0201, headerSize, header, Buffer.concat([u32(0), entry]))
}

function fullEntry(key: number, type: number, data: number): Buffer {
  return Buffer.concat([u16(8), u16(0), u32(key), u16(8), Buffer.from([0, type]), u32(data)])
}

function compactEntry(key: number, type: number, data: number): Buffer {
  return Buffer.concat([u16(key), u16((type << 8) | 0x0008), u32(data)])
}

function buildArsc(): Buffer {
  const globals = stringPool(
    ['Example App', 'res/mipmap-xxxhdpi-v4/ic_launcher.png', 'res/mipmap-mdpi-v4/ic_launcher.png', 'res/mipmap-anydpi-v26/ic_launcher.xml', 'Exemple'],
    true
  )
  const typeStrings = stringPool(['string', 'mipmap'])
  const keyStrings = stringPool(['app_name', 'ic_launcher'])
  const chunks = Buffer.concat([
    typeStrings,
    keyStrings,
    typeChunk(1, config({}), fullEntry(0, TYPE_STRING, 0)),
    typeChunk(1, config({ lang: 'fr' }), compactEntry(0, TYPE_STRING, 4)),
    typeChunk(2, config({ density: 160 }), fullEntry(1, TYPE_STRING, 2)),
    typeChunk(2, config({ density: 640 }), fullEntry(1, TYPE_STRING, 1)),
    typeChunk(2, config({ density: 0xffff }), fullEntry(1, TYPE_STRING, 3))
  ])
  const pkgHeader = Buffer.concat([u32(0x7f), Buffer.alloc(256), u32(288), u32(0), u32(288 + typeStrings.length), u32(0), u32(0)])
  const pkg = chunk(0x0200, 288, pkgHeader, chunks)
  return chunk(0x0002, 12, u32(1), Buffer.concat([globals, pkg]))
}

function buildZip(files: { name: string; data: Buffer; deflate?: boolean; extra?: number }[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const f of files) {
    const name = Buffer.from(f.name)
    const payload = f.deflate ? deflateRawSync(f.data) : f.data
    const method = f.deflate ? 8 : 0
    const extra = Buffer.alloc(f.extra ?? 0)
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(method), u16(0), u16(0), u32(0),
      u32(payload.length), u32(f.data.length), u16(name.length), u16(extra.length), name, extra, payload
    ])
    centrals.push(
      Buffer.concat([
        u32(0x02014b50), u16(20), u16(20), u16(0), u16(method), u16(0), u16(0), u32(0),
        u32(payload.length), u32(f.data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name
      ])
    )
    locals.push(local)
    offset += local.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(cd.length), u32(offset), u16(0)])
  return Buffer.concat([...locals, cd, eocd])
}

// ---------------------------------------------------------------------------

describe('StringPool', () => {
  it('decodes UTF-16 and UTF-8 pools, including non-Latin text', () => {
    const words = ['hello', 'مرحبا', 'こんにちは']
    for (const utf8 of [false, true]) {
      const pool = new StringPool(stringPool(words, utf8), 0)
      expect(pool.count).toBe(3)
      expect([0, 1, 2].map((i) => pool.get(i))).toEqual(words)
      expect(pool.get(99)).toBeUndefined()
    }
  })
})

describe('binary XML', () => {
  it('reads the manifest package, version, label and icon', () => {
    const m = summarizeManifest(buildManifest())
    expect(m.packageName).toBe('com.example.app')
    expect(m.versionName).toBe('1.2.3')
    expect(m.label).toMatchObject({ type: TYPE_REFERENCE, data: LABEL_REF })
    expect(m.icon).toMatchObject({ type: TYPE_REFERENCE, data: ICON_REF })
  })

  it('tracks element depth', () => {
    const els = parseBinaryXml(buildManifest())
    expect(els.map((e) => [e.name, e.depth])).toEqual([
      ['manifest', 0],
      ['application', 1]
    ])
  })

  it('falls back to the launcher activity icon', () => {
    // 0 icon, 1 name, 2 manifest, 3 application, 4 activity, 5 intent-filter, 6 action, 7 category, 8 MAIN, 9 LAUNCHER, 10 other
    const pool = stringPool(['icon', 'name', 'manifest', 'application', 'activity', 'intent-filter', 'action', 'category', 'android.intent.action.MAIN', 'android.intent.category.LAUNCHER', 'other'])
    const resMap = chunk(0x0180, 8, Buffer.alloc(0), Buffer.concat([u32(0x01010002), u32(0x01010003)]))
    const xml = chunk(
      0x0003,
      8,
      Buffer.alloc(0),
      Buffer.concat([
        pool,
        resMap,
        startElement(2, []),
        startElement(3, []),
        startElement(4, [{ name: 0, type: TYPE_REFERENCE, data: 0x7f020005 }]), // settings-like activity, not a launcher
        startElement(5, []),
        startElement(6, [{ name: 1, type: TYPE_STRING, data: 10, raw: 10 }]),
        endElement(6),
        endElement(5),
        endElement(4),
        startElement(4, [{ name: 0, type: TYPE_REFERENCE, data: ICON_REF }]), // launcher activity
        startElement(5, []),
        startElement(6, [{ name: 1, type: TYPE_STRING, data: 8, raw: 8 }]),
        endElement(6),
        startElement(7, [{ name: 1, type: TYPE_STRING, data: 9, raw: 9 }]),
        endElement(7),
        endElement(5),
        endElement(4),
        endElement(3),
        endElement(2)
      ])
    )
    const m = summarizeManifest(xml)
    expect(m.icon).toBeUndefined()
    expect(m.launcherIcon).toMatchObject({ type: TYPE_REFERENCE, data: ICON_REF })
    const els = parseBinaryXml(xml)
    expect(childElements(els, els.findIndex((e) => e.name === 'application')).map((e) => e.name)).toEqual(['activity', 'activity'])
  })

  it('rejects non-XML data', () => {
    expect(() => parseBinaryXml(Buffer.from('<xml/>'))).toThrow()
  })
})

describe('resource table', () => {
  const table = new ResourceTable(buildArsc())

  it('resolves the default-language label', () => {
    expect(table.resolveString({ type: TYPE_REFERENCE, data: LABEL_REF })).toBe('Example App')
  })

  it('reads compact entries', () => {
    const fr = table.candidates(LABEL_REF).find((c) => c.language === 'fr')
    expect(fr?.value).toEqual({ type: TYPE_STRING, data: 4 })
  })

  it('ranks icon files: bitmaps first, then the preferred density', () => {
    expect(table.resolveFiles({ type: TYPE_REFERENCE, data: ICON_REF })).toEqual([
      'res/mipmap-xxxhdpi-v4/ic_launcher.png',
      'res/mipmap-mdpi-v4/ic_launcher.png',
      'res/mipmap-anydpi-v26/ic_launcher.xml'
    ])
  })

  it('finds resources by type and name', () => {
    expect(table.findByName(['mipmap', 'drawable'], ['ic_launcher'])).toBe(ICON_REF)
    expect(table.findByName(['string'], ['app_name'])).toBe(LABEL_REF)
    expect(table.findByName(['mipmap'], ['app_icon', 'nope'])).toBeUndefined()
  })

  it('returns literal strings untouched', () => {
    expect(table.resolveString({ type: TYPE_STRING, data: 0, raw: 'Literal' })).toBe('Literal')
    expect(table.resolveString(undefined)).toBeUndefined()
  })
})

describe('zip reader', () => {
  const manifest = buildManifest()
  const arsc = buildArsc()
  const zip = buildZip([
    { name: 'AndroidManifest.xml', data: manifest, deflate: true },
    { name: 'resources.arsc', data: arsc, extra: 3 },
    { name: 'res/مجلد/icon.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }
  ])

  it('finds and parses the central directory from the tail', () => {
    const tailOffset = Math.max(0, zip.length - 100)
    const loc = findCentralDirectory(zip.subarray(tailOffset), tailOffset)
    expect(loc && 'cdOffset' in loc).toBe(true)
    if (!loc || !('cdOffset' in loc)) return
    const entries = parseCentralDirectory(zip.subarray(loc.cdOffset, loc.cdOffset + loc.cdSize))
    expect(entries.map((e) => e.name)).toEqual(['AndroidManifest.xml', 'resources.arsc', 'res/مجلد/icon.png'])
  })

  it('extracts stored and deflated entries (with padding extras)', () => {
    const loc = findCentralDirectory(zip, 0)
    if (!loc || !('cdOffset' in loc)) throw new Error('no cd')
    const entries = parseCentralDirectory(zip.subarray(loc.cdOffset, loc.cdOffset + loc.cdSize))
    const m = extractLocalEntry(zip.subarray(entries[0].localHeaderOffset), entries[0])
    const a = extractLocalEntry(zip.subarray(entries[1].localHeaderOffset), entries[1])
    expect(Buffer.isBuffer(m) && m.equals(manifest)).toBe(true)
    expect(Buffer.isBuffer(a) && a.equals(arsc)).toBe(true)
  })

  it('asks for more bytes when the buffer is too short', () => {
    const loc = findCentralDirectory(zip, 0)
    if (!loc || !('cdOffset' in loc)) throw new Error('no cd')
    const [entry] = parseCentralDirectory(zip.subarray(loc.cdOffset, loc.cdOffset + loc.cdSize))
    const res = extractLocalEntry(zip.subarray(entry.localHeaderOffset, entry.localHeaderOffset + 40), entry)
    expect(Buffer.isBuffer(res)).toBe(false)
    expect((res as { needBytes: number }).needBytes).toBeGreaterThan(40)
  })

  it('returns null for data that is not a zip', () => {
    expect(findCentralDirectory(Buffer.alloc(200), 0)).toBeNull()
  })
})
