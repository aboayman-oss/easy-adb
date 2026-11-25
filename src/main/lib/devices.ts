// Pure helpers for reconciling adb transports that point at the same phone.
import type { DeviceSummary } from '@shared/types'

/**
 * adb names mDNS-connected phones "adb-<serialno>-<random>._adb-tls-connect._tcp".
 * Returns the hardware serial number embedded in that name.
 */
export function serialFromMdnsName(serial: string): string | undefined {
  const m = /^adb-(.+)-[A-Za-z0-9]+\._adb-tls-connect\._tcp\.?$/.exec(serial)
  return m?.[1]
}

/** "192.168.1.23:34197" → host/port. */
export function parseHostPort(serial: string): { host: string; port: number } | undefined {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d+)$/.exec(serial)
  return m ? { host: m[1], port: Number(m[2]) } : undefined
}

/**
 * The same phone can be connected twice over Wi-Fi (by IP and by its mDNS name).
 * Keep the first transport per hardware serial number; USB transports are never hidden.
 */
export function dedupeWifiDevices(devices: DeviceSummary[], hardwareSerials: Map<string, string>): DeviceSummary[] {
  const seen = new Set<string>()
  const out: DeviceSummary[] = []
  for (const d of devices) {
    if (d.transport !== 'wifi' || d.state !== 'device') {
      out.push(d)
      continue
    }
    const hw = hardwareSerials.get(d.serial) ?? serialFromMdnsName(d.serial)
    if (hw && seen.has(hw)) continue
    if (hw) seen.add(hw)
    out.push(d)
  }
  return out
}
