// Zero-setup engine: downloads, verifies and installs the official Android
// platform-tools (adb) and scrcpy into the app-data folder.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { chmod } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { EngineComponent, EngineProgress, EngineStatus, EngineUpdateInfo } from '@shared/types'
import {
  googleHostOs,
  GOOGLE_REPO_MANIFESTS,
  parsePlatformToolsManifest,
  parseSha256Sums,
  pickScrcpyAsset,
  platformToolsLatestUrl,
  SCRCPY_LATEST_API,
  type PlatformToolsRelease,
  type ReleaseAsset
} from '../lib/engineManifest'
import { compareVersions, parseAdbVersion, parseScrcpyVersion } from '../lib/parsers'
import { AppError } from '../lib/errors'
import { emit } from '../services/events'
import { logError, logInfo, logSuccess } from '../services/log'
import { downloadFile, extractTarGz, extractZip, fetchText, hashFile } from './download'
import {
  adbPath,
  engineDir,
  engineManifestPath,
  hasAdb,
  hasScrcpy,
  platformToolsDir,
  scrcpyDir,
  scrcpyPath
} from './paths'

interface EngineManifest {
  adb?: { version?: string; installedAt: number }
  scrcpy?: { version?: string; installedAt: number }
}

let installing: Promise<EngineStatus> | null = null
let beforeReplace: (() => Promise<void>) | null = null

/** Hook used to stop the adb server before its binary is replaced. */
export function setBeforeEngineReplace(fn: () => Promise<void>): void {
  beforeReplace = fn
}

function readManifest(): EngineManifest {
  try {
    return JSON.parse(readFileSync(engineManifestPath(), 'utf8')) as EngineManifest
  } catch {
    return {}
  }
}

function writeManifest(m: EngineManifest): void {
  mkdirSync(engineDir(), { recursive: true })
  writeFileSync(engineManifestPath(), JSON.stringify(m, null, 2))
}

function execVersion(file: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 20_000, env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      const text = `${stdout ?? ''}\n${stderr ?? ''}`
      if (err && !text.trim()) reject(err)
      else resolve(text)
    })
  })
}

export function engineStatus(): EngineStatus {
  const manifest = readManifest()
  const adbInstalled = hasAdb()
  const scrcpyInstalled = hasScrcpy()
  return {
    ready: adbInstalled && scrcpyInstalled,
    dir: engineDir(),
    adb: { installed: adbInstalled, version: manifest.adb?.version, path: adbInstalled ? adbPath() : undefined },
    scrcpy: { installed: scrcpyInstalled, version: manifest.scrcpy?.version, path: scrcpyInstalled ? scrcpyPath() : undefined }
  }
}

function progress(p: EngineProgress): void {
  emit('engine:progress', p)
}

// ---------------------------------------------------------------------------
// Release discovery

export async function latestPlatformTools(): Promise<PlatformToolsRelease> {
  const hostOs = googleHostOs(process.platform)
  for (const url of GOOGLE_REPO_MANIFESTS) {
    try {
      const xml = await fetchText(url, 45_000)
      const rel = parsePlatformToolsManifest(xml, hostOs)
      if (rel) return rel
    } catch {
      // try next manifest
    }
  }
  return { version: 'latest', url: platformToolsLatestUrl(process.platform) }
}

export async function latestScrcpy(): Promise<{ version: string; asset: ReleaseAsset; sha256?: string }> {
  const json = JSON.parse(await fetchText(SCRCPY_LATEST_API)) as { tag_name: string; assets: ReleaseAsset[] }
  const asset = pickScrcpyAsset(json.assets, process.platform, process.arch)
  if (!asset) throw new Error('No scrcpy download is available for this computer.')
  let sha256: string | undefined
  const sums = json.assets.find((a) => a.name === 'SHA256SUMS.txt')
  if (sums) {
    try {
      sha256 = parseSha256Sums(await fetchText(sums.browser_download_url))[asset.name]
    } catch {
      /* checksum is best-effort */
    }
  }
  return { version: json.tag_name.replace(/^v/, ''), asset, sha256 }
}

// ---------------------------------------------------------------------------
// Installation

/** Find the directory inside `root` that directly contains `fileName`. */
function findDirContaining(root: string, fileName: string, depth = 3): string | null {
  if (existsSync(join(root, fileName))) return root
  if (depth === 0) return null
  for (const name of readdirSync(root)) {
    const full = join(root, name)
    if (statSync(full).isDirectory()) {
      const hit = findDirContaining(full, fileName, depth - 1)
      if (hit) return hit
    }
  }
  return null
}

function tryRemove(path: string): boolean {
  try {
    rmSync(path, { recursive: true, force: true })
    return !existsSync(path)
  } catch {
    return false
  }
}

/**
 * Remove leftovers from earlier updates (old folders whose files were still in use,
 * interrupted downloads). Safe to call at startup; anything still locked is skipped.
 */
export function cleanupEngineLeftovers(): void {
  const dir = engineDir()
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    if (/\.old(-\d+)?$/.test(name) || name.startsWith('.staging-') || name === '.downloads') tryRemove(join(dir, name))
  }
}

