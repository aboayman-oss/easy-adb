// Path helpers for device-side (POSIX) paths and host-side file names.

/**
 * Quote a value for the Android device shell (`sh`/`mksh`/`toybox`).
 * `adb shell a b c` joins its arguments with spaces and hands the result to the
 * device shell, so every dynamic value must be single-quoted. Inside single quotes
 * nothing is special except the single quote itself, which we close, escape and reopen.
 */
export function shellQuote(value: string): string {
  if (value.length === 0) return "''"
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Build a single device shell command line from a program and its arguments. */
export function shellCommand(program: string, ...args: (string | number)[]): string {
  return [program, ...args.map((a) => shellQuote(String(a)))].join(' ')
}

/** Normalise a device path: collapse duplicate slashes, resolve `.`/`..`, drop trailing slash. */
export function normalizeRemotePath(input: string): string {
  const parts = input.replace(/\\/g, '/').split('/')
  const out: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      out.pop()
      continue
    }
    out.push(part)
  }
  return '/' + out.join('/')
}

export function joinRemotePath(dir: string, ...names: string[]): string {
  return normalizeRemotePath([dir, ...names].join('/'))
}

export function remoteBasename(path: string): string {
  const norm = normalizeRemotePath(path)
  if (norm === '/') return '/'
  return norm.slice(norm.lastIndexOf('/') + 1)
}

export function remoteDirname(path: string): string {
  const norm = normalizeRemotePath(path)
  const idx = norm.lastIndexOf('/')
  return idx <= 0 ? '/' : norm.slice(0, idx)
}

/** Split a device path into breadcrumb segments with cumulative paths. */
export function remoteBreadcrumbs(path: string): { name: string; path: string }[] {
  const norm = normalizeRemotePath(path)
  const crumbs = [{ name: '/', path: '/' }]
  let acc = ''
  for (const seg of norm.split('/').filter(Boolean)) {
    acc += '/' + seg
    crumbs.push({ name: seg, path: acc })
  }
  return crumbs
}

/** Check that a device path is inside the user-visible shared storage. */
export function isInsideUserStorage(path: string): boolean {
  const norm = normalizeRemotePath(path)
  const roots = ['/sdcard', '/storage/emulated/0', '/storage/self/primary', '/mnt/sdcard']
  return roots.some((root) => norm === root || norm.startsWith(root + '/')) || /^\/storage\/[0-9A-F]{4}-[0-9A-F]{4}(\/|$)/i.test(norm)
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/**
 * Make a device file name safe to create on Windows/macOS/Linux.
 * Android allows characters like `:` `?` `*` `"` `|` that Windows forbids.
 * Unicode (Arabic, emoji, CJK…) is preserved as-is.
 */
export function sanitizeLocalFileName(name: string): string {
  let safe = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
  safe = safe.replace(/[. ]+$/g, (m) => '_'.repeat(m.length))
  if (WINDOWS_RESERVED.test(safe)) safe = '_' + safe
  if (safe.length === 0) safe = '_'
  return safe
}

/** Pick a non-conflicting name by appending " (2)", " (3)", … before the extension. */
export function uniqueName(name: string, exists: (candidate: string) => boolean): string {
  if (!exists(name)) return name
  const dot = name.lastIndexOf('.')
  const hasExt = dot > 0 && dot < name.length - 1
  const base = hasExt ? name.slice(0, dot) : name
  const ext = hasExt ? name.slice(dot) : ''
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${base} (${i})${ext}`
    if (!exists(candidate)) return candidate
  }
  return `${base} (${Date.now()})${ext}`
}

/** A device file name must not contain `/` or NUL and must not be `.` or `..`. */
export function isValidRemoteName(name: string): boolean {
  return name.length > 0 && name.length <= 255 && !/[/\u0000]/.test(name) && name !== '.' && name !== '..'
}
