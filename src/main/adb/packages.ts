// Safe app manager & debloater.
import type { AppEntry, AppMeta } from '@shared/types'
import { classifyPackage, lookupPackage } from '../data/packageDb'
import { AppError } from '../lib/errors'
import { parsePackageList, type PackageListEntry } from '../lib/parsers'
import { shellCommand } from '../lib/paths'
import { emit } from '../services/events'
import { logSuccess } from '../services/log'
import { cachedLabel, getAppMeta } from './apkMeta'
import { shell } from './runner'
import { requireOnline } from './tracker'

const MARK = '___EASYADB_SECTION___'
const PKG_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/

/** Remember the apk path / version of each package per device for metadata lookups. */
const knownPackages = new Map<string, Map<string, PackageListEntry>>()

function assertPackage(pkg: string): void {
  if (!PKG_RE.test(pkg) && pkg !== 'android') throw new AppError({ title: 'Invalid app', message: 'That app id looks wrong.' })
}

export async function listApps(serial: string): Promise<AppEntry[]> {
  requireOnline(serial)
  const script = [
    'pm list packages -f -U --show-versioncode --user 0 2>/dev/null || pm list packages -f --user 0',
    // -u so system apps that were removed for this user still count as system apps.
    'pm list packages -s -u --user 0',
    'pm list packages -d --user 0',
    'pm list packages -u -f --user 0'
  ].join(`; echo ${MARK}; `)
  const text = await shell(serial, script, { timeoutMs: 60_000, log: 'Listed apps' })
  const [installedText = '', systemText = '', disabledText = '', allText = ''] = text.split(MARK)

  const installed = parsePackageList(installedText)
  const system = new Set(parsePackageList(systemText).map((p) => p.packageName))
  const disabled = new Set(parsePackageList(disabledText).map((p) => p.packageName))
  const all = parsePackageList(allText)
  const installedNames = new Set(installed.map((p) => p.packageName))

  const registry = new Map<string, PackageListEntry>()
  for (const p of [...all, ...installed]) registry.set(p.packageName, { ...registry.get(p.packageName), ...p })
  knownPackages.set(serial, registry)

  const apps: AppEntry[] = []
  for (const p of registry.values()) {
    // Packages missing from the installed list but present in -u are "removed for user 0".
    const removed = !installedNames.has(p.packageName)
    const isSystem = system.has(p.packageName) || !!p.apkPath?.match(/^\/(system|product|vendor|system_ext|odm|apex)\//)
    const known = classifyPackage(p.packageName, isSystem)
    const cached = cachedLabel(p.packageName, p.versionCode)
    const label = cached || known.name
    apps.push({
      packageName: p.packageName,
      label,
      labelResolved: !!cached || !!lookupPackage(p.packageName),
      description: known.description,
      safety: known.safety,
      isSystem,
      enabled: !disabled.has(p.packageName),
      removed,
      // Only system apps keep an install file in the system image to restore from.
      restorable: removed ? isSystem : undefined,
      apkPath: p.apkPath,
      versionCode: p.versionCode,
      uid: p.uid,
      // Icons are fetched per visible row (apps:meta) to keep this list small.
    })
  }
  apps.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }))
  return apps
}

/** Resolve names & icons for a batch of packages, a few at a time. */
export async function appMeta(serial: string, packages: string[]): Promise<AppMeta[]> {
  // No requireOnline here: cached names/icons are served even while the phone is away.
  const registry = knownPackages.get(serial)
  const results: AppMeta[] = []
  const queue = [...packages]
  const workers = Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const pkg = queue.shift()!
      const info = registry?.get(pkg)
      results.push(await getAppMeta(serial, pkg, info?.apkPath, info?.versionCode))
    }
  })
  await Promise.all(workers)
  return results
}

function checkResult(output: string, okPattern: RegExp, action: string): void {
  if (okPattern.test(output)) return
  const failure = /Failure \[([^\]]+)\]/.exec(output)?.[1] ?? output.trim().split(/\r?\n/).pop() ?? ''
  if (/not installed for/i.test(failure)) {
    throw new AppError({ title: 'Already removed', message: 'This app is already removed for your user.', code: 'ALREADY_REMOVED' })
  }
  if (/DELETE_FAILED_DEVICE_POLICY_MANAGER/i.test(failure)) {
    throw new AppError({
      title: 'Protected by a device admin',
      message: 'This app is a device administrator (for example, a work or security app).',
      hint: 'Remove it from Settings → Security → Device admin apps first.'
    })
  }
  if (/DELETE_FAILED_USER_RESTRICTED|DELETE_FAILED_OWNER_BLOCKED/i.test(failure)) {
    throw new AppError({ title: 'Blocked by the phone', message: 'Your phone doesn’t allow removing this app.' })
  }
  throw new AppError({ title: `Couldn’t ${action}`, message: failure || 'The phone refused the request.', hint: 'Check the Activity Log for details.' })
}

function guardCore(pkg: string, allowCore?: boolean): void {
  const info = classifyPackage(pkg, true)
  if (info.safety === 'core' && !allowCore) {
    throw new AppError({
      title: 'Core system app is locked',
      message: `${info.name} is part of Android. Removing it can stop your phone from starting.`,
      hint: 'If you really know what you’re doing, unlock it first.',
      code: 'CORE_LOCKED'
    })
  }
  if (pkg === 'com.android.shell') {
    throw new AppError({ title: 'Can’t remove this', message: 'Easy ADB needs this component to talk to your phone.' })
  }
}

/** True when the package ships in the system image (so a per-user removal can be undone). */
export async function isSystemPackage(serial: string, pkg: string): Promise<boolean> {
  const out = await shell(serial, shellCommand('pm', 'list', 'packages', '-s', '-u', '--user', '0', pkg), { allowFailure: true })
  return parsePackageList(out).some((p) => p.packageName === pkg)
}

