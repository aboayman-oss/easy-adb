import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  isWifiSerial,
  parseAdbVersion,
  parseBatterySysfs,
  parseDeviceList,
  parseDf,
  parseDiskstats,
  parseDumpsysBattery,
  parseGetprop,
  parseMdnsServices,
  parseMeminfo,
  parsePackageList,
  parseScrcpyVersion,
  parseWifiIp,
  parseWmDensity,
  parseWmSize,
  TrackDevicesDecoder
} from '../src/main/lib/parsers'

describe('adb devices -l', () => {
  const sample = `List of devices attached
R5CX1234ABC            device usb:1-4 product:e3qxxx model:SM_S928B device:e3q transport_id:3
adb-R5CX1234ABC-a1B2c3._adb-tls-connect._tcp device product:e3qxxx model:SM_S928B device:e3q transport_id:230
192.168.1.40:5555      unauthorized transport_id:7
0123456789ABCDEF       no permissions (missing udev rules? user is in the plugdev group); see [http://developer.android.com/tools/device.html] usb:1-2 transport_id:9
emulator-5554          offline transport_id:1
`
  const list = parseDeviceList(sample)

  it('parses every row', () => {
    expect(list).toHaveLength(5)
  })

  it('parses a USB device with details', () => {
    expect(list[0]).toEqual({
      serial: 'R5CX1234ABC',
      state: 'device',
      transport: 'usb',
      model: 'SM S928B',
      product: 'e3qxxx',
      device: 'e3q',
      transportId: '3'
    })
  })

  it('recognises wireless serials', () => {
    expect(list[1].transport).toBe('wifi')
    expect(list[2]).toMatchObject({ serial: '192.168.1.40:5555', state: 'unauthorized', transport: 'wifi' })
    expect(isWifiSerial('[fe80::1]:5555')).toBe(true)
    expect(isWifiSerial('R5CX1234ABC')).toBe(false)
  })

  it('handles "no permissions" and offline states', () => {
    expect(list[3].state).toBe('no-permissions')
    expect(list[4].state).toBe('offline')
  })

  it('handles the short tab-separated form', () => {
    expect(parseDeviceList('abc123\tdevice\nxyz\tunauthorized\n')).toMatchObject([
      { serial: 'abc123', state: 'device' },
      { serial: 'xyz', state: 'unauthorized' }
    ])
  })
})

describe('TrackDevicesDecoder', () => {
  const frame = (body: string): Buffer => Buffer.concat([Buffer.from(Buffer.byteLength(body).toString(16).padStart(4, '0')), Buffer.from(body)])

  it('decodes frames split across chunks', () => {
    const d = new TrackDevicesDecoder()
    const data = Buffer.concat([frame('abc\tdevice\n'), frame('')])
    expect(d.push(data.subarray(0, 6))).toEqual([])
    const frames = d.push(data.subarray(6))
    expect(frames).toHaveLength(2)
    expect(frames[0][0]).toMatchObject({ serial: 'abc', state: 'device' })
    expect(frames[1]).toEqual([])
  })

  it('decodes several frames in one chunk', () => {
    const d = new TrackDevicesDecoder()
    const frames = d.push(Buffer.concat([frame('a\tunauthorized\n'), frame('a\tdevice\nb\toffline\n')]))
    expect(frames.map((f) => f.length)).toEqual([1, 2])
  })
})

describe('getprop', () => {
  it('parses properties including empty values', () => {
    const props = parseGetprop('[ro.product.model]: [SM-S928B]\n[ro.build.version.release]: [14]\n[persist.empty]: []\n[ro.product.marketname]: [Galaxy S24 Ultra]\n')
    expect(props['ro.product.model']).toBe('SM-S928B')
    expect(props['ro.build.version.release']).toBe('14')
    expect(props['persist.empty']).toBe('')
    expect(props['ro.product.marketname']).toBe('Galaxy S24 Ultra')
  })
})

