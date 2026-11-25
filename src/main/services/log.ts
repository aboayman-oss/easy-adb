// Activity log: a transparent, human-readable record of what Easy ADB did.
import type { LogEntry } from '@shared/types'
import { emit } from './events'

const MAX_ENTRIES = 600
const entries: LogEntry[] = []
let nextId = 1

export function log(level: LogEntry['level'], message: string, extra?: { command?: string; durationMs?: number }): void {
  const entry: LogEntry = { id: nextId++, time: Date.now(), level, message, ...extra }
  entries.push(entry)
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
  emit('log:entry', entry)
}

export const logInfo = (m: string, e?: { command?: string; durationMs?: number }): void => log('info', m, e)
export const logSuccess = (m: string, e?: { command?: string; durationMs?: number }): void => log('success', m, e)
export const logWarn = (m: string, e?: { command?: string; durationMs?: number }): void => log('warn', m, e)
export const logError = (m: string, e?: { command?: string; durationMs?: number }): void => log('error', m, e)

export function logHistory(): LogEntry[] {
  return [...entries]
}

export function clearLog(): void {
  entries.length = 0
}
