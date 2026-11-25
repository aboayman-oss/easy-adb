// Logic for choosing which APKs (and OBB files) to install from split-APK bundles
// (.xapk, .apks, .apkm). Pure: works on entry names + optional manifest JSON.

export type BundleKind = 'apk' | 'xapk' | 'apks' | 'apkm'

export interface BundleEntry {
  name: string
  size: number
}

export interface BundlePlan {
  apks: string[]
  obbs: { entry: string; devicePath: string }[]
  packageName?: string
  appName?: string
  versionName?: string
}

export interface DeviceConfig {
  abis: string[] // e.g. ["arm64-v8a", "armeabi-v7a"]
  densityDpi: number
}

export function bundleKindFromName(fileName: string): BundleKind | null {
  const ext = fileName.toLowerCase().split('.').pop()
  if (ext === 'apk' || ext === 'xapk' || ext === 'apks' || ext === 'apkm') return ext
  return null
}

const ABI_TOKENS: Record<string, string> = {
  arm64_v8a: 'arm64-v8a',
  armeabi_v7a: 'armeabi-v7a',
  armeabi: 'armeabi',
  x86_64: 'x86_64',
  x86: 'x86',
  mips64: 'mips64',
  mips: 'mips'
}

const DENSITY_TOKENS: Record<string, number> = {
  ldpi: 120,
  mdpi: 160,
  tvdpi: 213,
  hdpi: 240,
  xhdpi: 320,
  xxhdpi: 480,
  xxxhdpi: 640
}

function baseName(entry: string): string {
  return entry.slice(entry.lastIndexOf('/') + 1)
}

/** Split identifier tokens of an APK name, e.g. "split_config.arm64_v8a.apk" → ["split","config","arm64_v8a"]. */
function tokens(fileName: string): string[] {
  return fileName
    .replace(/\.apk$/i, '')
    .split(/[.\-]+/)
    .flatMap((t) => (t.startsWith('split_') ? ['split', t.slice(6)] : [t]))
    .filter(Boolean)
}

export function splitAbi(fileName: string): string | null {
  for (const t of tokens(fileName)) if (ABI_TOKENS[t]) return ABI_TOKENS[t]
  return null
}

export function splitDensity(fileName: string): number | null {
  for (const t of tokens(fileName)) if (DENSITY_TOKENS[t] !== undefined) return DENSITY_TOKENS[t]
  return null
}

/**
 * Choose which split APKs to install for this device:
 *  - keep every non-config split (base + feature splits + language splits)
 *  - keep only the best-matching ABI split
 *  - keep only the closest density split
 */
export function selectSplits(apks: string[], device?: DeviceConfig): string[] {
  if (!device || apks.length <= 1) return [...apks]
  const abiSplits = apks.filter((a) => splitAbi(baseName(a)))
  const densitySplits = apks.filter((a) => splitDensity(baseName(a)) !== null)
  const others = apks.filter((a) => !abiSplits.includes(a) && !densitySplits.includes(a))

  const chosen = [...others]

  if (abiSplits.length) {
    let pick: string | undefined
    for (const abi of device.abis) {
      pick = abiSplits.find((a) => splitAbi(baseName(a)) === abi)
      if (pick) break
    }
    if (pick) chosen.push(pick)
    else chosen.push(...abiSplits) // let Android decide / report the mismatch
  }

  if (densitySplits.length) {
    const sorted = [...densitySplits].sort(
      (a, b) =>
        Math.abs((splitDensity(baseName(a)) ?? 0) - device.densityDpi) -
        Math.abs((splitDensity(baseName(b)) ?? 0) - device.densityDpi)
    )
    chosen.push(sorted[0])
  }

  // Keep the base APK first — some Android versions are picky about ordering.
  return chosen.sort((a, b) => rankBase(a) - rankBase(b))
}

function rankBase(entry: string): number {
  const n = baseName(entry).toLowerCase()
  if (n === 'base.apk' || n === 'base-master.apk') return 0
  if (!n.includes('split') && !n.includes('config')) return 1
  return 2
}

interface XapkManifest {
  package_name?: string
  name?: string
  version_name?: string
  split_apks?: { file: string; id?: string }[]
  expansions?: { file: string; install_location?: string; install_path?: string }[]
}

interface ApkmInfo {
  pname?: string
  app_name?: string
  release_version?: string
}

/** Plan an installation from the list of entries inside a bundle archive. */
export function planBundle(
  kind: BundleKind,
  entries: BundleEntry[],
  manifestJson?: string,
  device?: DeviceConfig
): BundlePlan {
  const names = entries.map((e) => e.name).filter((n) => !n.endsWith('/'))
  let apks = names.filter((n) => n.toLowerCase().endsWith('.apk'))
  const plan: BundlePlan = { apks: [], obbs: [] }

  if (kind === 'xapk' && manifestJson) {
    try {
      const manifest = JSON.parse(manifestJson) as XapkManifest
      plan.packageName = manifest.package_name
      plan.appName = manifest.name
      plan.versionName = manifest.version_name
      if (manifest.split_apks?.length) {
        const listed = manifest.split_apks.map((s) => s.file).filter((f) => names.includes(f))
        if (listed.length) apks = listed
      }
      for (const exp of manifest.expansions ?? []) {
        if (!names.includes(exp.file)) continue
        const target = (exp.install_path || exp.file).replace(/^\/+/, '')
        plan.obbs.push({ entry: exp.file, devicePath: '/sdcard/' + target })
      }
    } catch {
      // fall through to filename-based detection
    }
  }

  if (kind === 'apkm' && manifestJson) {
    try {
      const info = JSON.parse(manifestJson) as ApkmInfo
      plan.packageName = info.pname
      plan.appName = info.app_name
      plan.versionName = info.release_version
    } catch {
      /* ignore */
    }
  }

  // OBB files laid out as Android/obb/<pkg>/<file>.obb (XAPK without manifest entries).
  if (plan.obbs.length === 0) {
    for (const n of names) {
      if (!n.toLowerCase().endsWith('.obb')) continue
      const idx = n.indexOf('Android/obb/')
      const target = idx >= 0 ? n.slice(idx) : `Android/obb/${plan.packageName ?? 'unknown'}/${baseName(n)}`
      plan.obbs.push({ entry: n, devicePath: '/sdcard/' + target })
    }
  }

  // bundletool .apks: prefer splits/ over standalones/ and ignore universal duplicates.
  if (apks.some((a) => a.startsWith('splits/'))) apks = apks.filter((a) => a.startsWith('splits/'))
  else if (apks.some((a) => a.startsWith('standalones/')) && !apks.some((a) => !a.includes('/'))) {
    const standalone = apks.filter((a) => a.startsWith('standalones/'))
    const abiMatch = device
      ? device.abis.map((abi) => standalone.find((s) => splitAbi(baseName(s)) === abi)).find(Boolean)
      : undefined
    apks = [abiMatch ?? standalone[0]]
  }
  const universal = apks.find((a) => /(^|\/)universal\.apk$/i.test(a))
  if (universal && apks.length > 1) apks = apks.filter((a) => a !== universal)

  plan.apks = selectSplits(apks, device)
  return plan
}
