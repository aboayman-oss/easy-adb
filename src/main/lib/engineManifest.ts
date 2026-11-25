// Pure helpers for locating official engine downloads.

export const GOOGLE_REPO_BASE = 'https://dl.google.com/android/repository/'
export const GOOGLE_REPO_MANIFESTS = [GOOGLE_REPO_BASE + 'repository2-3.xml', GOOGLE_REPO_BASE + 'repository2-1.xml']
export const SCRCPY_LATEST_API = 'https://api.github.com/repos/Genymobile/scrcpy/releases/latest'

export interface PlatformToolsRelease {
  version: string
  url: string
  sha1?: string
  size?: number
}

export function googleHostOs(platform: NodeJS.Platform): 'windows' | 'macosx' | 'linux' {
  if (platform === 'win32') return 'windows'
  if (platform === 'darwin') return 'macosx'
  return 'linux'
}

/** "Latest" fallback URL when the repository manifest can't be read. */
export function platformToolsLatestUrl(platform: NodeJS.Platform): string {
  const os = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : 'linux'
  return `${GOOGLE_REPO_BASE}platform-tools-latest-${os}.zip`
}

/** Parse Google's SDK repository XML and find the stable platform-tools archive for an OS. */
export function parsePlatformToolsManifest(xml: string, hostOs: string): PlatformToolsRelease | null {
  const blocks = xml.match(/<remotePackage path="platform-tools">[\s\S]*?<\/remotePackage>/g) ?? []
  let best: PlatformToolsRelease | null = null
  let bestStable = false
  for (const block of blocks) {
    const stable = /<channelRef ref="channel-0"\s*\/>/.test(block)
    const major = /<major>(\d+)<\/major>/.exec(block)?.[1]
    const minor = /<minor>(\d+)<\/minor>/.exec(block)?.[1] ?? '0'
    const micro = /<micro>(\d+)<\/micro>/.exec(block)?.[1] ?? '0'
    if (!major) continue
    const archives = block.match(/<archive>[\s\S]*?<\/archive>/g) ?? []
    for (const archive of archives) {
      const os = /<host-os>([^<]+)<\/host-os>/.exec(archive)?.[1]
      if (os && os !== hostOs) continue
      const url = /<url>([^<]+)<\/url>/.exec(archive)?.[1]
      if (!url) continue
      const candidate: PlatformToolsRelease = {
        version: `${major}.${minor}.${micro}`,
        url: url.startsWith('http') ? url : GOOGLE_REPO_BASE + url,
        sha1: /<checksum type="sha1">([0-9a-f]{40})<\/checksum>/i.exec(archive)?.[1],
        size: Number(/<size>(\d+)<\/size>/.exec(archive)?.[1]) || undefined
      }
      if (!best || (stable && !bestStable)) {
        best = candidate
        bestStable = stable
      }
    }
  }
  return best
}

export interface ReleaseAsset {
  name: string
  browser_download_url: string
  size?: number
}

/** Pick the scrcpy release archive for this OS / CPU. */
export function pickScrcpyAsset(assets: ReleaseAsset[], platform: NodeJS.Platform, arch: string): ReleaseAsset | null {
  let pattern: RegExp
  if (platform === 'win32') {
    pattern = arch === 'arm64' ? /^scrcpy-winarm64-v[\d.]+\.zip$/ : arch === 'ia32' ? /^scrcpy-win32-v[\d.]+\.zip$/ : /^scrcpy-win64-v[\d.]+\.zip$/
  } else if (platform === 'darwin') {
    pattern = arch === 'arm64' ? /^scrcpy-macos-aarch64-v[\d.]+\.tar\.gz$/ : /^scrcpy-macos-x86_64-v[\d.]+\.tar\.gz$/
  } else {
    pattern = /^scrcpy-linux-x86_64-v[\d.]+\.tar\.gz$/
  }
  const exact = assets.find((a) => pattern.test(a.name))
  if (exact) return exact
  if (platform === 'win32') return assets.find((a) => /^scrcpy-win64-.*\.zip$/.test(a.name)) ?? null
  return null
}

/** Parse a `SHA256SUMS.txt` file into a name → hash map. */
export function parseSha256Sums(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim())
    if (m) out[m[2].trim()] = m[1].toLowerCase()
  }
  return out
}
