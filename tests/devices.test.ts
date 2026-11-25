import { describe, expect, it } from 'vitest'
import type { DeviceSummary } from '../src/shared/types'
import { dedupeWifiDevices, parseHostPort, serialFromMdnsName } from '../src/main/lib/devices'

const wifi = (serial: string, state: DeviceSummary['state'] = 'device'): DeviceSummary => ({ serial, state, transport: 'wifi', model: 'SM S928B' })
const usb = (serial: string): DeviceSummary => ({ serial, state: 'device', transport: 'usb', model: 'SM S928B' })

describe('wifi transport helpers', () => {
  it('extracts the hardware serial from mDNS transport names', () => {
    expect(serialFromMdnsName('adb-R5CX1234ABC-a1B2c3._adb-tls-connect._tcp')).toBe('R5CX1234ABC')
    expect(serialFromMdnsName('adb-abc-def-123456._adb-tls-connect._tcp')).toBe('abc-def')
    expect(serialFromMdnsName('192.168.1.23:34197')).toBeUndefined()
  })

  it('parses ip:port serials', () => {
    expect(parseHostPort('192.168.1.23:34197')).toEqual({ host: '192.168.1.23', port: 34197 })
    expect(parseHostPort('R5CX1234ABC')).toBeUndefined()
  })

  it('hides a second Wi-Fi transport of the same phone', () => {
    const list = [wifi('adb-R5CX1234ABC-a1B2c3._adb-tls-connect._tcp'), wifi('192.168.1.23:34197')]
    const hw = new Map([['192.168.1.23:34197', 'R5CX1234ABC']])
    expect(dedupeWifiDevices(list, hw).map((d) => d.serial)).toEqual(['adb-R5CX1234ABC-a1B2c3._adb-tls-connect._tcp'])
  })

  it('keeps different phones, USB transports and not-yet-identified devices', () => {
    const list = [usb('R5CX1234ABC'), wifi('adb-R5CX1234ABC-a1B2c3._adb-tls-connect._tcp'), wifi('192.168.0.50:5555'), wifi('192.168.0.77:5555', 'offline')]
    expect(dedupeWifiDevices(list, new Map([['192.168.0.50:5555', 'OTHERPHONE']]))).toHaveLength(4)
  })
})
