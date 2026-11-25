// Parsers for adb / Android shell output. All functions are pure and unit-tested.
import type {
  BatteryHealth,
  BatteryInfo,
  BatteryStatus,
  DeviceState,
  DeviceSummary,
  MemoryInfo,
  PowerSource,
  StorageBreakdown
} from '@shared/types'

// ---------------------------------------------------------------------------
// adb devices -l / track-devices

const STATE_MAP: Record<string, DeviceState> = {
  device: 'device',
  unauthorized: 'unauthorized',
  offline: 'offline',
  authorizing: 'authorizing',
  connecting: 'connecting',
  recovery: 'recovery',
  sideload: 'sideload',
  bootloader: 'bootloader',
  rescue: 'rescue',
  host: 'unknown',
  unknown: 'unknown'
}

const DEVICE_LINE =
  /^(.+?)\s+(device|unauthorized|offline|authorizing|connecting|recovery|sideload|bootloader|rescue|host|unknown|no permissions)\b(.*)$/

export function isWifiSerial(serial: string): boolean {
  return (
    /^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(serial) ||
    /^\[[0-9a-f:]+\]:\d+$/i.test(serial) ||
    serial.includes('._adb-tls-connect._tcp') ||
    serial.includes('._adb._tcp')
  )
}

/** Parse the body of `adb devices -l` (or one track-devices frame). */
export function parseDeviceList(text: string): DeviceSummary[] {
  const devices: DeviceSummary[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('List of devices') || line.startsWith('*')) continue
    const m = DEVICE_LINE.exec(line)
    if (!m) continue
    const serial = m[1].trim()
    const stateWord = m[2]
    const rest = m[3] ?? ''
    const extras: Record<string, string> = {}
    for (const token of rest.trim().split(/\s+/)) {
      const idx = token.indexOf(':')
      if (idx > 0) extras[token.slice(0, idx)] = token.slice(idx + 1)
    }
    devices.push({
      serial,
      state: stateWord === 'no permissions' ? 'no-permissions' : (STATE_MAP[stateWord] ?? 'unknown'),
      transport: isWifiSerial(serial) ? 'wifi' : 'usb',
      model: extras.model?.replace(/_/g, ' '),
      product: extras.product,
      device: extras.device,
      transportId: extras.transport_id
    })
  }
  return devices
}

/**
 * Incremental decoder for the adb host "track-devices" stream: each message is a
 * 4-digit hex length followed by that many bytes of `adb devices -l` style text.
 */
export class TrackDevicesDecoder {
  private buffer = Buffer.alloc(0)

  push(chunk: Buffer): DeviceSummary[][] {
    this.buffer = Buffer.concat([this.buffer, chunk])
    const frames: DeviceSummary[][] = []
    while (this.buffer.length >= 4) {
      const len = parseInt(this.buffer.subarray(0, 4).toString('ascii'), 16)
      if (Number.isNaN(len)) {
        this.buffer = Buffer.alloc(0)
        break
      }
      if (this.buffer.length < 4 + len) break
      const body = this.buffer.subarray(4, 4 + len).toString('utf8')
      this.buffer = this.buffer.subarray(4 + len)
      frames.push(parseDeviceList(body))
    }
    return frames
  }
}

// ---------------------------------------------------------------------------
// getprop

export function parseGetprop(text: string): Record<string, string> {
  const props: Record<string, string> = {}
  const re = /^\[([^\]]+)\]: \[([\s\S]*?)\]\s*$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) props[m[1]] = m[2]
  return props
}

// ---------------------------------------------------------------------------
// dumpsys battery

/** Parse `key: value` lines into a lower-cased map. */
export function parseKeyValueLines(text: string): Record<string, string> {
  const map: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim().toLowerCase()
    const value = line.slice(idx + 1).trim()
    if (key && !(key in map)) map[key] = value
  }
  return map
}

const BATTERY_STATUS: Record<string, BatteryStatus> = {
  '1': 'unknown',
  '2': 'charging',
  '3': 'discharging',
  '4': 'not-charging',
  '5': 'full'
}

const BATTERY_HEALTH: Record<string, BatteryHealth> = {
  '1': 'unknown',
  '2': 'good',
  '3': 'overheat',
  '4': 'dead',
  '5': 'over-voltage',
  '6': 'failure',
  '7': 'cold'
}

function num(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const n = Number(value.trim().split(/\s+/)[0])
  return Number.isFinite(n) ? n : undefined
}

