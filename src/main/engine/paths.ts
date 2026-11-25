import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const exe = (name: string): string => (process.platform === 'win32' ? `${name}.exe` : name)

export function engineDir(): string {
  return process.env.EASY_ADB_ENGINE_DIR || join(app.getPath('userData'), 'engine')
}

export function platformToolsDir(): string {
  return join(engineDir(), 'platform-tools')
}

export function adbPath(): string {
  return join(platformToolsDir(), exe('adb'))
}

export function scrcpyDir(): string {
  return join(engineDir(), 'scrcpy')
}

export function scrcpyPath(): string {
  return join(scrcpyDir(), exe('scrcpy'))
}

export function scrcpyServerPath(): string {
  return join(scrcpyDir(), 'scrcpy-server')
}

export function engineManifestPath(): string {
  return join(engineDir(), 'engine.json')
}

export function hasAdb(): boolean {
  return existsSync(adbPath())
}

export function hasScrcpy(): boolean {
  return existsSync(scrcpyPath())
}

export function tempDir(...parts: string[]): string {
  return join(app.getPath('temp'), 'easy-adb', ...parts)
}
