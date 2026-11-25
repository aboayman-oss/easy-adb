// Live device tracking via the adb server's push-based "track-devices" service.
import type { DeviceSummary } from '@shared/types'
import { hasAdb } from '../engine/paths'
import { MARKET_NAME_PROPS, marketingName } from '../lib/deviceNames'
import { dedupeWifiDevices, parseHostPort, serialFromMdnsName } from '../lib/devices'
import { parseDeviceList, parseMdnsServices, TrackDevicesDecoder } from '../lib/parsers'
import { emit } from '../services/events'
import { getSettings, updateSettings } from '../services/settings'
import { logInfo, logSuccess, logWarn } from '../services/log'
import { AdbSocket, forgetFeatures, hostQuery, isServerRunning } from './host'
import { adb } from './runner'

type Listener = (devices: DeviceSummary[], previous: DeviceSummary[]) => void

const MARK = '___EASYADB_SECTION___'

/** Every transport adb reports (used for commands). */
let devices: DeviceSummary[] = []
let socket: AdbSocket | null = null
let stopped = true
let retryTimer: NodeJS.Timeout | null = null
let retryDelay = 500
let serverStartedByUs = false
let serverWasRunningAtLaunch: boolean | null = null
const listeners = new Set<Listener>()

/** transport serial → hardware serial number (ro.serialno), for Wi-Fi transports. */
const hardwareSerials = new Map<string, string>()
/** hardware serial → last known Wi-Fi address, so phones can be reconnected right after a server restart. */
const wifiAddresses = new Map<string, { host: string; port: number; name?: string }>()
const wifiLearnedListeners = new Set<(info: { host: string; port: number; name?: string }) => void>()

/** Devices as shown to the user (duplicate Wi-Fi transports of the same phone hidden). */
export function currentDevices(): DeviceSummary[] {
  return dedupeWifiDevices(devices, hardwareSerials)
}

export function onWifiDeviceLearned(listener: (info: { host: string; port: number; name?: string }) => void): () => void {
  wifiLearnedListeners.add(listener)
  return () => wifiLearnedListeners.delete(listener)
}

const learning = new Set<string>()

/** Record a Wi-Fi phone's hardware serial and address (in the background). */
async function learnWifiDevice(d: DeviceSummary): Promise<void> {
  if (d.transport !== 'wifi' || d.state !== 'device' || learning.has(d.serial) || hardwareSerials.has(d.serial)) return
  learning.add(d.serial)
  try {
    const res = await adb(
      ['shell', `getprop ro.serialno; echo ${MARK}; getprop ro.product.model; echo ${MARK}; ${MARKET_NAME_PROPS.map((p) => `getprop ${p}`).join('; ')}`],
      { serial: d.serial, log: false, allowFailure: true, timeoutMs: 10_000 }
    )
    const [serialno = '', model = '', market = ''] = res.stdout.split(MARK).map((s) => s.trim())
    const hw = serialFromMdnsName(d.serial) ?? (serialno || undefined)
    const friendly = market.split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? marketingName({ 'ro.product.model': model }) ?? (model || d.model)
    if (hw) hardwareSerials.set(d.serial, hw)
    rememberFriendlyName(model || d.model, friendly)
    let address = parseHostPort(d.serial)
    if (!address) {
      const res = await adb(['mdns', 'services'], { log: false, allowFailure: true, timeoutMs: 8000 })
      const svc = parseMdnsServices(res.stdout).find((s) => d.serial.startsWith(s.instance + '.'))
      if (svc) address = { host: svc.host, port: svc.port }
    }
    if (address) {
      const info = { ...address, name: friendly }
      wifiAddresses.set(hw ?? d.serial, info)
      for (const l of wifiLearnedListeners) l(info)
    }
    emit('devices:changed', currentDevices())
    void tidyDuplicateTransports()
  } catch {
    /* best effort */
  } finally {
    learning.delete(d.serial)
  }
}

/** After Easy ADB restarts the adb server, reconnect Wi-Fi phones right away instead of waiting for mDNS. */
/** Hosts of Wi-Fi phones the adb server is connected to right now (asks the server directly). */
async function connectedWifiHosts(): Promise<Set<string>> {
  const hosts = new Set<string>()
  const fresh = parseDeviceList(await hostQuery('host:devices-l')).filter((d) => d.transport === 'wifi')
  const named: DeviceSummary[] = []
  for (const d of fresh) {
    const hp = parseHostPort(d.serial)
    if (hp) hosts.add(hp.host)
    else named.push(d)
  }
  if (named.length) {
    for (const d of named) {
      const hw = serialFromMdnsName(d.serial)
      const known = hw ? wifiAddresses.get(hw) : undefined
      if (known) hosts.add(known.host)
    }
    const res = await adb(['mdns', 'services'], { log: false, allowFailure: true, timeoutMs: 8000 }).catch(() => null)
    for (const s of parseMdnsServices(res?.stdout ?? '')) {
      if (named.some((d) => d.serial.startsWith(s.instance + '.'))) hosts.add(s.host)
    }
  }
  return hosts
}

