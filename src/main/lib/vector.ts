// Converts compiled Android VectorDrawable / adaptive-icon XML into SVG so that
// modern app icons (which are often vectors) can be shown in the app list.
import type { TypedValue, XmlElement } from './apk'

const TYPE_FLOAT = 0x04
const TYPE_DIMENSION = 0x05
const TYPE_FRACTION = 0x06
const TYPE_INT_DEC = 0x10
const TYPE_INT_HEX = 0x11
const TYPE_INT_BOOLEAN = 0x12

export function floatFromBits(bits: number): number {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(bits >>> 0)
  return b.readFloatLE(0)
}

/** Decode a TYPE_DIMENSION / TYPE_FRACTION complex value (unit is ignored; dp ≈ px for icons). */
export function complexToFloat(data: number): number {
  const RADIX = [1 / 256, 1 / 256 / (1 << 7), 1 / 256 / (1 << 15), 1 / 256 / (1 << 23)]
  return (data & 0xffffff00) * RADIX[(data >> 4) & 3]
}

export function numberValue(v: TypedValue | undefined): number | undefined {
  if (!v) return undefined
  if (v.type === TYPE_FLOAT) return floatFromBits(v.data)
  if (v.type === TYPE_DIMENSION) return complexToFloat(v.data | 0)
  if (v.type === TYPE_FRACTION) return complexToFloat(v.data | 0) * 100
  if (v.type === TYPE_INT_DEC || v.type === TYPE_INT_HEX || v.type === TYPE_INT_BOOLEAN) return v.data | 0
  if (v.raw && !Number.isNaN(Number(v.raw))) return Number(v.raw)
  return undefined
}

export interface Rgba {
  hex: string
  alpha: number
}

export function argbToRgba(argb: number, forceOpaque = false): Rgba {
  const a = forceOpaque ? 255 : (argb >>> 24) & 0xff
  return { hex: '#' + (argb & 0xffffff).toString(16).padStart(6, '0'), alpha: Math.round((a / 255) * 1000) / 1000 }
}

function attr(el: XmlElement, name: string, resId?: number): TypedValue | undefined {
  return (el.attributes.find((a) => resId !== undefined && a.resId === resId) ?? el.attributes.find((a) => a.name === name))?.value
}

function esc(s: string): string {
  return s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!)
}

interface Node {
  el: XmlElement
  children: Node[]
}

/** Rebuild the element tree from the flat, depth-annotated list. */
export function toTree(els: XmlElement[]): Node | null {
  if (!els.length) return null
  const root: Node = { el: els[0], children: [] }
  const stack: Node[] = [root]
  for (const el of els.slice(1)) {
    const node: Node = { el, children: [] }
    while (stack.length && stack[stack.length - 1].el.depth >= el.depth) stack.pop()
    ;(stack[stack.length - 1] ?? root).children.push(node)
    stack.push(node)
  }
  return root
}

export interface VectorOptions {
  /** Resolve a color attribute (literal or reference) to RGBA. */
  color: (v: TypedValue) => Rgba | undefined
  /** Resolve a string attribute (path data may be a reference). */
  string: (v: TypedValue) => string | undefined
}

/**
 * Render a <vector> element tree as an SVG document.
 * Returns the SVG and the vector's intrinsic size (dp).
 */
