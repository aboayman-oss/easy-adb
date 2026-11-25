import { describe, expect, it } from 'vitest'
import { buildAdbPairingQrPayload, escapeWifiQrField, generatePairingCredentials, parseAdbPairingQrPayload } from '../src/main/lib/qr'

describe('wireless pairing QR payload', () => {
  it('uses the Android Studio WIFI:T:ADB format', () => {
    expect(buildAdbPairingQrPayload('easyadb-abc123', 'pass1234')).toBe('WIFI:T:ADB;S:easyadb-abc123;P:pass1234;;')
  })

  it('escapes special characters', () => {
    expect(escapeWifiQrField('a;b,c:d"e\\f')).toBe('a\\;b\\,c\\:d\\"e\\\\f')
    expect(buildAdbPairingQrPayload('n;1', 'p:w')).toBe('WIFI:T:ADB;S:n\\;1;P:p\\:w;;')
  })

  it('round-trips through the parser', () => {
    const payload = buildAdbPairingQrPayload('svc;name', 'pa\\ss:word')
    expect(parseAdbPairingQrPayload(payload)).toEqual({ serviceName: 'svc;name', password: 'pa\\ss:word' })
  })

  it('rejects malformed payloads', () => {
    expect(parseAdbPairingQrPayload('WIFI:T:WPA;S:home;P:x;;')).toBeNull()
    expect(parseAdbPairingQrPayload('hello')).toBeNull()
  })

  it('requires both fields', () => {
    expect(() => buildAdbPairingQrPayload('', 'x')).toThrow()
    expect(() => buildAdbPairingQrPayload('x', '')).toThrow()
  })

  it('generates credentials from the random source', () => {
    const fake = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => i)
    const creds = generatePairingCredentials(fake)
    expect(creds.serviceName).toMatch(/^easyadb-[A-Za-z0-9]{8}$/)
    expect(creds.password).toMatch(/^[A-Za-z0-9]{12}$/)
    // Payload never needs escaping with our alphabet.
    expect(buildAdbPairingQrPayload(creds.serviceName, creds.password)).toBe(`WIFI:T:ADB;S:${creds.serviceName};P:${creds.password};;`)
  })

  it('produces different credentials for different randomness', () => {
    const a = generatePairingCredentials((n) => Uint8Array.from({ length: n }, () => 1))
    const b = generatePairingCredentials((n) => Uint8Array.from({ length: n }, () => 2))
    expect(a.password).not.toBe(b.password)
  })
})
