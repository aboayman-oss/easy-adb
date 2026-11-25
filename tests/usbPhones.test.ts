import { describe, expect, it } from 'vitest'
import { parseUsbPhones } from '../src/main/lib/usbPhones'

// Real Windows output for a Galaxy S24 Ultra plugged in with USB debugging OFF.
const debuggingOff = [
  { Name: 'SAMSUNG Mobile USB Modem', PNPDeviceID: 'USB\\VID_04E8&PID_6860&MODEM\\7&1A2B3C4D&1&0001', Status: 'OK', ConfigManagerErrorCode: 0, PNPClass: 'Modem' },
  { Name: "Sam's Galaxy S24", PNPDeviceID: 'USB\\VID_04E8&PID_6860&MS_COMP_MTP&SAMSUNG_ANDROID\\7&1A2B3C4D&1&0000', Status: 'OK', ConfigManagerErrorCode: 0, PNPClass: 'WPD' },
  { Name: 'SAMSUNG Mobile USB Composite Device ', PNPDeviceID: 'USB\\VID_04E8&PID_6860\\R5CX1234ABC', Status: 'OK', ConfigManagerErrorCode: 0, PNPClass: 'USB' }
]

describe('USB phone detection', () => {
  it('recognises a phone with USB debugging off', () => {
    expect(parseUsbPhones(debuggingOff)).toEqual([
      { key: '04E8:6860', vendor: 'Samsung', brandId: 'samsung', name: "Sam's Galaxy S24", serial: 'R5CX1234ABC', adbInterface: false, driverProblem: undefined }
    ])
  })

  it('notices the ADB interface once USB debugging is on', () => {
    const on = [
      ...debuggingOff,
      { Name: 'SAMSUNG Android ADB Interface', PNPDeviceID: 'USB\\VID_04E8&PID_6860&ADB\\7&1A2B3C4D&1&0002', Status: 'OK', ConfigManagerErrorCode: 0, PNPClass: 'AndroidUsbDeviceClass' }
    ]
    expect(parseUsbPhones(on)[0].adbInterface).toBe(true)
  })

  it('reports driver problems', () => {
    const broken = [
      { Name: 'Pixel 8', PNPDeviceID: 'USB\\VID_18D1&PID_4EE7\\36181FDH2000ZK', Status: 'Error', ConfigManagerErrorCode: 28, PNPClass: null },
      { Name: 'ADB Interface', PNPDeviceID: 'USB\\VID_18D1&PID_4EE7&MI_01\\6&1', Status: 'Error', ConfigManagerErrorCode: 28, PNPClass: null }
    ]
    const [p] = parseUsbPhones(broken)
    expect(p).toMatchObject({ vendor: 'Google', brandId: 'pixel', serial: '36181FDH2000ZK', driverProblem: 'Pixel 8' })
  })

  it('ignores non-phone USB devices', () => {
    expect(parseUsbPhones([{ Name: 'USB Mouse', PNPDeviceID: 'USB\\VID_046D&PID_C077\\5&1', Status: 'OK', ConfigManagerErrorCode: 0, PNPClass: 'Mouse' }])).toEqual([])
  })
})
