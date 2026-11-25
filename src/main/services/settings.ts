// Persistent user settings stored as JSON in the app-data folder.
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppSettings } from '@shared/types'

let cache: AppSettings | null = null

function settingsFile(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function defaults(): AppSettings {
  const base = join(app.getPath('downloads'), 'Easy ADB')
  return {
    theme: 'system',
    downloadDir: base,
    captureDir: join(app.getPath('pictures'), 'Easy ADB'),
    mirror: { quality: 'balanced', turnScreenOff: false, stayAwake: true, audio: true, alwaysOnTop: false },
    rememberedDevices: [],
    activityLogOpen: false
  }
}

export function getSettings(): AppSettings {
  if (cache) return cache
  const base = defaults()
  try {
    const file = settingsFile()
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<AppSettings>
      cache = { ...base, ...parsed, mirror: { ...base.mirror, ...(parsed.mirror ?? {}) } }
      return cache
    }
  } catch {
    // corrupt file → fall back to defaults
  }
  cache = base
  return cache
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const current = getSettings()
  const next: AppSettings = {
    ...current,
    ...patch,
    mirror: { ...current.mirror, ...(patch.mirror ?? {}) }
  }
  cache = next
  try {
    const file = settingsFile()
    mkdirSync(app.getPath('userData'), { recursive: true })
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch {
    // settings are best-effort
  }
  return next
}
