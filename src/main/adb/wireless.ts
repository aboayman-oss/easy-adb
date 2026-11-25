// Wireless debugging: QR-code pairing (Android 11+), manual pairing, remembered devices
// and the classic "switch this USB phone to Wi-Fi" (adb tcpip).
import { randomBytes, randomUUID } from 'node:crypto'
import { Bonjour, type Browser, type Service } from 'bonjour-service'
import QRCode from 'qrcode'
import type { PairingStatus, QrPairingSession, RememberedDevice } from '@shared/types'
import { parseHostPort } from '../lib/devices'
import { AppError } from '../lib/errors'
import { parseMdnsServices, parseWifiIp, type MdnsService } from '../lib/parsers'
import { buildAdbPairingQrPayload, generatePairingCredentials } from '../lib/qr'
import { emit } from '../services/events'
import { logError, logInfo, logSuccess } from '../services/log'
import { getSettings, updateSettings } from '../services/settings'
import { adb, shell } from './runner'
import { currentDevices, friendlyName, onWifiDeviceLearned, requireOnline, waitForDevice } from './tracker'

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/
const HOST_RE = /^[A-Za-z0-9.\-:[\]]+$/

function validateHost(host: string, port: number): void {
  if (!HOST_RE.test(host) || host.length > 255) throw new AppError({ title: 'Invalid address', message: 'Check the IP address and try again.' })
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AppError({ title: 'Invalid port', message: 'The port must be a number between 1 and 65535.' })
}

// ---------------------------------------------------------------------------
// mDNS discovery (own browser + adb's built-in discovery)

let bonjour: Bonjour | null = null

function getBonjour(): Bonjour | null {
  if (bonjour) return bonjour
  try {
    bonjour = new Bonjour()
  } catch {
    bonjour = null
  }
  return bonjour
}

function serviceAddress(s: Service): string | undefined {
  const v4 = (s.addresses ?? []).find((a) => IPV4.test(a))
  return v4 ?? s.referer?.address ?? s.addresses?.[0]
}

async function adbMdnsServices(): Promise<MdnsService[]> {
  try {
    const res = await adb(['mdns', 'services'], { log: false, allowFailure: true, timeoutMs: 8000 })
    return parseMdnsServices(res.stdout)
  } catch {
    return []
  }
}

/** Watch for a service by type (and optional instance name) from both discovery sources. */
function watchService(
  type: 'adb-tls-pairing' | 'adb-tls-connect',
  match: (instance: string, host: string) => boolean,
  signal: AbortSignal
): Promise<{ instance: string; host: string; port: number }> {
  return new Promise((resolve, reject) => {
    let browser: Browser | null = null
    let poll: NodeJS.Timeout | null = null
    const done = (v?: { instance: string; host: string; port: number }, err?: Error): void => {
      browser?.stop()
      if (poll) clearInterval(poll)
      signal.removeEventListener('abort', onAbort)
      if (v) resolve(v)
      else reject(err ?? new Error('Cancelled'))
    }
    const onAbort = (): void => done(undefined, new Error('Cancelled'))
    signal.addEventListener('abort', onAbort, { once: true })

    const b = getBonjour()
    if (b) {
      try {
        browser = b.find({ type, protocol: 'tcp' }, (s: Service) => {
          const host = serviceAddress(s)
          if (host && match(s.name, host)) done({ instance: s.name, host, port: s.port })
        })
      } catch {
        browser = null
      }
    }
    const fullType = `_${type}._tcp`
    const tick = async (): Promise<void> => {
      const services = await adbMdnsServices()
      const hit = services.find((s) => s.type.replace(/\.$/, '') === fullType && match(s.instance, s.host))
      if (hit) done({ instance: hit.instance, host: hit.host, port: hit.port })
    }
    poll = setInterval(() => void tick(), 1500)
    void tick()
  })
}

// ---------------------------------------------------------------------------
// Pair / connect primitives

async function pair(host: string, port: number, code: string): Promise<string | undefined> {
  validateHost(host, port)
  const res = await adb(['pair', `${host}:${port}`, code], { allowFailure: true, timeoutMs: 30_000, log: `Pairing with ${host}:${port}` })
  const text = `${res.stdout}\n${res.stderr}`
  if (!/Successfully paired/i.test(text)) {
    throw new AppError({
      title: 'Pairing failed',
      message: /wrong password|failed to pair|protocol fault/i.test(text)
        ? 'The pairing code didn’t match. Codes expire quickly — try a fresh one.'
        : 'Your phone didn’t accept the pairing request.',
      hint: 'Keep the “Pair device” screen open on your phone and make sure both devices are on the same Wi-Fi.'
    })
  }
  return /guid=([^\]\s]+)/.exec(text)?.[1]
}

