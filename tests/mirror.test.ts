import { describe, expect, it } from 'vitest'
import { buildScrcpyArgs, translateScrcpyError, windowsCommandLine } from '../src/main/adb/mirror'

const base = { quality: 'balanced' as const, turnScreenOff: false, stayAwake: false, audio: true, alwaysOnTop: false }

describe('scrcpy arguments', () => {
  it('maps quality presets', () => {
    expect(buildScrcpyArgs('abc', { ...base, quality: 'smooth' }, 'T')).toEqual(['--serial=abc', '--window-title=T', '--video-bit-rate=16M', '--max-fps=60'])
    expect(buildScrcpyArgs('abc', base, 'T')).toContain('--max-size=1600')
    expect(buildScrcpyArgs('abc', { ...base, quality: 'saver' }, 'T')).toEqual(
      expect.arrayContaining(['--max-size=1024', '--video-bit-rate=2M', '--max-fps=30'])
    )
  })

  it('maps casual toggles to flags', () => {
    const args = buildScrcpyArgs('abc', { ...base, turnScreenOff: true, stayAwake: true, audio: false, alwaysOnTop: true }, 'T')
    expect(args).toEqual(expect.arrayContaining(['--turn-screen-off', '--stay-awake', '--no-audio', '--always-on-top']))
  })

  it('quotes arguments for cmd.exe and strips characters cmd would interpret', () => {
    expect(windowsCommandLine(['C:\\Program Files\\scrcpy.exe', '--serial=adb-X (2)._adb-tls-connect._tcp', '--window-title=Easy ADB - A&B'])).toBe(
      '"C:\\Program Files\\scrcpy.exe" "--serial=adb-X (2)._adb-tls-connect._tcp" "--window-title=Easy ADB - A&B"'
    )
    expect(windowsCommandLine(['a"b', '100%'])).toBe('"ab" "100"')
  })

  it('translates scrcpy failures', () => {
    expect(translateScrcpyError('ERROR: Could not find any ADB device').title).toBe('Phone not found')
    expect(translateScrcpyError('ERROR: Could not open video stream').hint).toMatch(/Data saver/)
    expect(translateScrcpyError('weird').title).toBe('Mirroring stopped')
  })
})