export async function removeApp(serial: string, pkg: string, allowCore?: boolean): Promise<void> {
  requireOnline(serial)
  assertPackage(pkg)
  guardCore(pkg, allowCore)
  // "Remove for this user" is only reversible for apps that live in the system image.
  // For regular apps (even ones the seller pre-installed) Android deletes the APK.
  if (!(await isSystemPackage(serial, pkg))) {
    throw new AppError({
      title: 'Use “Uninstall” for this app',
      message: 'This is a regular app, not part of Android’s system image, so Easy ADB can’t keep a copy to restore later.',
      hint: 'Uninstall it instead — you can reinstall it from the app store any time.',
      code: 'NOT_SYSTEM_APP'
    })
  }
  const out = await shell(serial, shellCommand('pm', 'uninstall', '-k', '--user', '0', pkg), {
    log: `Removing ${pkg} for this user`,
    allowFailure: true
  })
  if (/only root can delete system app/i.test(out)) {
    // Newer Android versions (17+) no longer allow per-user removal of system apps over adb.
    throw new AppError({
      title: 'Android only allows turning this app off',
      message: 'This Android version doesn’t let computers remove pre-installed apps anymore. Turning it off has the same everyday effect: it stops running and disappears from your app drawer.',
      hint: 'Use “Turn off” instead — you can turn it back on any time.',
      code: 'REMOVE_BLOCKED'
    })
  }
  checkResult(out, /^Success/m, 'remove this app')
  logSuccess(`Removed ${pkg} for this user (restore it anytime)`)
  emit('apps:changed', { serial })
}

export async function disableApp(serial: string, pkg: string, allowCore?: boolean): Promise<void> {
  requireOnline(serial)
  assertPackage(pkg)
  guardCore(pkg, allowCore)
  const out = await shell(serial, shellCommand('pm', 'disable-user', '--user', '0', pkg), {
    log: `Turning off ${pkg}`,
    allowFailure: true
  })
  checkResult(out, /new state: disabled/i, 'turn off this app')
  logSuccess(`Turned off ${pkg}`)
  emit('apps:changed', { serial })
}

export async function enableApp(serial: string, pkg: string): Promise<void> {
  requireOnline(serial)
  assertPackage(pkg)
  const out = await shell(serial, shellCommand('pm', 'enable', '--user', '0', pkg), { log: `Turning on ${pkg}`, allowFailure: true })
  checkResult(out, /new state: enabled/i, 'turn on this app')
  logSuccess(`Turned on ${pkg}`)
  emit('apps:changed', { serial })
}

export async function restoreApp(serial: string, pkg: string): Promise<void> {
  requireOnline(serial)
  assertPackage(pkg)
  let out = await shell(serial, shellCommand('cmd', 'package', 'install-existing', '--user', '0', pkg), {
    log: `Restoring ${pkg}`,
    allowFailure: true
  })
  if (!/installed for user/i.test(out)) {
    out = await shell(serial, shellCommand('pm', 'install-existing', '--user', '0', pkg), { log: `Restoring ${pkg} (fallback)`, allowFailure: true })
  }
  if (/NameNotFoundException|doesn't exist/i.test(out)) {
    // The APK is gone (a regular app removed with -k): only a reinstall brings it back.
    throw new AppError({
      title: 'Needs a reinstall',
      message: 'This app’s install file is no longer on the phone, so it can’t be restored directly. Its data was kept.',
      hint: 'Reinstall it from the app store — it comes back with your data.',
      code: 'NEEDS_REINSTALL'
    })
  }
  checkResult(out, /installed for user/i, 'restore this app')
  logSuccess(`Restored ${pkg}`)
  // Make sure it's also enabled.
  await shell(serial, shellCommand('pm', 'enable', '--user', '0', pkg), { allowFailure: true }).catch(() => undefined)
  emit('apps:changed', { serial })
}

export async function uninstallApp(serial: string, pkg: string): Promise<void> {
  requireOnline(serial)
  assertPackage(pkg)
  guardCore(pkg, false)
  const out = await shell(serial, shellCommand('pm', 'uninstall', pkg), { log: `Uninstalling ${pkg}`, allowFailure: true, timeoutMs: 60_000 })
  checkResult(out, /^Success/m, 'uninstall this app')
  logSuccess(`Uninstalled ${pkg}`)
  emit('apps:changed', { serial })
}

/** Open the app's page in Galaxy Store (Samsung apps) or Google Play on the phone. */
export async function openStorePage(serial: string, pkg: string): Promise<void> {
  requireOnline(serial)
  assertPackage(pkg)
  const samsung = /^com\.(samsung|sec)\./.test(pkg)
  const uris = samsung ? [`samsungapps://ProductDetail/${pkg}`, `market://details?id=${pkg}`] : [`market://details?id=${pkg}`]
  for (const uri of uris) {
    const out = await shell(serial, shellCommand('am', 'start', '-a', 'android.intent.action.VIEW', '-d', uri), {
      log: `Opening the store page for ${pkg} on the phone`,
      allowFailure: true
    })
    if (!/Error|unable to resolve/i.test(out)) return
  }
  throw new AppError({ title: 'No app store found', message: 'Your phone doesn’t have Galaxy Store or Google Play to reinstall this app from.' })
}

export async function launchApp(serial: string, pkg: string): Promise<void> {
  requireOnline(serial)
  assertPackage(pkg)
  const out = await shell(serial, shellCommand('monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'), {
    log: `Opening ${pkg} on the phone`,
    allowFailure: true
  })
  if (/No activities found/i.test(out)) {
    throw new AppError({ title: 'Can’t open this app', message: 'This app has no screen that can be opened directly.' })
  }
}