describe('dumpsys battery', () => {
  const sample = `Current Battery Service state:
  AC powered: false
  USB powered: true
  Wireless powered: false
  Dock powered: false
  Max charging current: 500000
  Max charging voltage: 5000000
  Charge counter: 3895000
  status: 2
  health: 2
  present: true
  level: 87
  scale: 100
  voltage: 4219
  temperature: 312
  technology: Li-ion
  Charging state: 1
  Battery cycle count: 214
`
  it('parses level, status, health, power source', () => {
    const b = parseDumpsysBattery(sample)
    expect(b.level).toBe(87)
    expect(b.status).toBe('charging')
    expect(b.health).toBe('good')
    expect(b.plugged).toBe('usb')
  })

  it('converts temperature and voltage units', () => {
    const b = parseDumpsysBattery(sample)
    expect(b.temperatureC).toBe(31.2)
    expect(b.voltageV).toBe(4.22)
    expect(b.technology).toBe('Li-ion')
    expect(b.chargeCounterMah).toBe(3895)
  })

  it('finds a cycle count when the ROM exposes one', () => {
    expect(parseDumpsysBattery(sample).cycleCount).toBe(214)
  })

  it('handles microvolts, overheating and scale', () => {
    const b = parseDumpsysBattery('level: 40\nscale: 50\nvoltage: 3850000\ntemperature: 455\nhealth: 3\nstatus: 3\nAC powered: true\n')
    expect(b.level).toBe(80)
    expect(b.voltageV).toBe(3.85)
    expect(b.temperatureC).toBe(45.5)
    expect(b.health).toBe('overheat')
    expect(b.status).toBe('discharging')
    expect(b.plugged).toBe('ac')
  })

  it('parses sysfs cycle count and capacity', () => {
    expect(parseBatterySysfs('cycle_count=321\ncharge_full=4200000\ncharge_full_design=5000000\n')).toEqual({ cycleCount: 321, capacityHealthPercent: 84 })
    expect(parseBatterySysfs('battery_cycle=55\n')).toEqual({ cycleCount: 55, capacityHealthPercent: undefined })
    expect(parseBatterySysfs('')).toEqual({ cycleCount: undefined, capacityHealthPercent: undefined })
  })
})

describe('memory & storage', () => {
  it('parses /proc/meminfo', () => {
    const m = parseMeminfo('MemTotal:       11706128 kB\nMemFree:          301234 kB\nMemAvailable:    5123456 kB\n')
    expect(m.totalBytes).toBe(11706128 * 1024)
    expect(m.availableBytes).toBe(5123456 * 1024)
  })

  it('parses df -k output', () => {
    const r = parseDf('Filesystem      1K-blocks      Used Available Use% Mounted on\n/dev/block/dm-48 238000000 120000000 118000000  51% /data\n')
    expect(r).toEqual({ totalBytes: 238000000 * 1024, usedBytes: 120000000 * 1024, freeBytes: 118000000 * 1024 })
  })

  it('parses df output with a wrapped filesystem name', () => {
    const r = parseDf('Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/block/bootdevice/by-name/userdata\n 100 40 60 40% /data\n')
    expect(r).toEqual({ totalBytes: 102400, usedBytes: 40960, freeBytes: 61440 })
  })

  it('parses dumpsys diskstats categories', () => {
    const d = parseDiskstats(`Latency: 2ms [512B Data Write]
Data-Free: 117999988K / 238000000K total = 49% free
App Size: 20000000000
App Data Size: 5000000000
App Cache Size: 1000000000
Photos Size: 30000000000
Videos Size: 12000000000
Audio Size: 500000000
Downloads Size: 800000000
System Size: 18000000000
Other Size: 4000000000
`)
    expect(d.apps).toBe(25000000000) // code + data (data already includes cache)
    expect(d.photos).toBe(30000000000)
    expect(d.system).toBe(18000000000)
    expect(d.other).toBe(4000000000)
  })

  it('parses wm density and size', () => {
    expect(parseWmDensity('Physical density: 480\nOverride density: 420\n')).toEqual({ physical: 480, override: 420 })
    expect(parseWmDensity('Physical density: 450\n')).toEqual({ physical: 450, override: undefined })
    expect(parseWmSize('Physical size: 1440x3120\n')).toEqual({ width: 1440, height: 3120 })
    expect(parseWmSize('Physical size: 1440x3120\nOverride size: 1080x2340\n')).toEqual({ width: 1080, height: 2340 })
  })
})

