// Windows: notices Android phones plugged in over USB, even when USB debugging is off,
// so the Connect screen can say "your phone is connected — now turn on USB debugging".
// One idle PowerShell process waits for Windows device-change events (no polling).
import { spawn, type ChildProcess } from 'node:child_process'
import type { UsbPhone } from '@shared/types'
import { ANDROID_VENDORS, parseUsbPhones, type PnpRow } from '../lib/usbPhones'
import { trackChild } from '../adb/runner'
import { emit } from '../services/events'

let child: ChildProcess | null = null
let watchers = 0
let latest: UsbPhone[] = []
let stopTimer: NodeJS.Timeout | null = null

function script(): string {
  const vids = Object.keys(ANDROID_VENDORS).join('|')
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    'function Snap {',
    `  $r = @(Get-CimInstance Win32_PnPEntity -Filter "PNPDeviceID LIKE 'USB%'" | Where-Object { $_.PNPDeviceID -match 'VID_(${vids})' } | Select-Object Name, PNPDeviceID, Status, ConfigManagerErrorCode, PNPClass)`,
    "  [Console]::Out.WriteLine('@@SNAP ' + (ConvertTo-Json -InputObject $r -Compress -Depth 2))",
    '  [Console]::Out.Flush()',
    '}',
    'Snap',
    'Register-WmiEvent -Class Win32_DeviceChangeEvent -SourceIdentifier easyadb | Out-Null',
    'while ($true) {',
    '  Wait-Event -SourceIdentifier easyadb | Out-Null',
    '  Start-Sleep -Milliseconds 700',
    '  Get-Event | Remove-Event',
    '  Snap',
    '}'
  ].join('\n')
}

function handleSnapshot(json: string): void {
  try {
    const parsed = JSON.parse(json) as PnpRow[] | PnpRow | null
    const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : []
    const phones = parseUsbPhones(rows)
    if (JSON.stringify(phones) === JSON.stringify(latest)) return
    latest = phones
    emit('usb:phones', phones)
  } catch {
    /* ignore malformed output */
  }
}

function start(): void {
  if (child || process.platform !== 'win32') return
  const encoded = Buffer.from(script(), 'utf16le').toString('base64')
  const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore']
  })
  trackChild(proc)
  child = proc
  let buffer = ''
  proc.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (line.startsWith('@@SNAP ')) handleSnapshot(line.slice(7))
    }
  })
  proc.on('close', () => {
    if (child === proc) child = null
  })
}

function stop(): void {
  child?.kill()
  child = null
  latest = []
}

/** Reference-counted: the Connect screen turns watching on while it's open. */
export function setUsbWatch(on: boolean): UsbPhone[] {
  if (process.platform !== 'win32') return []
  if (on) {
    watchers++
    if (stopTimer) {
      clearTimeout(stopTimer)
      stopTimer = null
    }
    start()
  } else {
    watchers = Math.max(0, watchers - 1)
    if (watchers === 0 && !stopTimer) {
      // Keep it briefly in case the screen re-opens right away.
      stopTimer = setTimeout(() => {
        stopTimer = null
        if (watchers === 0) stop()
      }, 15_000)
    }
  }
  return latest
}

export function stopUsbWatch(): void {
  watchers = 0
  stop()
}
