// Windows USB driver helper: detects Android devices with driver problems and can
// install Google's official USB driver (elevated, via pnputil).
import { execFile } from 'node:child_process'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { DriverCheckResult, DriverProblemDevice } from '@shared/types'
import { downloadFile, extractZip } from '../engine/download'
import { engineDir } from '../engine/paths'
import { AppError } from '../lib/errors'
import { ANDROID_VENDORS } from '../lib/usbPhones'
import { logInfo, logSuccess } from '../services/log'

const VENDORS = ANDROID_VENDORS

const GOOGLE_USB_DRIVER_URL = 'https://dl.google.com/android/repository/usb_driver_r13-windows.zip'

function powershell(script: string, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    )
  })
}

interface PnpRow {
  FriendlyName?: string
  InstanceId?: string
  Status?: string
  Class?: string
}

export async function checkDrivers(): Promise<DriverCheckResult> {
  if (process.platform !== 'win32') return { supported: false, problemDevices: [], androidUsbDevices: 0 }
  const vids = Object.keys(VENDORS).join('|')
  const script =
    `$d = Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -match 'USB\\\\VID_(${vids})' }; ` +
    `$d | Select-Object FriendlyName, InstanceId, Status, Class | ConvertTo-Json -Compress`
  let rows: PnpRow[] = []
  try {
    const out = (await powershell(script)).trim()
    if (out) {
      const parsed = JSON.parse(out) as PnpRow | PnpRow[]
      rows = Array.isArray(parsed) ? parsed : [parsed]
    }
  } catch {
    return { supported: true, problemDevices: [], androidUsbDevices: 0 }
  }
  const problemDevices: DriverProblemDevice[] = rows
    .filter((r) => r.Status && r.Status !== 'OK')
    .map((r) => {
      const vid = /VID_([0-9A-F]{4})/i.exec(r.InstanceId ?? '')?.[1]?.toUpperCase()
      return {
        name: r.FriendlyName || 'Unknown Android device',
        instanceId: r.InstanceId ?? '',
        status: r.Status ?? 'Unknown',
        vendor: vid ? VENDORS[vid] : undefined
      }
    })
  const unique = new Set(rows.map((r) => /USB\\VID_[0-9A-F]{4}&PID_[0-9A-F]{4}\\[^\\]+/i.exec(r.InstanceId ?? '')?.[0] ?? r.InstanceId))
  return { supported: true, problemDevices, androidUsbDevices: unique.size }
}

function findInf(dir: string): string | null {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      const hit = findInf(full)
      if (hit) return hit
    } else if (name.toLowerCase() === 'android_winusb.inf') return full
  }
  return null
}

/** True when Windows' driver store contains Google's android_winusb.inf package. */
function googleDriverRegistered(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('pnputil.exe', ['/enum-drivers'], { windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (_err, stdout) => {
      resolve(/android_winusb\.inf/i.test(stdout ?? ''))
    })
  })
}

/** Download Google's USB driver and install it with administrator rights (UAC prompt). */
export async function installGoogleUsbDriver(): Promise<string> {
  if (process.platform !== 'win32') throw new AppError({ title: 'Windows only', message: 'USB drivers are only needed on Windows.' })
  const base = join(engineDir(), 'usb_driver')
  const zip = join(engineDir(), 'usb_driver.zip')
  rmSync(base, { recursive: true, force: true })
  logInfo('Downloading Google USB driver', { command: GOOGLE_USB_DRIVER_URL })
  await downloadFile(GOOGLE_USB_DRIVER_URL, zip)
  await extractZip(zip, base)
  rmSync(zip, { force: true })
  const inf = findInf(base)
  if (!inf || !existsSync(inf)) throw new AppError({ title: 'Driver package incomplete', message: 'The downloaded driver package looks incomplete.' })
  const escaped = inf.replace(/'/g, "''")
  const script =
    `$p = Start-Process -FilePath 'pnputil.exe' -ArgumentList @('/add-driver', '"${escaped}"', '/install') ` +
    `-Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode`
  let exitCode = 0
  try {
    await powershell(script, 180_000)
  } catch (e) {
    const err = e as Error & { code?: number | string; killed?: boolean }
    if (/canceled|cancelled|1223/i.test(err.message)) {
      throw new AppError({ title: 'Installation cancelled', message: 'Windows needs administrator permission to install the driver.', code: 'CANCELLED' })
    }
    if (err.killed) {
      throw new AppError({
        title: 'No answer from Windows',
        message: 'The Windows permission prompt wasn’t answered in time.',
        hint: 'Try again and click “Yes” when Windows asks.'
      })
    }
    exitCode = typeof err.code === 'number' ? err.code : -1
  }
  // pnputil: 0 = installed on a device, 259 = added to Windows but no matching phone plugged in, 3010 = restart needed.
  if (![0, 259, 3010].includes(exitCode)) {
    throw new AppError({ title: 'Driver install failed', message: `Windows couldn’t install the driver (error ${exitCode}).`, hint: 'Open the Activity Log for details.' })
  }
  if (!(await googleDriverRegistered())) {
    throw new AppError({ title: 'Driver not installed', message: 'Windows didn’t register the Google USB driver.' })
  }
  const message =
    exitCode === 3010
      ? 'Google USB driver installed. Restart Windows to finish.'
      : exitCode === 259
        ? 'Google USB driver added. Windows will use it when a matching phone is plugged in.'
        : 'Google USB driver installed. Reconnect your phone.'
  logSuccess(message, { command: `pnputil /add-driver android_winusb.inf /install → exit ${exitCode}` })
  return message
}