async function replaceDir(staged: string, target: string): Promise<void> {
  // A previous old folder may still be in use (e.g. a running adb server) — then pick a fresh name.
  let old = target + '.old'
  if (existsSync(old) && !tryRemove(old)) old = `${target}.old-${Date.now()}`
  if (existsSync(target)) {
    try {
      renameSync(target, old)
    } catch {
      // Files are in use — most likely an adb server started from this folder.
      // Only now stop it (another tool's adb server doesn't lock our files).
      logInfo('Engine files are in use — stopping the connection engine to update them')
      if (beforeReplace) await beforeReplace().catch(() => undefined)
      // Windows may hold a lock briefly after the adb server exits.
      for (let attempt = 0; ; attempt++) {
        try {
          renameSync(target, old)
          break
        } catch (e) {
          if (attempt >= 15) throw e
          await new Promise((r) => setTimeout(r, 400))
        }
      }
    }
  }
  renameSync(staged, target)
  // Windows lets a folder be renamed while a program inside it runs, but not deleted.
  // A still-running adb server keeps working from the old folder; it's cleaned up later.
  if (!tryRemove(old)) logInfo('The previous engine files are still in use — they’ll be removed next time Easy ADB starts')
}

async function makeExecutable(dir: string): Promise<void> {
  if (process.platform === 'win32') return
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isFile() && !name.includes('.')) await chmod(full, 0o755).catch(() => undefined)
  }
}

async function installPlatformTools(base: number, span: number): Promise<string | undefined> {
  const component: EngineComponent = 'platform-tools'
  progress({ phase: 'checking', component, percent: base, message: 'Finding the latest Android tools from Google…' })
  const rel = await latestPlatformTools()
  const downloads = join(engineDir(), '.downloads')
  const zipPath = join(downloads, basename(new URL(rel.url).pathname))
  logInfo(`Downloading Android platform-tools ${rel.version}`, { command: rel.url })

  await downloadFile(rel.url, zipPath, ({ received, total }) => {
    const frac = total ? received / total : 0
    progress({
      phase: 'downloading',
      component,
      percent: Math.round(base + span * 0.8 * frac),
      message: `Downloading Android connection tools… ${formatMb(received)}${total ? ` of ${formatMb(total)}` : ''}`
    })
  })

  if (rel.sha1) {
    progress({ phase: 'verifying', component, percent: Math.round(base + span * 0.82), message: 'Checking the download is genuine…' })
    const actual = await hashFile(zipPath, 'sha1')
    if (actual !== rel.sha1) throw new Error('The downloaded file did not match Google’s checksum. Please try again.')
  }

  progress({ phase: 'extracting', component, percent: Math.round(base + span * 0.86), message: 'Unpacking…' })
  const staging = join(engineDir(), '.staging-platform-tools')
  rmSync(staging, { recursive: true, force: true })
  await extractZip(zipPath, staging)
  const adbName = process.platform === 'win32' ? 'adb.exe' : 'adb'
  const found = findDirContaining(staging, adbName)
  if (!found) throw new Error('The Android tools package looks incomplete.')
  await makeExecutable(found)

  progress({ phase: 'verifying', component, percent: Math.round(base + span * 0.95), message: 'Testing the connection engine…' })
  const versionText = await execVersion(join(found, adbName), ['version'])
  const version = parseAdbVersion(versionText)
  if (!version) throw new Error('The Android tools could not be started on this computer.')

  await replaceDir(found, platformToolsDir())
  rmSync(staging, { recursive: true, force: true })
  rmSync(zipPath, { force: true })
  logSuccess(`Android platform-tools ${version} ready`)
  return version
}

async function installScrcpy(base: number, span: number): Promise<string | undefined> {
  const component: EngineComponent = 'scrcpy'
  progress({ phase: 'checking', component, percent: base, message: 'Finding the latest screen-mirroring engine…' })
  const rel = await latestScrcpy()
  const downloads = join(engineDir(), '.downloads')
  const archive = join(downloads, rel.asset.name)
  logInfo(`Downloading scrcpy ${rel.version}`, { command: rel.asset.browser_download_url })

  await downloadFile(rel.asset.browser_download_url, archive, ({ received, total }) => {
    const frac = total ? received / total : 0
    progress({
      phase: 'downloading',
      component,
      percent: Math.round(base + span * 0.8 * frac),
      message: `Downloading screen mirroring… ${formatMb(received)}${total ? ` of ${formatMb(total)}` : ''}`
    })
  })

  if (rel.sha256) {
    progress({ phase: 'verifying', component, percent: Math.round(base + span * 0.82), message: 'Checking the download is genuine…' })
    const actual = await hashFile(archive, 'sha256')
    if (actual !== rel.sha256) throw new Error('The downloaded file did not match the published checksum. Please try again.')
  }

  progress({ phase: 'extracting', component, percent: Math.round(base + span * 0.86), message: 'Unpacking…' })
  const staging = join(engineDir(), '.staging-scrcpy')
  rmSync(staging, { recursive: true, force: true })
  if (archive.endsWith('.zip')) await extractZip(archive, staging)
  else await extractTarGz(archive, staging)
  const exeName = process.platform === 'win32' ? 'scrcpy.exe' : 'scrcpy'
  const found = findDirContaining(staging, exeName)
  if (!found) throw new Error('The screen-mirroring package looks incomplete.')
  await makeExecutable(found)

  progress({ phase: 'verifying', component, percent: Math.round(base + span * 0.95), message: 'Testing screen mirroring…' })
  let version = rel.version
  try {
    version = parseScrcpyVersion(await execVersion(join(found, exeName), ['--version'])) ?? rel.version
  } catch {
    // Some systems block `--version` without a display; the checksum already verified the files.
  }

  await replaceDir(found, scrcpyDir())
  rmSync(staging, { recursive: true, force: true })
  rmSync(archive, { force: true })
  logSuccess(`scrcpy ${version} ready`)
  return version
}

