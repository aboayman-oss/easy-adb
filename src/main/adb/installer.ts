// Smart installer for .apk, .xapk, .apks and .apkm files.
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { InstallAnalysis, InstallProgress } from '@shared/types'
import { ResourceTable, summarizeManifest } from '../lib/apk'
import { bundleKindFromName, planBundle, type BundleKind } from '../lib/bundle'
import { AppError, toFriendlyError } from '../lib/errors'
import { isInstallSuccess, translateInstallError } from '../lib/installErrors'
import { emit } from '../services/events'
import { logError, logSuccess } from '../services/log'
import { extractZip, listZip, readZipEntry } from '../engine/download'
import { tempDir } from '../engine/paths'
import { deviceConfig } from './deviceInfo'
import { pushFile } from './files'
import { adb, shell } from './runner'
import { shellCommand } from '../lib/paths'
import { requireOnline } from './tracker'

function kindOrThrow(file: string): BundleKind {
  const kind = bundleKindFromName(file)
  if (!kind) {
    throw new AppError({
      title: 'Unsupported file',
      message: 'Easy ADB can install .apk, .xapk, .apks and .apkm files.',
      code: 'UNSUPPORTED_FILE'
    })
  }
  return kind
}

async function manifestFor(kind: BundleKind, file: string): Promise<string | undefined> {
  if (kind === 'xapk') return (await readZipEntry(file, 'manifest.json'))?.toString('utf8')
  if (kind === 'apkm') return (await readZipEntry(file, 'info.json'))?.toString('utf8')
  return undefined
}

async function apkLabel(apkFile: string): Promise<{ packageName?: string; appName?: string; versionName?: string }> {
  try {
    const manifestBuf = await readZipEntry(apkFile, 'AndroidManifest.xml')
    if (!manifestBuf) return {}
    const m = summarizeManifest(manifestBuf)
    let appName: string | undefined
    const arsc = await readZipEntry(apkFile, 'resources.arsc', 32 * 1024 * 1024)
    if (arsc) appName = new ResourceTable(arsc).resolveString(m.label)
    return { packageName: m.packageName, appName: appName ?? m.label?.raw, versionName: m.versionName }
  } catch {
    return {}
  }
}