/** How long to wait for the user to tap "Allow" on the phone's "Allow USB debugging?" prompt. */
const APPROVAL_WAIT_MS = 60_000

export async function connect(host: string, port: number): Promise<string> {
  validateHost(host, port)
  const target = `${host}:${port}`
  const res = await adb(['connect', target], { allowFailure: true, timeoutMs: 20_000, log: `Connecting to ${target}` })
  const text = `${res.stdout}\n${res.stderr}`
  // The phone answered but doesn't trust this computer yet: it is showing the "Allow?" prompt.
  const needsApproval = /failed to authenticate|unauthorized/i.test(text)
  if (!needsApproval && (!/connected to/i.test(text) || /failed|unable|cannot/i.test(text))) {
    throw new AppError({
      title: 'Couldn’t connect',
      message: 'Your phone didn’t answer over Wi-Fi.',
      hint: 'Make sure Wireless debugging is on and both devices are on the same network. The port changes each time Wireless debugging is turned on.'
    })
  }
  const isReady = (d: { serial: string; state: string }): boolean => d.serial === target && d.state === 'device'
  let device = await waitForDevice(isReady, needsApproval ? 1500 : 10_000)
  if (!device && (needsApproval || currentDevices().some((d) => d.serial === target && d.state === 'unauthorized'))) {
    logInfo('Waiting for “Allow” on the phone', { command: `${target} is asking to trust this computer` })
    device = await waitForDevice(isReady, APPROVAL_WAIT_MS)
    if (!device) {
      throw new AppError({
        title: 'Tap “Allow” on your phone',
        message: 'Your phone is asking whether to trust this computer.',
        hint: 'Unlock the phone, tick “Always allow from this computer”, tap Allow, then try again.',
        code: 'NEEDS_APPROVAL'
      })
    }
  }
  remember({ host, port, name: device?.model ?? host })
  logSuccess(`Connected over Wi-Fi to ${device?.model ?? target}`)
  return target
}

function remember(d: { host: string; port: number; name: string; id?: string }): void {
  const list = getSettings().rememberedDevices.filter((r) => r.host !== d.host)
  const entry: RememberedDevice = { id: d.id ?? randomUUID(), name: friendlyName(d.name), host: d.host, port: d.port, lastConnected: Date.now() }
  updateSettings({ rememberedDevices: [entry, ...list].slice(0, 12) })
}

// Phones connected over Wi-Fi by any means (including other tools) become one-click reconnects.
onWifiDeviceLearned((info) => remember({ host: info.host, port: info.port, name: info.name ?? info.host }))

export function rememberedDevices(): RememberedDevice[] {
  return getSettings().rememberedDevices
}

export function forget(id: string): void {
  updateSettings({ rememberedDevices: getSettings().rememberedDevices.filter((r) => r.id !== id) })
}

export async function disconnect(serial: string): Promise<void> {
  await adb(['disconnect', serial], { allowFailure: true, log: `Disconnecting ${serial}` })
}

/** Reconnect a remembered device; if its port changed, rediscover it via mDNS. */
export async function reconnect(host: string, port: number): Promise<string> {
  try {
    return await connect(host, port)
  } catch (e) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 6000)
    try {
      const found = await watchService('adb-tls-connect', (_i, h) => h === host, controller.signal)
      return await connect(found.host, found.port)
    } catch {
      throw e
    } finally {
      clearTimeout(timer)
    }
  }
}

export async function discoverConnectable(): Promise<{ name: string; host: string; port: number }[]> {
  const services = await adbMdnsServices()
  return services
    .filter((s) => s.type.startsWith('_adb-tls-connect'))
    .map((s) => ({ name: s.instance, host: s.host, port: s.port }))
}

// ---------------------------------------------------------------------------
// QR pairing session

const qrSessions = new Map<string, AbortController>()

function status(s: PairingStatus): void {
  emit('wireless:pairing', s)
}