export function parseDumpsysBattery(text: string): BatteryInfo {
  const kv = parseKeyValueLines(text)
  const level = num(kv['level']) ?? 0
  const scale = num(kv['scale']) ?? 100
  let plugged: PowerSource = 'none'
  if (kv['ac powered'] === 'true') plugged = 'ac'
  else if (kv['usb powered'] === 'true') plugged = 'usb'
  else if (kv['wireless powered'] === 'true') plugged = 'wireless'
  else if (kv['dock powered'] === 'true') plugged = 'dock'

  const rawTemp = num(kv['temperature'])
  const rawVoltage = num(kv['voltage'])
  let voltageV: number | undefined
  if (rawVoltage !== undefined && rawVoltage > 0) {
    if (rawVoltage > 100_000) voltageV = rawVoltage / 1_000_000 // µV
    else if (rawVoltage > 100) voltageV = rawVoltage / 1000 // mV
    else voltageV = rawVoltage // already V
  }

  let cycleCount: number | undefined
  for (const [key, value] of Object.entries(kv)) {
    if (key.includes('cycle')) {
      const n = num(value)
      if (n !== undefined && n >= 0 && n < 100_000) {
        cycleCount = n
        break
      }
    }
  }

  const chargeCounter = num(kv['charge counter'])
  return {
    level: scale > 0 ? Math.round((level / scale) * 100) : level,
    status: BATTERY_STATUS[kv['status'] ?? ''] ?? 'unknown',
    health: BATTERY_HEALTH[kv['health'] ?? ''] ?? 'unknown',
    plugged,
    temperatureC: rawTemp !== undefined ? Math.round(rawTemp) / 10 : undefined,
    voltageV: voltageV !== undefined ? Math.round(voltageV * 100) / 100 : undefined,
    technology: kv['technology'] || undefined,
    cycleCount,
    chargeCounterMah: chargeCounter && chargeCounter > 0 ? Math.round(chargeCounter / 1000) : undefined
  }
}

/**
 * Parse the output of our sysfs probe script: lines of `name=value` collected from
 * /sys/class/power_supply/battery/*. Returns cycle count and capacity health when present.
 */
export function parseBatterySysfs(text: string): { cycleCount?: number; capacityHealthPercent?: number } {
  const values: Record<string, number> = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^([a-z_]+)=(-?\d+)\s*$/.exec(line.trim())
    if (m) values[m[1]] = Number(m[2])
  }
  const cycle = values['cycle_count'] ?? values['battery_cycle'] ?? values['cycle_counts']
  let capacityHealthPercent: number | undefined
  const full = values['charge_full']
  const design = values['charge_full_design']
  if (full && design && design > 0) {
    const pct = Math.round((full / design) * 100)
    if (pct > 20 && pct <= 120) capacityHealthPercent = Math.min(pct, 100)
  } else if (values['battery_health_percent'] !== undefined) {
    capacityHealthPercent = values['battery_health_percent']
  }
  return {
    cycleCount: cycle !== undefined && cycle >= 0 ? cycle : undefined,
    capacityHealthPercent
  }
}

// ---------------------------------------------------------------------------
// memory / storage

export function parseMeminfo(text: string): MemoryInfo {
  const kv = parseKeyValueLines(text)
  const kb = (key: string): number => num(kv[key]?.replace(/kb$/i, '')) ?? 0
  const total = kb('memtotal')
  let available = kb('memavailable')
  if (!available) available = kb('memfree') + kb('cached') + kb('buffers')
  return { totalBytes: total * 1024, availableBytes: available * 1024 }
}

/** Parse `df -k <path>`; returns the row for the requested mount (or the last row). */
export function parseDf(text: string): { totalBytes: number; usedBytes: number; freeBytes: number } | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^filesystem/i.test(l))
  // Some df implementations wrap long filesystem names onto their own line.
  const joined: string[] = []
  for (const line of lines) {
    const tokens = line.split(/\s+/)
    if (tokens.length === 1 && joined.length >= 0) joined.push(line)
    else if (joined.length && joined[joined.length - 1].split(/\s+/).length === 1) joined[joined.length - 1] += ' ' + line
    else joined.push(line)
  }
  for (let i = joined.length - 1; i >= 0; i--) {
    const t = joined[i].split(/\s+/)
    if (t.length < 5) continue
    // [fs, total, used, available, use%, mount]
    const pctIdx = t.findIndex((x) => /^\d+%$/.test(x))
    if (pctIdx < 3) continue
    const total = Number(t[pctIdx - 3])
    const used = Number(t[pctIdx - 2])
    const free = Number(t[pctIdx - 1])
    if ([total, used, free].every(Number.isFinite)) {
      return { totalBytes: total * 1024, usedBytes: used * 1024, freeBytes: free * 1024 }
    }
  }
  return null
}

