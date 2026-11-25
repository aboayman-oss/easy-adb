// Safe everyday tweaks: animation speed, display size (with auto-revert), stay awake, power menu.
import type { AnimationPreset, DensityInfo } from '@shared/types'
import { AppError } from '../lib/errors'
import { parseWmDensity } from '../lib/parsers'
import { emit } from '../services/events'
import { logInfo, logWarn } from '../services/log'
import { adb, shell } from './runner'
import { requireOnline } from './tracker'

const ANIMATION_KEYS = ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']

export async function getAnimation(serial: string): Promise<{ preset: AnimationPreset; scale: number }> {
  requireOnline(serial)
  const out = await shell(serial, ANIMATION_KEYS.map((k) => `settings get global ${k}`).join('; '))
  const values = out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((v) => (v === 'null' ? 1 : Number(v)))
  const scale = values[0] ?? 1
  const allSame = values.every((v) => v === scale)
  let preset: AnimationPreset = 'custom'
  if (allSame && scale === 1) preset = 'normal'
  else if (allSame && scale === 0.5) preset = 'fast'
  else if (allSame && scale === 0) preset = 'off'
  return { preset, scale }
}

export async function setAnimation(serial: string, scale: number): Promise<void> {
  requireOnline(serial)
  if (![0, 0.5, 1, 1.5, 2].includes(scale)) throw new AppError({ title: 'Invalid speed', message: 'Pick one of the presets.' })
  await shell(serial, ANIMATION_KEYS.map((k) => `settings put global ${k} ${scale.toFixed(1)}`).join('; '), {
    log: `Set animation speed to ${scale}x`
  })
}

// ---- display size ----------------------------------------------------------

const DENSITY_STEPS: { label: string; factor: number }[] = [
  { label: 'Smallest', factor: 0.82 },
  { label: 'Small', factor: 0.9 },
  { label: 'Default', factor: 1 },
  { label: 'Large', factor: 1.1 },
  { label: 'Largest', factor: 1.2 }
]

const pendingReverts = new Map<string, { timer: NodeJS.Timeout; previous: number | null }>()
export const DENSITY_REVERT_SECONDS = 10

export async function getDensity(serial: string): Promise<DensityInfo> {
  requireOnline(serial)
  const parsed = parseWmDensity(await shell(serial, 'wm density'))
  if (!parsed) throw new AppError({ title: 'Not supported', message: 'This phone doesn’t report its display size.' })
  return {
    physical: parsed.physical,
    current: parsed.override ?? parsed.physical,
    presets: DENSITY_STEPS.map((s) => ({ label: s.label, value: Math.round((parsed.physical * s.factor) / 4) * 4 }))
  }
}

async function applyDensity(serial: string, value: number | null): Promise<void> {
  if (value === null) await shell(serial, 'wm density reset', { log: 'Reset display size' })
  else await shell(serial, `wm density ${Math.round(value)}`, { log: `Changed display size to ${value} dpi` })
}

/** Apply a density; it reverts automatically unless confirmed within 10 seconds. */
export async function setDensity(serial: string, value: number | null): Promise<{ revertInSeconds: number }> {
  requireOnline(serial)
  const info = await getDensity(serial)
  if (value !== null) {
    const min = Math.round(info.physical * 0.75)
    const max = Math.round(info.physical * 1.3)
    if (value < min || value > max) {
      throw new AppError({ title: 'Out of safe range', message: 'That display size could make the phone hard to use.' })
    }
  }
  const existing = pendingReverts.get(serial)
  const previous = existing ? existing.previous : info.current === info.physical ? null : info.current
  if (existing) clearTimeout(existing.timer)
  await applyDensity(serial, value === info.physical ? null : value)
  const timer = setTimeout(() => {
    pendingReverts.delete(serial)
    logWarn('Display size wasn’t confirmed — reverting automatically')
    applyDensity(serial, previous)
      .then(() => emit('density:reverted', { serial }))
      .catch(() => undefined)
  }, DENSITY_REVERT_SECONDS * 1000)
  pendingReverts.set(serial, { timer, previous })
  return { revertInSeconds: DENSITY_REVERT_SECONDS }
}

export function confirmDensity(serial: string): void {
  const pending = pendingReverts.get(serial)
  if (!pending) return
  clearTimeout(pending.timer)
  pendingReverts.delete(serial)
  logInfo('Kept the new display size')
}

export async function revertDensity(serial: string): Promise<void> {
  const pending = pendingReverts.get(serial)
  if (!pending) return
  clearTimeout(pending.timer)
  pendingReverts.delete(serial)
  await applyDensity(serial, pending.previous)
  emit('density:reverted', { serial })
}

// ---- stay awake ------------------------------------------------------------

export async function getStayAwake(serial: string): Promise<boolean> {
  requireOnline(serial)
  const out = (await shell(serial, 'settings get global stay_on_while_plugged_in')).trim()
  return out !== '0' && out !== 'null' && out !== ''
}

// 15 = AC | USB | wireless | dock — the same value Android’s own Developer options toggle writes.
export async function setStayAwake(serial: string, on: boolean): Promise<void> {
  requireOnline(serial)
  await shell(serial, `settings put global stay_on_while_plugged_in ${on ? 15 : 0}`, {
    log: on ? 'Phone will stay awake while charging' : 'Phone can sleep while charging'
  })
}

// ---- power -----------------------------------------------------------------

export async function powerAction(serial: string, action: 'reboot' | 'recovery' | 'poweroff'): Promise<void> {
  requireOnline(serial)
  if (action === 'reboot') {
    await adb(['reboot'], { serial, log: 'Restarted the phone', timeoutMs: 20_000 })
  } else if (action === 'recovery') {
    await adb(['reboot', 'recovery'], { serial, log: 'Restarted the phone into recovery mode', timeoutMs: 20_000 })
  } else {
    const out = await shell(serial, 'reboot -p || svc power shutdown', { log: 'Powering off the phone', allowFailure: true, timeoutMs: 20_000 })
    if (/not permitted|denied/i.test(out)) {
      throw new AppError({ title: 'Not allowed', message: 'This phone doesn’t allow powering off from a computer.', hint: 'Use the phone’s power button instead.' })
    }
  }
}