export async function startQrPairing(): Promise<QrPairingSession> {
  // Only one QR session at a time.
  for (const c of qrSessions.values()) c.abort()
  qrSessions.clear()

  const { serviceName, password } = generatePairingCredentials((n) => randomBytes(n))
  const payload = buildAdbPairingQrPayload(serviceName, password)
  const qrDataUrl = await QRCode.toDataURL(payload, { margin: 1, width: 320, errorCorrectionLevel: 'M' })
  const sessionId = randomUUID()
  const controller = new AbortController()
  qrSessions.set(sessionId, controller)
  const timeout = setTimeout(() => controller.abort(), 5 * 60_000)

  void (async () => {
    try {
      status({ sessionId, phase: 'waiting', message: 'Waiting for your phone to scan the code…' })
      const found = await watchService('adb-tls-pairing', (instance) => instance === serviceName, controller.signal)
      status({ sessionId, phase: 'pairing', message: 'Phone found! Pairing…' })
      logInfo(`Pairing service found at ${found.host}:${found.port}`)
      const guid = await pair(found.host, found.port, password)

      status({ sessionId, phase: 'connecting', message: 'Paired. Connecting…' })
      // adb usually auto-connects paired phones; otherwise find the connect port ourselves.
      const auto = await waitForDevice(
        (d) => d.transport === 'wifi' && d.state === 'device' && ((!!guid && d.serial.includes(guid)) || d.serial.startsWith(found.host + ':')),
        4000
      )
      let serial = auto?.serial
      let connectPort: number | undefined
      if (!serial) {
        const svc = await watchService(
          'adb-tls-connect',
          (instance, host) => (guid ? instance === guid : false) || host === found.host,
          AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)])
        )
        connectPort = svc.port
        serial = await connect(svc.host, svc.port)
      }
      const device = currentDevices().find((d) => d.serial === serial)
      if (!connectPort) {
        const svc = (await discoverConnectable()).find((s) => s.host === found.host)
        connectPort = svc?.port ?? parseHostPort(serial)?.port
      }
      // Otherwise the tracker remembers it as soon as it learns the phone's address.
      if (connectPort) remember({ host: found.host, port: connectPort, name: device?.model ?? 'Android phone' })
      if (auto) logSuccess(`Connected over Wi-Fi to ${device?.model ?? serial}`)
      status({ sessionId, phase: 'connected', message: 'Connected over Wi-Fi!', serial })
    } catch (e) {
      if (controller.signal.aborted) {
        status({ sessionId, phase: 'cancelled', message: 'Pairing stopped.' })
      } else {
        const msg = e instanceof AppError ? e.friendly.message : e instanceof Error ? e.message : String(e)
        logError(`Wireless pairing failed: ${msg}`)
        status({ sessionId, phase: 'error', message: msg })
      }
    } finally {
      clearTimeout(timeout)
      qrSessions.delete(sessionId)
    }
  })()

  return { sessionId, qrDataUrl, payload, serviceName }
}

export function cancelQrPairing(sessionId: string): void {
  qrSessions.get(sessionId)?.abort()
}

/** Manual pairing with the 6-digit code; then try to find and connect automatically. Returns true once connected. */
export async function pairManual(host: string, port: number, code: string): Promise<boolean> {
  if (!/^\d{6}$/.test(code.trim())) throw new AppError({ title: 'Invalid code', message: 'The pairing code has 6 digits.' })
  const guid = await pair(host.trim(), port, code.trim())
  const auto = await waitForDevice((d) => d.transport === 'wifi' && d.state === 'device' && ((!!guid && d.serial.includes(guid)) || d.serial.startsWith(host + ':')), 5000)
  if (auto) {
    // adb connected by itself. Its serial is either host:port or an mDNS name; for the latter
    // the tracker remembers the address once it learns it (the pairing port is not the right one).
    const address = parseHostPort(auto.serial)
    if (address) remember({ host: address.host, port: address.port, name: auto.model ?? host })
    return true
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const svc = await watchService('adb-tls-connect', (instance, h) => (guid ? instance === guid : false) || h === host, controller.signal)
    await connect(svc.host, svc.port)
    return true
  } catch {
    // Pairing worked; the user can still connect with the port shown on the phone.
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** Switch a USB-connected phone to Wi-Fi debugging (adb tcpip 5555 + connect). */
export async function switchToWifi(serial: string): Promise<string> {
  const d = requireOnline(serial)
  if (d.transport === 'wifi') throw new AppError({ title: 'Already wireless', message: 'This phone is already connected over Wi-Fi.' })
  const ipText = await shell(serial, 'ip -f inet addr show wlan0 2>/dev/null; ip route 2>/dev/null')
  const ip = parseWifiIp(ipText)
  if (!ip) {
    throw new AppError({ title: 'Phone isn’t on Wi-Fi', message: 'Connect your phone to the same Wi-Fi network as this computer, then try again.' })
  }
  await adb(['tcpip', '5555'], { serial, log: 'Switched the phone to Wi-Fi mode', timeoutMs: 15_000 })
  await new Promise((r) => setTimeout(r, 2000))
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await connect(ip, 5555)
    } catch (e) {
      // Retrying won't help while the phone waits for the user's approval.
      if (e instanceof AppError && e.friendly.code === 'NEEDS_APPROVAL') throw e
      lastError = e
      await new Promise((r) => setTimeout(r, 1500))
    }
  }
  throw lastError
}

export function shutdownWireless(): void {
  for (const c of qrSessions.values()) c.abort()
  qrSessions.clear()
  try {
    bonjour?.destroy()
  } catch {
    /* ignore */
  }
  bonjour = null
}
