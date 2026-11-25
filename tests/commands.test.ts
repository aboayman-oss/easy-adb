import { describe, expect, it } from 'vitest'
import { describeCommand } from '../src/main/lib/commands'

describe('Activity Log command lines', () => {
  it('hides Wi-Fi pairing codes', () => {
    expect(describeCommand(['pair', '192.168.1.23:37631', '123456'])).toBe('adb pair 192.168.1.23:37631 ••••••')
    expect(describeCommand(['-s', 'x', 'pair', '10.0.0.2:4000', 'Xy12Zw34Ab56'])).toBe('adb -s x pair 10.0.0.2:4000 ••••••')
  })

  it('quotes arguments with spaces and leaves others alone', () => {
    expect(describeCommand(['push', 'C:\\My Files\\a.txt', '/sdcard/'])).toBe('adb push "C:\\\\My Files\\\\a.txt" /sdcard/')
    expect(describeCommand(['connect', '192.168.1.23:5555'])).toBe('adb connect 192.168.1.23:5555')
  })
})
