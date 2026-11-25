// Interprets Windows Plug-and-Play entries for Android phones (pure, unit-tested).
import type { UsbPhone } from '@shared/types'

/** USB vendor IDs of common Android phone makers. */
export const ANDROID_VENDORS: Record<string, string> = {
  '18D1': 'Google',
  '04E8': 'Samsung',
  '2717': 'Xiaomi',
  '22B8': 'Motorola',
  '2A70': 'OnePlus',
  '22D9': 'OPPO / realme',
  '12D1': 'Huawei',
  '0BB4': 'HTC',
  '1004': 'LG',
  '0FCE': 'Sony',
  '05C6': 'Qualcomm',
  '2D95': 'vivo',
  '0E8D': 'MediaTek',
  '19D2': 'ZTE',
  '17EF': 'Lenovo',
  '2916': 'Yota',
  '1949': 'Amazon',
  '2E04': 'HMD / Nokia',
  '0B05': 'ASUS',
  '29A9': 'Nothing'
}

/** Which brand guide (see renderer data/brands.ts) fits a vendor. */
const BRAND_GUIDE: Record<string, string> = {
  '04E8': 'samsung',
  '18D1': 'pixel',
  '2717': 'xiaomi',
  '22B8': 'motorola',
  '2A70': 'oppo',
  '22D9': 'oppo'
}

export interface PnpRow {
  Name?: string | null
  PNPDeviceID?: string | null
  Status?: string | null
  ConfigManagerErrorCode?: number | null
  PNPClass?: string | null
}

/** Group the PnP entries of each phone (same vendor+product) into one summary. */
export function parseUsbPhones(rows: PnpRow[]): UsbPhone[] {
  const groups = new Map<string, PnpRow[]>()
  for (const row of rows) {
    const m = /VID_([0-9A-F]{4})&PID_([0-9A-F]{4})/i.exec(row.PNPDeviceID ?? '')
    if (!m) continue
    const vid = m[1].toUpperCase()
    if (!ANDROID_VENDORS[vid]) continue
    const key = `${vid}:${m[2].toUpperCase()}`
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  const phones: UsbPhone[] = []
  for (const [key, list] of groups) {
    const vid = key.slice(0, 4)
    const wpd = list.find((r) => (r.PNPClass ?? '').toUpperCase() === 'WPD' && r.Name)
    const composite = list.find((r) => /^USB\\VID_[0-9A-F]{4}&PID_[0-9A-F]{4}\\[^&\\]+$/i.test(r.PNPDeviceID ?? ''))
    const serial = composite?.PNPDeviceID?.split('\\').pop()
    const adbInterface = list.some(
      (r) => /ADB Interface/i.test(r.Name ?? '') || /AndroidUsbDeviceClass/i.test(r.PNPClass ?? '') || /&ADB(\\|&|$)/i.test(r.PNPDeviceID ?? '')
    )
    const problem = list.find((r) => (r.ConfigManagerErrorCode ?? 0) !== 0)
    phones.push({
      key,
      vendor: ANDROID_VENDORS[vid],
      brandId: BRAND_GUIDE[vid] ?? 'other',
      // The MTP entry carries the phone's own name ("Sam's Galaxy S24").
      name: (wpd?.Name ?? composite?.Name ?? `${ANDROID_VENDORS[vid]} phone`).trim(),
      serial: serial && !/&/.test(serial) ? serial : undefined,
      adbInterface,
      driverProblem: problem ? (problem.Name ?? 'Unknown device').trim() : undefined
    })
  }
  return phones
}