/** Parse the category sizes from `dumpsys diskstats` (values are bytes). */
export function parseDiskstats(text: string): StorageBreakdown {
  const kv = parseKeyValueLines(text)
  const pick = (key: string): number | undefined => {
    const n = num(kv[key])
    return n !== undefined && n >= 0 ? n : undefined
  }
  // "App Data Size" already includes the cache, so it isn't added separately.
  const appSize = pick('app size')
  const appData = pick('app data size')
  const apps = appSize !== undefined ? appSize + (appData ?? 0) : undefined
  return {
    apps,
    photos: pick('photos size'),
    videos: pick('videos size'),
    audio: pick('audio size'),
    downloads: pick('downloads size'),
    system: pick('system size'),
    other: pick('other size')
  }
}

// ---------------------------------------------------------------------------
// wm density / size

export function parseWmDensity(text: string): { physical: number; override?: number } | null {
  const physical = /Physical density:\s*(\d+)/i.exec(text)
  const override = /Override density:\s*(\d+)/i.exec(text)
  if (!physical) return null
  return { physical: Number(physical[1]), override: override ? Number(override[1]) : undefined }
}

export function parseWmSize(text: string): { width: number; height: number } | null {
  const m = /Override size:\s*(\d+)x(\d+)/i.exec(text) ?? /Physical size:\s*(\d+)x(\d+)/i.exec(text)
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null
}

// ---------------------------------------------------------------------------
// pm list packages

export interface PackageListEntry {
  packageName: string
  apkPath?: string
  versionCode?: number
  uid?: number
  installer?: string
}

/** Parse `pm list packages [-f] [-U] [--show-versioncode] [-i]`. */
export function parsePackageList(text: string): PackageListEntry[] {
  const out: PackageListEntry[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line.startsWith('package:')) continue
    let body = line.slice('package:'.length)
    const entry: PackageListEntry = { packageName: '' }

    // Trailing tokens: versionCode:N  installer=X  uid:N  (any order)
    const tail = /\s+(versionCode:\d+|installer=\S*|uid:\d+(?:,\d+)*)\s*$/
    let m: RegExpExecArray | null
    while ((m = tail.exec(body)) !== null) {
      const token = m[1]
      if (token.startsWith('versionCode:')) entry.versionCode = Number(token.slice(12))
      else if (token.startsWith('installer=')) {
        const inst = token.slice(10)
        entry.installer = inst && inst !== 'null' ? inst : undefined
      } else if (token.startsWith('uid:')) entry.uid = Number(token.slice(4).split(',')[0])
      body = body.slice(0, m.index)
    }

    // `-f` form is "<apk path>=<package>"; apk paths may themselves contain '='.
    // Packages removed for the current user report their path as the literal "null".
    const eq = body.lastIndexOf('=')
    if (eq > 0 && (body.startsWith('/') || body.startsWith('null='))) {
      const path = body.slice(0, eq)
      entry.apkPath = path === 'null' ? undefined : path
      entry.packageName = body.slice(eq + 1)
    } else {
      entry.packageName = body
    }
    if (/^[A-Za-z0-9_.]+$/.test(entry.packageName)) out.push(entry)
  }
  return out
}

// ---------------------------------------------------------------------------
// adb mdns services

export interface MdnsService {
  instance: string
  type: string
  host: string
  port: number
}

export function parseMdnsServices(text: string): MdnsService[] {
  const out: MdnsService[] = []
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('List of')) continue
    const m = /^(.+?)\s+(_adb[\w-]*\._tcp)\.?\s+(\[?[0-9a-fA-F:.]+\]?):(\d+)\s*$/.exec(t)
    if (!m) continue
    out.push({ instance: m[1].trim(), type: m[2], host: m[3].replace(/^\[|\]$/g, ''), port: Number(m[4]) })
  }
  return out
}

// ---------------------------------------------------------------------------
// misc

/** Extract the device's Wi-Fi IPv4 address from `ip -f inet addr show wlan0` or `ip route`. */
export function parseWifiIp(text: string): string | null {
  const inet = /inet\s+(\d{1,3}(?:\.\d{1,3}){3})\/\d+/.exec(text)
  if (inet && !inet[1].startsWith('127.')) return inet[1]
  const src = /src\s+(\d{1,3}(?:\.\d{1,3}){3})/.exec(text)
  return src ? src[1] : null
}

/** Parse `adb version` → "36.0.0-13206524" style revision. */
export function parseAdbVersion(text: string): string | undefined {
  const m = /Version\s+([\d.]+(?:-\w+)?)/.exec(text)
  return m?.[1]
}

export function parseScrcpyVersion(text: string): string | undefined {
  const m = /scrcpy\s+v?([\d.]+)/i.exec(text)
  return m?.[1]
}

/** Compare dotted versions; returns >0 if a > b. Non-numeric suffixes are ignored. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10))
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10))
  for (let i = 0; i < 3; i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0
    const y = Number.isFinite(pb[i]) ? pb[i] : 0
    if (x !== y) return x - y
  }
  return 0
}