export function vectorToSvg(els: XmlElement[], opts: VectorOptions): { svg: string; width: number; height: number } | null {
  const tree = toTree(els)
  if (!tree || tree.el.name !== 'vector') return null
  const v = tree.el
  const vw = numberValue(attr(v, 'viewportWidth', 0x01010402)) ?? 24
  const vh = numberValue(attr(v, 'viewportHeight', 0x01010403)) ?? 24
  const width = numberValue(attr(v, 'width', 0x01010159)) ?? vw
  const height = numberValue(attr(v, 'height', 0x01010155)) ?? vh
  const rootAlpha = numberValue(attr(v, 'alpha', 0x0101031f)) ?? 1

  let clipId = 0
  const defs: string[] = []

  const paint = (value: TypedValue | undefined, kind: 'fill' | 'stroke', alphaMul: number): string => {
    if (!value) return kind === 'fill' ? 'fill="none"' : ''
    const c = opts.color(value)
    if (!c) return kind === 'fill' ? 'fill="none"' : ''
    const a = Math.max(0, Math.min(1, c.alpha * alphaMul))
    return `${kind}="${c.hex}"${a < 1 ? ` ${kind}-opacity="${a}"` : ''}`
  }

  const render = (node: Node): string => {
    const el = node.el
    if (el.name === 'path') {
      const d = opts.string(attr(el, 'pathData', 0x01010405) ?? { type: 0, data: 0 })
      if (!d) return ''
      const fillAlpha = numberValue(attr(el, 'fillAlpha', 0x010104cc)) ?? 1
      const strokeAlpha = numberValue(attr(el, 'strokeAlpha', 0x010104cb)) ?? 1
      const strokeWidth = numberValue(attr(el, 'strokeWidth', 0x01010407))
      const fillType = numberValue(attr(el, 'fillType', 0x0101051e))
      const stroke = paint(attr(el, 'strokeColor', 0x01010406), 'stroke', strokeAlpha)
      const parts = [`d="${esc(d)}"`, paint(attr(el, 'fillColor', 0x01010404), 'fill', fillAlpha)]
      if (stroke) {
        parts.push(stroke)
        if (strokeWidth !== undefined) parts.push(`stroke-width="${strokeWidth}"`)
        const cap = numberValue(attr(el, 'strokeLineCap', 0x01010529))
        const join = numberValue(attr(el, 'strokeLineJoin', 0x0101052a))
        if (cap !== undefined) parts.push(`stroke-linecap="${['butt', 'round', 'square'][cap] ?? 'butt'}"`)
        if (join !== undefined) parts.push(`stroke-linejoin="${['miter', 'round', 'bevel'][join] ?? 'miter'}"`)
      }
      if (fillType === 1) parts.push('fill-rule="evenodd"')
      return `<path ${parts.join(' ')}/>`
    }
    if (el.name === 'group') {
      const rot = numberValue(attr(el, 'rotation', 0x01010326)) ?? 0
      const px = numberValue(attr(el, 'pivotX', 0x010101b5)) ?? 0
      const py = numberValue(attr(el, 'pivotY', 0x010101b6)) ?? 0
      const sx = numberValue(attr(el, 'scaleX', 0x01010324)) ?? 1
      const sy = numberValue(attr(el, 'scaleY', 0x01010325)) ?? 1
      const tx = numberValue(attr(el, 'translateX', 0x010103fa)) ?? 0
      const ty = numberValue(attr(el, 'translateY', 0x010103fb)) ?? 0
      const transform =
        rot || sx !== 1 || sy !== 1 || tx || ty
          ? ` transform="translate(${tx + px} ${ty + py}) rotate(${rot}) scale(${sx} ${sy}) translate(${-px} ${-py})"`
          : ''
      // clip-path children apply to their following siblings within the group.
      let body = ''
      let clip = ''
      for (const child of node.children) {
        if (child.el.name === 'clip-path') {
          const d = opts.string(attr(child.el, 'pathData', 0x01010405) ?? { type: 0, data: 0 })
          if (d) {
            const id = `c${clipId++}`
            defs.push(`<clipPath id="${id}"><path d="${esc(d)}"/></clipPath>`)
            clip = ` clip-path="url(#${id})"`
          }
        } else body += render(child)
      }
      return `<g${transform}>${clip ? `<g${clip}>${body}</g>` : body}</g>`
    }
    return node.children.map(render).join('')
  }

  let content = ''
  let rootClip = ''
  for (const child of tree.children) {
    if (child.el.name === 'clip-path') {
      const d = opts.string(attr(child.el, 'pathData', 0x01010405) ?? { type: 0, data: 0 })
      if (d) {
        defs.push(`<clipPath id="root"><path d="${esc(d)}"/></clipPath>`)
        rootClip = ' clip-path="url(#root)"'
      }
    } else content += render(child)
  }
  const body = rootClip ? `<g${rootClip}>${content}</g>` : content
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vw} ${vh}" width="${width}" height="${height}"${rootAlpha < 1 ? ` opacity="${rootAlpha}"` : ''}>` +
    (defs.length ? `<defs>${defs.join('')}</defs>` : '') +
    body +
    '</svg>'
  return { svg, width, height }
}

/** A drawable layer, already rendered. */
export type Layer =
  | { kind: 'color'; color: Rgba }
  | { kind: 'image'; dataUrl: string }
  | { kind: 'svg'; svg: string }

function layerMarkup(layer: Layer, size: number, inset = 0): string {
  const box = `x="${inset}" y="${inset}" width="${size - inset * 2}" height="${size - inset * 2}"`
  if (layer.kind === 'color') {
    return `<rect width="${size}" height="${size}" fill="${layer.color.hex}"${layer.color.alpha < 1 ? ` fill-opacity="${layer.color.alpha}"` : ''}/>`
  }
  if (layer.kind === 'image') return `<image ${box} href="${layer.dataUrl}" preserveAspectRatio="xMidYMid meet"/>`
  // Nest the vector's own <svg>: drop its intrinsic size, then position it in the layer box.
  const sizeless = layer.svg.replace(/ width="[^"]*" height="[^"]*"/, '')
  return sizeless.replace(/^<svg /, `<svg ${box} preserveAspectRatio="xMidYMid meet" `)
}

/**
 * Compose an adaptive icon (108×108 dp canvas, visible centre 72×72) into one SVG.
 * `fgInset` is extra padding (dp) declared by <inset> foregrounds.
 */
export function composeAdaptiveIcon(background: Layer | null, foreground: Layer | null, fgInset = 0): string {
  const parts = [
    background ? layerMarkup(background, 108) : '<rect width="108" height="108" fill="#ffffff"/>',
    foreground ? layerMarkup(foreground, 108, fgInset) : ''
  ]
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="18 18 72 72" width="96" height="96">${parts.join('')}</svg>`
}

export function svgDataUrl(svg: string): string {
  return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64')
}
