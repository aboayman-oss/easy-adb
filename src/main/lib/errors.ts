import type { FriendlyError } from '@shared/types'

/** An error that already carries a human-friendly explanation for the UI. */
export class AppError extends Error {
  readonly friendly: FriendlyError
  constructor(friendly: FriendlyError, options?: { cause?: unknown }) {
    super(friendly.message, options)
    this.name = 'AppError'
    this.friendly = friendly
  }
}

export function appError(title: string, message: string, hint?: string, code?: string): AppError {
  return new AppError({ title, message, hint, code })
}

/** Translate low-level adb / OS failures into language a casual user understands. */
export function toFriendlyError(err: unknown): FriendlyError {
  if (err instanceof AppError) return err.friendly
  const raw = err instanceof Error ? err.message : String(err)
  const text = raw.toLowerCase()

  if (text.includes('device offline') || text.includes("device '") && text.includes('not found')) {
    return {
      title: 'Phone disconnected',
      message: 'Your phone was disconnected while this was running.',
      hint: 'Reconnect the cable (or Wi-Fi) and try again.',
      code: 'DEVICE_GONE'
    }
  }
  if (text.includes('no devices/emulators found') || text.includes('no devices found')) {
    return {
      title: 'No phone connected',
      message: 'Easy ADB can’t see a connected phone right now.',
      hint: 'Plug in your phone and make sure USB debugging is on.',
      code: 'NO_DEVICE'
    }
  }
  if (text.includes('unauthorized')) {
    return {
      title: 'Waiting for permission',
      message: 'Your phone hasn’t allowed this computer yet.',
      hint: 'Look at your phone and tap “Allow” on the USB debugging popup.',
      code: 'UNAUTHORIZED'
    }
  }
  if (text.includes('permission denied') || text.includes('operation not permitted')) {
    return {
      title: 'Not allowed',
      message: 'Android doesn’t allow this action from a computer in this location.',
      hint: 'Try a folder inside Internal storage instead.',
      code: 'PERMISSION'
    }
  }
  if (text.includes('no space left') || text.includes('insufficient storage')) {
    return {
      title: 'Not enough space',
      message: 'There isn’t enough free space to finish this.',
      hint: 'Free up some storage and try again.',
      code: 'NO_SPACE'
    }
  }
  if (text.includes('timed out') || text.includes('timeout')) {
    return {
      title: 'This took too long',
      message: 'The phone didn’t answer in time.',
      hint: 'Unlock your phone, keep it connected, and try again.',
      code: 'TIMEOUT'
    }
  }
  if (text.includes('enoent') && text.includes('adb')) {
    return {
      title: 'Engine missing',
      message: 'The Easy ADB engine files are missing.',
      hint: 'Open Settings and choose “Repair engine”.',
      code: 'ENGINE_MISSING'
    }
  }
  if (text.includes('econnrefused') || text.includes('cannot connect to daemon')) {
    return {
      title: 'Engine not running',
      message: 'The connection engine stopped unexpectedly.',
      hint: 'Easy ADB will restart it automatically. Try again in a moment.',
      code: 'SERVER_DOWN'
    }
  }
  if (text.includes('cancel')) {
    return { title: 'Cancelled', message: 'The action was cancelled.', code: 'CANCELLED' }
  }
  return {
    title: 'Something went wrong',
    message: firstLine(raw) || 'An unexpected problem occurred.',
    hint: 'Open the Activity Log for technical details.',
    code: 'UNKNOWN'
  }
}

function firstLine(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!line) return ''
  return line.replace(/^(adb|error|exception):\s*/i, '').slice(0, 240)
}