describe('pm list packages', () => {
  it('parses -f -U --show-versioncode output with "=" inside paths', () => {
    const list = parsePackageList(`package:/data/app/~~kQz3fA==/com.whatsapp-Xy9_2LmP==/base.apk=com.whatsapp versionCode:241234 uid:10234
package:/system/priv-app/SystemUIGoogle/SystemUIGoogle.apk=com.android.systemui versionCode:34 uid:10112
package:/product/app/Maps/Maps.apk=com.google.android.apps.maps versionCode:1072 uid:10200
`)
    expect(list).toHaveLength(3)
    expect(list[0]).toEqual({
      packageName: 'com.whatsapp',
      apkPath: '/data/app/~~kQz3fA==/com.whatsapp-Xy9_2LmP==/base.apk',
      versionCode: 241234,
      uid: 10234
    })
    expect(list[1].apkPath).toBe('/system/priv-app/SystemUIGoogle/SystemUIGoogle.apk')
  })

  it('parses plain output and installer info', () => {
    expect(parsePackageList('package:com.a.b\npackage:com.c.d installer=com.android.vending\nnot a package line\n')).toEqual([
      { packageName: 'com.a.b' },
      { packageName: 'com.c.d', installer: 'com.android.vending' }
    ])
  })

  it('keeps packages removed for the user (path reported as "null")', () => {
    expect(parsePackageList('package:null=com.samsung.android.app.tips versionCode:900034000 uid:10315\n')).toEqual([
      { packageName: 'com.samsung.android.app.tips', apkPath: undefined, versionCode: 900034000, uid: 10315 }
    ])
  })

  it('ignores error lines', () => {
    expect(parsePackageList('Error: Unknown option: --show-versioncode\n')).toEqual([])
  })
})

describe('mdns & network', () => {
  it('parses adb mdns services', () => {
    const s = parseMdnsServices(`List of discovered mdns services
adb-R5CX1234ABC-a1B2c3	_adb-tls-connect._tcp	192.168.1.40:37291
easyadb-Ab3dEf9h	_adb-tls-pairing._tcp.	192.168.1.40:41235
`)
    expect(s).toEqual([
      { instance: 'adb-R5CX1234ABC-a1B2c3', type: '_adb-tls-connect._tcp', host: '192.168.1.40', port: 37291 },
      { instance: 'easyadb-Ab3dEf9h', type: '_adb-tls-pairing._tcp', host: '192.168.1.40', port: 41235 }
    ])
  })

  it('extracts the Wi-Fi IP address', () => {
    expect(parseWifiIp('3: wlan0: <BROADCAST,MULTICAST,UP>\n    inet 192.168.1.40/24 brd 192.168.1.255 scope global wlan0\n')).toBe('192.168.1.40')
    expect(parseWifiIp('192.168.1.0/24 dev wlan0 proto kernel scope link src 192.168.1.41\n')).toBe('192.168.1.41')
    expect(parseWifiIp('')).toBeNull()
  })
})

describe('versions', () => {
  it('parses adb and scrcpy versions', () => {
    expect(parseAdbVersion('Android Debug Bridge version 1.0.41\nVersion 37.0.3-13945642\nInstalled as C:\\x\\adb.exe')).toBe('37.0.3-13945642')
    expect(parseScrcpyVersion('scrcpy 3.3.1 <https://github.com/Genymobile/scrcpy>')).toBe('3.3.1')
  })

  it('compares versions', () => {
    expect(compareVersions('37.0.3', '36.0.0-123')).toBeGreaterThan(0)
    expect(compareVersions('3.3.1', '3.3.1')).toBe(0)
    expect(compareVersions('3.2', '3.10')).toBeLessThan(0)
  })
})
