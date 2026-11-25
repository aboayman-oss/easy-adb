import { describe, expect, it } from 'vitest'
import type { XmlElement } from '../src/main/lib/apk'
import { argbToRgba, complexToFloat, composeAdaptiveIcon, floatFromBits, numberValue, svgDataUrl, toTree, vectorToSvg } from '../src/main/lib/vector'

const floatBits = (f: number): number => {
  const b = Buffer.alloc(4)
  b.writeFloatLE(f)
  return b.readUInt32LE(0)
}
const el = (name: string, depth: number, attrs: Record<string, { type: number; data: number; raw?: string }>): XmlElement => ({
  name,
  depth,
  attributes: Object.entries(attrs).map(([n, value]) => ({ name: n, value }))
})

const TYPE_FLOAT = 4
const TYPE_DIMENSION = 5
const TYPE_STRING = 3
const TYPE_REFERENCE = 1
const TYPE_ARGB8 = 0x1c

// A 108dp adaptive-icon foreground: a white circle inside a group translated by (4,4).
const vector: XmlElement[] = [
  el('vector', 0, {
    width: { type: TYPE_DIMENSION, data: 0x6c01 },
    height: { type: TYPE_DIMENSION, data: 0x6c01 },
    viewportWidth: { type: TYPE_FLOAT, data: floatBits(108) },
    viewportHeight: { type: TYPE_FLOAT, data: floatBits(108) }
  }),
  el('group', 1, { translateX: { type: TYPE_FLOAT, data: floatBits(4) }, translateY: { type: TYPE_FLOAT, data: floatBits(4) } }),
  el('path', 2, {
    pathData: { type: TYPE_STRING, data: 0, raw: 'M54,30a24,24 0,1 1,0 48a24,24 0,1 1,0 -48z' },
    fillColor: { type: TYPE_ARGB8, data: 0xffffffff }
  }),
  el('path', 2, {
    pathData: { type: TYPE_STRING, data: 0, raw: 'M10,10L20,20' },
    strokeColor: { type: TYPE_REFERENCE, data: 0x7f050001 },
    strokeWidth: { type: TYPE_FLOAT, data: floatBits(2) },
    fillType: { type: 0x10, data: 1 }
  })
]

const opts = {
  color: (v: { type: number; data: number }) =>
    v.type === TYPE_ARGB8 ? argbToRgba(v.data) : v.type === TYPE_REFERENCE && v.data === 0x7f050001 ? argbToRgba(0x80ff0000) : undefined,
  string: (v: { type: number; raw?: string }) => v.raw
}

describe('vector drawable → SVG', () => {
  it('decodes numeric resource values', () => {
    expect(complexToFloat(0x6c01)).toBe(108)
    expect(floatFromBits(floatBits(1.5))).toBe(1.5)
    expect(numberValue({ type: TYPE_DIMENSION, data: 0x1801 })).toBe(24)
    expect(argbToRgba(0x80ff0000)).toEqual({ hex: '#ff0000', alpha: 0.502 })
  })

  it('rebuilds the element tree from depths', () => {
    const tree = toTree(vector)!
    expect(tree.el.name).toBe('vector')
    expect(tree.children[0].el.name).toBe('group')
    expect(tree.children[0].children.map((c) => c.el.name)).toEqual(['path', 'path'])
  })

  it('renders paths, groups, strokes and fill rules', () => {
    const res = vectorToSvg(vector, opts)!
    expect(res.width).toBe(108)
    expect(res.svg).toContain('viewBox="0 0 108 108"')
    expect(res.svg).toContain('transform="translate(4 4) rotate(0) scale(1 1) translate(0 0)"')
    expect(res.svg).toContain('d="M54,30a24,24 0,1 1,0 48a24,24 0,1 1,0 -48z" fill="#ffffff"')
    expect(res.svg).toContain('stroke="#ff0000" stroke-opacity="0.502" stroke-width="2"')
    expect(res.svg).toContain('fill-rule="evenodd"')
  })

  it('escapes path data and ignores non-vector roots', () => {
    const evil = [el('vector', 0, {}), el('path', 1, { pathData: { type: TYPE_STRING, data: 0, raw: 'M0 0"/><script>' } })]
    expect(vectorToSvg(evil, opts)!.svg).not.toContain('<script>')
    expect(vectorToSvg([el('shape', 0, {})], opts)).toBeNull()
  })

  it('composes adaptive icons onto the visible 72dp area', () => {
    const fg = vectorToSvg(vector, opts)!
    const svg = composeAdaptiveIcon({ kind: 'color', color: { hex: '#0e5a45', alpha: 1 } }, { kind: 'svg', svg: fg.svg }, 0)
    expect(svg).toContain('viewBox="18 18 72 72"')
    expect(svg).toContain('<rect width="108" height="108" fill="#0e5a45"/>')
    // The nested vector keeps its viewBox but is sized to the 108 layer box.
    expect(svg).toContain('<svg x="0" y="0" width="108" height="108" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108">')
    expect(svgDataUrl(svg).startsWith('data:image/svg+xml;base64,')).toBe(true)
  })
})