/** "host:port" transports Easy ADB opened itself (closed again once adb's own mDNS link appears). */
const createdByReconnect = new Set<string>()
let isBusy: (serial: string) => boolean = () => false

export function setBusyCheck(fn: (serial: string) => boolean): void {
  isBusy = fn
}

/**
 * Reconnect Wi-Fi phones after Easy ADB (re)started the adb server. adb's own mDNS
 * usually reconnects within seconds but sometimes takes minutes, so wait briefly and
 * then connect by address.
 */
export async function reconnectKnownWifi(graceMs = 6000): Promise<void> {
  // Phones seen this session, plus phones remembered in the last week.
  const targets = new Map<string, { host: string; port: number; name?: string }>()
  for (const a of wifiAddresses.values()) targets.set(a.host, a)
  for (const r of getSettings().rememberedDevices) {
    if (Date.now() - r.lastConnected > 7 * 24 * 3600_000 || targets.has(r.host)) continue
    targets.set(r.host, { host: r.host, port: r.port, name: r.name })
  }
  if (!targets.size) return
  let pending = [...targets.values()]
  const deadline = Date.now() + graceMs
  for (;;) {
    try {
      const hosts = await connectedWifiHosts()
      pending = pending.filter((t) => !hosts.has(t.host))
    } catch {
      return // server not reachable
    }
    if (!pending.length || Date.now() >= deadline) break
    await new Promise((r) => setTimeout(r, 750))
  }
  await Promise.all(
    pending.map(async (a) => {
      const target = `${a.host}:${a.port}`
      const res = await adb(['connect', target], { allowFailure: true, timeoutMs: 15_000, log: `Reconnecting ${a.name ?? 'phone'} over Wi-Fi` }).catch(() => null)
      if (res && /connected to/i.test(res.stdout) && !/failed|unable|cannot/i.test(res.stdout)) {
        createdByReconnect.add(target)
        logSuccess(`Reconnected ${a.name ?? target} over Wi-Fi`)
      }
    })
  )
}

let tidyTimer: NodeJS.Timeout | null = null

/** If adb's own mDNS link to a phone shows up, close the extra address link Easy ADB opened. */
async function tidyDuplicateTransports(): Promise<void> {
  const groups = new Map<string, DeviceSummary[]>()
  for (const d of devices) {
    if (d.transport !== 'wifi' || d.state !== 'device') continue
    const hw = hardwareSerials.get(d.serial) ?? serialFromMdnsName(d.serial)
    if (hw) groups.set(hw, [...(groups.get(hw) ?? []), d])
  }
  let retry = false
  for (const list of groups.values()) {
    if (list.length < 2 || !list.some((d) => serialFromMdnsName(d.serial))) continue
    for (const d of list) {
      if (!createdByReconnect.has(d.serial)) continue
      if (isBusy(d.serial)) {
        retry = true
        continue
      }
      createdByReconnect.delete(d.serial)
      await adb(['disconnect', d.serial], { allowFailure: true, timeoutMs: 10_000, log: 'Closed a duplicate Wi-Fi link to the same phone' }).catch(() => undefined)
    }
  }
  if (retry && !tidyTimer) {
    tidyTimer = setTimeout(() => {
      tidyTimer = null
      void tidyDuplicateTransports()
    }, 30_000)
  }
}

