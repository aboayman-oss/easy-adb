// Gathers device details (model, Android version, battery, storage, memory) in one shell round-trip.
import type { BatteryInfo, DeviceDetails } from '@shared/types'
import { friendlyBrand, marketingName } from '../lib/deviceNames'
import {
  parseBatterySysfs,
  parseDf,
  parseDiskstats,
  parseDumpsysBattery,
  parseGetprop,
  parseMeminfo,
  parseWmDensity,
  parseWmSize
} from '../lib/parsers'
import { shell } from './runner'
import { rememberFriendlyName, requireOnline } from './tracker'

const MARK = '___EASYADB_SECTION___'

const SYSFS_PROBE =
  'for f in cycle_count battery_cycle charge_full charge_full_design battery_health_percent; do ' +
  'v=$(cat /sys/class/power_supply/battery/$f 2>/dev/null) && echo "$f=$v"; done'

function sections(text: string, count: number): string[] {
  const parts = text.split(MARK)
  while (parts.length < count) parts.push('')
  return parts.map((p) => p.trim())
}

export async function readBattery(serial: string): Promise<BatteryInfo> {
  requireOnline(serial)
  const text = await shell(serial, `dumpsys battery; echo ${MARK}; ${SYSFS_PROBE}`, { timeoutMs: 15_000 })
  const [battery, sysfs] = sections(text, 2)
  const info = parseDumpsysBattery(battery)
  const extra = parseBatterySysfs(sysfs)
  return {
    ...info,
    cycleCount: info.cycleCount ?? extra.cycleCount,
    capacityHealthPercent: extra.capacityHealthPercent
  }
}

export async function readDetails(serial: string): Promise<DeviceDetails> {
  requireOnline(serial)
  const script = [
    'getprop',
    'dumpsys battery',
    SYSFS_PROBE,
    'cat /proc/meminfo',
    'df -k /data',
    'wm density',
    'wm size',
    'cat /proc/uptime',
    'dumpsys diskstats 2>/dev/null | head -n 40'
  ].join(`; echo ${MARK}; `)

  const text = await shell(serial, script, { timeoutMs: 25_000 })
  const [propsText, batteryText, sysfsText, memText, dfText, densityText, sizeText, uptimeText, diskText] = sections(text, 9)

  const props = parseGetprop(propsText)
  const battery = parseDumpsysBattery(batteryText)
  const sysfs = parseBatterySysfs(sysfsText)
  const df = parseDf(dfText)
  const breakdown = parseDiskstats(diskText)
  const density = parseWmDensity(densityText)
  const size = parseWmSize(sizeText)
  const uptime = Number(uptimeText.split(/\s+/)[0])

  const sdk = Number(props['ro.build.version.sdk'] ?? 0)
  const abiList = (props['ro.product.cpu.abilist'] || props['ro.product.cpu.abi'] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  rememberFriendlyName(props['ro.product.model'], marketingName(props))
  return {
    serial,
    manufacturer: props['ro.product.manufacturer'] ?? '',
    brand: friendlyBrand(props),
    model: props['ro.product.model'] ?? serial,
    marketingName: marketingName(props),
    androidVersion: props['ro.build.version.release_or_codename'] || props['ro.build.version.release'] || '?',
    sdk,
    securityPatch: props['ro.build.version.security_patch'] || undefined,
    abiList,
    battery: {
      ...battery,
      cycleCount: battery.cycleCount ?? sysfs.cycleCount,
      capacityHealthPercent: sysfs.capacityHealthPercent
    },
    storage: df
      ? { totalBytes: df.totalBytes, usedBytes: df.usedBytes, freeBytes: df.freeBytes, breakdown }
      : undefined,
    memory: parseMeminfo(memText),
    screen:
      size && density
        ? { width: size.width, height: size.height, density: density.override ?? density.physical, physicalDensity: density.physical }
        : undefined,
    uptimeSeconds: Number.isFinite(uptime) ? Math.round(uptime) : undefined
  }
}

/** Cached device ABI + density, used to pick split APKs. */
const configCache = new Map<string, { abis: string[]; densityDpi: number; sdk: number }>()

export async function deviceConfig(serial: string): Promise<{ abis: string[]; densityDpi: number; sdk: number }> {
  const cached = configCache.get(serial)
  if (cached) return cached
  const text = await shell(serial, `getprop ro.product.cpu.abilist; echo ${MARK}; wm density; echo ${MARK}; getprop ro.build.version.sdk`)
  const [abis, density, sdk] = sections(text, 3)
  const d = parseWmDensity(density)
  const cfg = {
    abis: abis.split(',').map((s) => s.trim()).filter(Boolean),
    densityDpi: d?.physical ?? 420,
    sdk: Number(sdk) || 0
  }
  configCache.set(serial, cfg)
  return cfg
}