function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Make sure adb and scrcpy are installed. Safe to call repeatedly (single flight). */
export function ensureEngine(opts: { force?: boolean; components?: EngineComponent[] } = {}): Promise<EngineStatus> {
  if (installing) return installing
  installing = (async () => {
    const wanted = opts.components ?? ['platform-tools', 'scrcpy']
    const needAdb = wanted.includes('platform-tools') && (opts.force || !hasAdb())
    const needScrcpy = wanted.includes('scrcpy') && (opts.force || !hasScrcpy())
    mkdirSync(engineDir(), { recursive: true })
    const manifest = readManifest()
    try {
      if (!needAdb && !needScrcpy) {
        progress({ phase: 'done', percent: 100, message: 'Engine ready' })
        return engineStatus()
      }
      const adbSpan = needAdb && needScrcpy ? 55 : needAdb ? 100 : 0
      if (needAdb) {
        const version = await installPlatformTools(0, adbSpan)
        manifest.adb = { version, installedAt: Date.now() }
        writeManifest(manifest)
      }
      if (needScrcpy) {
        const version = await installScrcpy(adbSpan, 100 - adbSpan)
        manifest.scrcpy = { version, installedAt: Date.now() }
        writeManifest(manifest)
      }
      progress({ phase: 'done', percent: 100, message: 'Engine ready' })
      return engineStatus()
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      logError(`Engine setup failed: ${message}`)
      const friendly = /fetch|network|ENOTFOUND|ECONN|ETIMEDOUT|ERR_/i.test(message)
        ? {
            title: 'No internet connection',
            message: 'Easy ADB needs the internet to download its engine. Check your connection and try again.'
          }
        : /EPERM|EBUSY|EACCES/i.test(message)
          ? {
              title: 'Engine files are in use',
              message: 'Another program is using Easy ADB’s engine files.',
              hint: 'Close other Android tools, or restart Easy ADB, then try again.'
            }
          : /checksum/i.test(message)
            ? { title: 'Download was damaged', message: 'The download didn’t pass the safety check, so it wasn’t installed.', hint: 'Try again.' }
            : { title: 'Couldn’t prepare the engine', message, hint: 'Try again, or check the Activity Log.' }
      progress({ phase: 'error', percent: 0, message: 'We couldn’t finish preparing the engine.', error: friendly.message })
      throw new AppError({ ...friendly, code: 'ENGINE_SETUP' }, { cause: e })
    } finally {
      rmSync(join(engineDir(), '.downloads'), { recursive: true, force: true })
    }
  })().finally(() => {
    installing = null
  })
  return installing
}

/** Re-read installed versions from the binaries (used after manual repairs). */
export async function refreshInstalledVersions(): Promise<void> {
  const manifest = readManifest()
  if (hasAdb()) {
    try {
      manifest.adb = { version: parseAdbVersion(await execVersion(adbPath(), ['version'])), installedAt: manifest.adb?.installedAt ?? Date.now() }
    } catch {
      /* ignore */
    }
  }
  writeManifest(manifest)
}

export async function checkEngineUpdates(): Promise<EngineUpdateInfo> {
  const status = engineStatus()
  const [pt, sc] = await Promise.allSettled([latestPlatformTools(), latestScrcpy()])
  const ptLatest = pt.status === 'fulfilled' ? pt.value.version : undefined
  const scLatest = sc.status === 'fulfilled' ? sc.value.version : undefined
  const adbCurrent = status.adb.version
  const scrcpyCurrent = status.scrcpy.version
  return {
    adb: {
      current: adbCurrent,
      latest: ptLatest,
      updateAvailable: !!(ptLatest && ptLatest !== 'latest' && (!adbCurrent || compareVersions(ptLatest, adbCurrent) > 0))
    },
    scrcpy: {
      current: scrcpyCurrent,
      latest: scLatest,
      updateAvailable: !!(scLatest && (!scrcpyCurrent || compareVersions(scLatest, scrcpyCurrent) > 0))
    }
  }
}