export async function analyzeInstall(file: string): Promise<InstallAnalysis> {
  const kind = kindOrThrow(file)
  const size = statSync(file).size
  const fileName = basename(file)
  if (kind === 'apk') {
    const info = await apkLabel(file)
    return { file, fileName, kind, ...info, apkCount: 1, obbCount: 0, totalBytes: size }
  }
  let entries: { name: string; size: number }[]
  try {
    entries = await listZip(file)
  } catch {
    throw new AppError({
      title: 'Can’t open this bundle',
      message:
        kind === 'apkm'
          ? 'This .apkm file is protected or damaged. Newer .apkm files can only be opened by the APKMirror Installer app.'
          : 'The file is damaged or isn’t a real app bundle.',
      hint: 'Try downloading it again.',
      code: 'BAD_BUNDLE'
    })
  }
  const plan = planBundle(kind, entries, await manifestFor(kind, file))
  if (plan.apks.length === 0) {
    throw new AppError({
      title: 'No app inside',
      message: kind === 'apkm' ? 'This .apkm file appears to be encrypted.' : 'This bundle doesn’t contain any installable app files.',
      code: 'EMPTY_BUNDLE'
    })
  }
  if (!plan.appName || !plan.packageName) {
    // No metadata file (typical for .apks): read the name from the base APK inside.
    const work = tempDir('analyze', randomUUID())
    try {
      const base = plan.apks[0]
      await extractZip(file, work, { filter: (n) => n === base })
      const info = await apkLabel(join(work, ...base.split('/')))
      plan.appName ??= info.appName
      plan.packageName ??= info.packageName
      plan.versionName ??= info.versionName
    } catch {
      /* the name is optional */
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }
  return {
    file,
    fileName,
    kind,
    packageName: plan.packageName,
    appName: plan.appName,
    versionName: plan.versionName,
    apkCount: plan.apks.length,
    obbCount: plan.obbs.length,
    totalBytes: size
  }
}

export function runInstall(serial: string, file: string): string {
  requireOnline(serial)
  const kind = kindOrThrow(file)
  const id = randomUUID()
  const fileName = basename(file)
  const report = (p: Omit<InstallProgress, 'id' | 'fileName'>): void => emit('install:progress', { id, fileName, ...p })

  void (async () => {
    const work = tempDir('install', id)
    try {
      report({ stage: 'preparing', percent: 3, message: 'Getting ready…' })
      const output: string[] = []
      let packageName: string | undefined

      if (kind === 'apk') {
        report({ stage: 'installing', percent: 30, message: 'Installing on your phone… (watch your phone for prompts)' })
        const res = await adb(['install', '-r', file], { serial, timeoutMs: 10 * 60_000, allowFailure: true, log: `Installing ${fileName}` })
        output.push(res.stdout, res.stderr)
      } else {
        const device = await deviceConfig(serial)
        const entries = await listZip(file)
        const plan = planBundle(kind, entries, await manifestFor(kind, file), { abis: device.abis, densityDpi: device.densityDpi })
        packageName = plan.packageName
        if (!plan.apks.length) throw new AppError({ title: 'No app inside', message: 'This bundle doesn’t contain any installable app files.' })

        report({ stage: 'extracting', percent: 8, message: `Unpacking ${plan.apks.length} app part${plan.apks.length > 1 ? 's' : ''}…` })
        mkdirSync(work, { recursive: true })
        const wanted = new Set([...plan.apks, ...plan.obbs.map((o) => o.entry)])
        let done = 0
        await extractZip(file, work, {
          filter: (n) => wanted.has(n),
          onEntry: () => {
            done++
            report({ stage: 'extracting', percent: 8 + Math.round((done / wanted.size) * 20), message: 'Unpacking…' })
          }
        })
        const apkFiles = plan.apks.map((a) => join(work, ...a.split('/')))

        report({ stage: 'installing', percent: 30, message: 'Installing on your phone… (watch your phone for prompts)' })
        const res = await adb([apkFiles.length > 1 ? 'install-multiple' : 'install', '-r', ...apkFiles], {
          serial,
          timeoutMs: 15 * 60_000,
          allowFailure: true,
          log: `Installing ${fileName} (${apkFiles.length} parts)`
        })
        output.push(res.stdout, res.stderr)

        if (isInstallSuccess(output.join('\n')) && plan.obbs.length) {
          const totalObb = plan.obbs.reduce((s, o) => s + statSync(join(work, ...o.entry.split('/'))).size, 0)
          let sent = 0
          for (const obb of plan.obbs) {
            const dir = obb.devicePath.slice(0, obb.devicePath.lastIndexOf('/'))
            await shell(serial, shellCommand('mkdir', '-p', dir))
            await pushFile(serial, join(work, ...obb.entry.split('/')), obb.devicePath, (n) => {
              sent += n
              report({
                stage: 'copying-obb',
                percent: 90 + Math.round((sent / Math.max(totalObb, 1)) * 9),
                message: 'Copying game data…'
              })
            })
          }
        }
      }

      const text = output.join('\n')
      if (!isInstallSuccess(text)) {
        const friendly = translateInstallError(text)
        logError(`Install failed: ${fileName} — ${friendly.code ?? ''}`)
        report({ stage: 'error', percent: 100, message: friendly.title, error: friendly })
        return
      }
      logSuccess(`Installed ${fileName}${packageName ? ` (${packageName})` : ''}`)
      report({ stage: 'done', percent: 100, message: 'Installed!' })
      emit('apps:changed', { serial })
    } catch (e) {
      const friendly = toFriendlyError(e)
      logError(`Install failed: ${fileName} — ${friendly.message}`)
      report({ stage: 'error', percent: 100, message: friendly.title, error: friendly })
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })()

  return id
}
