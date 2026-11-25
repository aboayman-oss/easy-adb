// Wireless debugging QR pairing payloads (Android 11+).
//
// Android's "Pair device with QR code" scanner expects the Wi-Fi QR format used by
// Android Studio: WIFI:T:ADB;S:<service name>;P:<password>;;
// After scanning, the phone advertises `<service name>._adb-tls-pairing._tcp` via mDNS.

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'

/** Escape the characters that are special inside the WIFI: QR format. */
export function escapeWifiQrField(value: string): string {
  return value.replace(/([\\;,:"])/g, '\\$1')
}

export function buildAdbPairingQrPayload(serviceName: string, password: string): string {
  if (!serviceName) throw new Error('serviceName is required')
  if (!password) throw new Error('password is required')
  return `WIFI:T:ADB;S:${escapeWifiQrField(serviceName)};P:${escapeWifiQrField(password)};;`
}

/** Parse a payload back into its parts (used by tests and for diagnostics). */
export function parseAdbPairingQrPayload(payload: string): { serviceName: string; password: string } | null {
  if (!payload.startsWith('WIFI:') || !payload.endsWith(';;')) return null
  const body = payload.slice(5, -1)
  const fields: Record<string, string> = {}
  let key = ''
  let value = ''
  let inKey = true
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === '\\' && i + 1 < body.length) {
      if (inKey) key += body[++i]
      else value += body[++i]
      continue
    }
    if (inKey && ch === ':') {
      inKey = false
      continue
    }
    if (!inKey && ch === ';') {
      fields[key] = value
      key = ''
      value = ''
      inKey = true
      continue
    }
    if (inKey) key += ch
    else value += ch
  }
  if (fields.T !== 'ADB' || !fields.S || !fields.P) return null
  return { serviceName: fields.S, password: fields.P }
}

function randomString(length: number, randomBytes: (n: number) => Uint8Array): string {
  const bytes = randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length]
  return out
}

export function generatePairingCredentials(randomBytes: (n: number) => Uint8Array): {
  serviceName: string
  password: string
} {
  return {
    serviceName: `easyadb-${randomString(8, randomBytes)}`,
    password: randomString(12, randomBytes)
  }
}