export function onDevicesChanged(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function didWeStartServer(): boolean {
  return serverStartedByUs
}

export async function ensureServer(): Promise<void> {
  if (serverWasRunningAtLaunch === null) serverWasRunningAtLaunch = await isServerRunning()
  if (await isServerRunning()) return
  await adb(['start-server'], { timeoutMs: 20_000, log: 'Started the connection engine' })
  if (!serverWasRunningAtLaunch) serverStartedByUs = true
  // A fresh server can take minutes to rediscover Wi-Fi phones on its own.
  setTimeout(() => void reconnectKnownWifi(), 1000)
}

// Model ("SM S928B" from adb, "SM-S928B" from the phone) → the name people know ("Galaxy S24 Ultra").
// Saved in settings so messages use the right name right after Easy ADB starts.
const modelKey = (model?: string): string => (model ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase()

export function rememberFriendlyName(model: string | undefined, name: string | undefined): void {
  if (!model || !name || modelKey(name) === modelKey(model)) return
  const names = getSettings().phoneNames ?? {}
  if (names[modelKey(model)] === name) return
  updateSettings({ phoneNames: { ...names, [modelKey(model)]: name } })
}

/** The name people know a phone by, given its model code (returns the input if unknown). */
export function friendlyName(nameOrModel: string): string {
  return getSettings().phoneNames?.[modelKey(nameOrModel)] ?? nameOrModel
}

function phoneName(d: DeviceSummary): string {
  return getSettings().phoneNames?.[modelKey(d.model)] ?? d.model ?? 'Android phone'
}

function via(d: DeviceSummary): string {
  return d.transport === 'wifi' ? 'Wi-Fi' : 'USB'
}

function update(next: DeviceSummary[]): void {
  const previous = devices
  devices = next
  // Log what a person cares about: connected, waiting for "Allow", lost, disconnected.
  // Brief in-between states (offline → authorizing → device) aren't worth an entry.
  for (const d of next) {
    const before = previous.find((p) => p.serial === d.serial)
    if (before?.state === d.state) continue
    const detail = { command: `${d.serial} → ${d.state}` }
    if (d.state === 'device') logSuccess(`${phoneName(d)} connected over ${via(d)}`, detail)
    else if (d.state === 'unauthorized') logInfo(`${phoneName(d)} is waiting for you to tap “Allow” on the phone`, detail)
    else if (before?.state === 'device') logInfo(`${phoneName(d)} lost its ${via(d)} connection`, detail)
  }
  for (const p of previous) {
    if (!next.find((d) => d.serial === p.serial)) {
      if (p.state === 'device') logWarn(`${phoneName(p)} disconnected (${via(p)})`, { command: p.serial })
      forgetFeatures(p.serial)
      hardwareSerials.delete(p.serial)
    }
  }
  for (const d of next) void learnWifiDevice(d)
  emit('devices:changed', currentDevices())
  for (const l of listeners) {
    try {
      l(next, previous)
    } catch {
      /* listener errors must not break tracking */
    }
  }
}

async function connectOnce(): Promise<void> {
  await ensureServer()
  const sock = await AdbSocket.open()
  try {
    await sock.request('host:track-devices-l')
  } catch {
    sock.close()
    const fallback = await AdbSocket.open()
    await fallback.request('host:track-devices')
    return attach(fallback)
  }
  attach(sock)
}

function attach(sock: AdbSocket): void {
  socket = sock
  retryDelay = 500
  const decoder = new TrackDevicesDecoder()
  sock.stream((chunk) => {
    for (const frame of decoder.push(chunk)) update(frame)
  })
  const onGone = (): void => {
    if (socket !== sock) return
    socket = null
    if (devices.length) update([])
    scheduleReconnect()
  }
  sock.onClose(onGone)
}

function scheduleReconnect(): void {
  if (stopped || retryTimer) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    void start()
  }, retryDelay)
  retryDelay = Math.min(retryDelay * 2, 5000)
}

export async function start(): Promise<void> {
  stopped = false
  if (socket || !hasAdb()) return
  try {
    await connectOnce()
  } catch (e) {
    logWarn(`Connection engine not reachable, retrying… (${e instanceof Error ? e.message : e})`)
    scheduleReconnect()
  }
}

export function stop(): void {
  stopped = true
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
  socket?.close()
  socket = null
}

export async function restartServer(): Promise<void> {
  stop()
  await adb(['kill-server'], { allowFailure: true, timeoutMs: 10_000, log: 'Stopped the connection engine' })
  serverStartedByUs = false
  await new Promise((r) => setTimeout(r, 500))
  await adb(['start-server'], { timeoutMs: 20_000, log: 'Restarted the connection engine' })
  serverStartedByUs = true
  await start()
  await reconnectKnownWifi()
}

/** Called after Easy ADB itself had to stop the server (e.g. to update the engine files). */
export function markServerRestartedByUs(): void {
  serverStartedByUs = false
  serverWasRunningAtLaunch = false
}

/** Kill the adb server only if Easy ADB started it (don't disturb other tools). */
export async function shutdownServerIfOurs(): Promise<void> {
  stop()
  if (!serverStartedByUs || !hasAdb()) return
  await adb(['kill-server'], { allowFailure: true, timeoutMs: 5000, log: false }).catch(() => undefined)
}

export async function waitForDevice(predicate: (d: DeviceSummary) => boolean, timeoutMs: number): Promise<DeviceSummary | null> {
  const hit = devices.find(predicate)
  if (hit) return hit
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      off()
      resolve(null)
    }, timeoutMs)
    const off = onDevicesChanged((list) => {
      const found = list.find(predicate)
      if (found) {
        clearTimeout(timer)
        off()
        resolve(found)
      }
    })
  })
}

export function requireOnline(serial: string): DeviceSummary {
  const d = devices.find((x) => x.serial === serial)
  if (!d) throw new Error(`device '${serial}' not found`)
  if (d.state === 'unauthorized') throw new Error('device unauthorized')
  if (d.state !== 'device') throw new Error('device offline')
  return d
}
