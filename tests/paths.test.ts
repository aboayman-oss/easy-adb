import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  isInsideUserStorage,
  isValidRemoteName,
  joinRemotePath,
  normalizeRemotePath,
  remoteBasename,
  remoteBreadcrumbs,
  remoteDirname,
  sanitizeLocalFileName,
  shellCommand,
  shellQuote,
  uniqueName
} from '../src/main/lib/paths'

describe('shellQuote', () => {
  it('leaves simple safe tokens alone', () => {
    expect(shellQuote('/sdcard/DCIM/Camera')).toBe('/sdcard/DCIM/Camera')
    expect(shellQuote('com.whatsapp')).toBe('com.whatsapp')
  })

  it('quotes empty strings', () => {
    expect(shellQuote('')).toBe("''")
  })

  it('quotes spaces', () => {
    expect(shellQuote('/sdcard/My Photos/a b.jpg')).toBe("'/sdcard/My Photos/a b.jpg'")
  })

  it('escapes single quotes', () => {
    expect(shellQuote("it's here")).toBe(`'it'\\''s here'`)
  })

  it('neutralises shell metacharacters', () => {
    for (const s of ['$(reboot)', '`reboot`', 'a; rm -rf /', 'a && b', 'a|b', '*', '~/x', 'a>b', '"q"', '\\back']) {
      const q = shellQuote(s)
      expect(q.startsWith("'")).toBe(true)
      expect(q.endsWith("'")).toBe(true)
    }
  })

  it('keeps Unicode (Arabic, emoji, CJK) intact', () => {
    expect(shellQuote('/sdcard/صور العائلة/😀 照片.jpg')).toBe("'/sdcard/صور العائلة/😀 照片.jpg'")
  })

  it('builds command lines with quoted arguments', () => {
    expect(shellCommand('mkdir', '-p', '/sdcard/New Folder')).toBe("mkdir -p '/sdcard/New Folder'")
    expect(shellCommand('rm', '--', "/sdcard/it's.txt")).toBe(`rm -- '/sdcard/it'\\''s.txt'`)
  })

  // Real round-trip through a POSIX shell when one is available (Git Bash / Linux / macOS).
  let sh: string | null = null
  try {
    execFileSync('sh', ['-c', 'true'])
    sh = 'sh'
  } catch {
    sh = null
  }
  it.skipIf(!sh)(
    'round-trips nasty strings through a real POSIX shell',
    () => {
      const samples = ["it's", 'a b  c', '$HOME', '`id`', 'x"y', 'back\\slash', 'semi;colon', 'new\nline', 'عربي مع مسافات', '*?[]', '-n']
      // One shell invocation: print every argument followed by a NUL separator.
      const out = execFileSync(sh!, ['-c', `printf '%s\\0' ${samples.map(shellQuote).join(' ')}`], { encoding: 'utf8' })
      expect(out.split('\0').slice(0, -1)).toEqual(samples)
    },
    20_000
  )
})

describe('remote paths', () => {
  it('normalises paths', () => {
    expect(normalizeRemotePath('/sdcard//DCIM/./Camera/')).toBe('/sdcard/DCIM/Camera')
    expect(normalizeRemotePath('/sdcard/DCIM/../Download')).toBe('/sdcard/Download')
    expect(normalizeRemotePath('/../..')).toBe('/')
    expect(normalizeRemotePath('\\sdcard\\x')).toBe('/sdcard/x')
  })

  it('joins, splits and builds breadcrumbs', () => {
    expect(joinRemotePath('/sdcard/', 'My Folder', 'a.txt')).toBe('/sdcard/My Folder/a.txt')
    expect(remoteBasename('/sdcard/DCIM/Camera/')).toBe('Camera')
    expect(remoteBasename('/')).toBe('/')
    expect(remoteDirname('/sdcard/DCIM/x.jpg')).toBe('/sdcard/DCIM')
    expect(remoteDirname('/sdcard')).toBe('/')
    expect(remoteBreadcrumbs('/sdcard/DCIM').map((c) => c.path)).toEqual(['/', '/sdcard', '/sdcard/DCIM'])
  })

  it('detects user storage locations', () => {
    expect(isInsideUserStorage('/sdcard')).toBe(true)
    expect(isInsideUserStorage('/sdcard/DCIM/Camera')).toBe(true)
    expect(isInsideUserStorage('/storage/emulated/0/Download')).toBe(true)
    expect(isInsideUserStorage('/storage/1A2B-3C4D/Music')).toBe(true)
    expect(isInsideUserStorage('/sdcard/../system/bin')).toBe(false)
    expect(isInsideUserStorage('/system')).toBe(false)
    expect(isInsideUserStorage('/data/local/tmp')).toBe(false)
    expect(isInsideUserStorage('/sdcardx')).toBe(false)
  })

  it('validates remote names', () => {
    expect(isValidRemoteName('Holiday 2024')).toBe(true)
    expect(isValidRemoteName('صور')).toBe(true)
    expect(isValidRemoteName('a/b')).toBe(false)
    expect(isValidRemoteName('..')).toBe(false)
    expect(isValidRemoteName('')).toBe(false)
  })
})

describe('local file names', () => {
  it('replaces characters Windows forbids', () => {
    expect(sanitizeLocalFileName('what?.txt')).toBe('what_.txt')
    expect(sanitizeLocalFileName('a:b*c|d"e<f>g')).toBe('a_b_c_d_e_f_g')
  })

  it('handles trailing dots/spaces and reserved names', () => {
    expect(sanitizeLocalFileName('name. ')).toBe('name__')
    expect(sanitizeLocalFileName('CON')).toBe('_CON')
    expect(sanitizeLocalFileName('lpt1.txt')).toBe('_lpt1.txt')
  })

  it('keeps Unicode names', () => {
    expect(sanitizeLocalFileName('صورة العيد 😀.jpg')).toBe('صورة العيد 😀.jpg')
  })

  it('creates unique names', () => {
    const existing = new Set(['a.jpg', 'a (2).jpg', 'folder'])
    expect(uniqueName('a.jpg', (n) => existing.has(n))).toBe('a (3).jpg')
    expect(uniqueName('folder', (n) => existing.has(n))).toBe('folder (2)')
    expect(uniqueName('new.png', (n) => existing.has(n))).toBe('new.png')
  })
})
