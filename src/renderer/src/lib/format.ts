export function formatBytes(bytes: number | undefined, digits = 1): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 ? 0 : digits)} ${units[i]}`
}

export function formatSpeed(bps: number): string {
  if (!bps) return ''
  return `${formatBytes(bps)}/s`
}

export function formatEta(remainingBytes: number, bps: number): string {
  if (!bps || remainingBytes <= 0) return ''
  const s = Math.round(remainingBytes / bps)
  if (s < 60) return `${s}s left`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s left`
  return `${Math.floor(m / 60)}h ${m % 60}m left`
}

export function formatDate(unixSeconds: number): string {
  if (!unixSeconds) return '—'
  const d = new Date(unixSeconds * 1000)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return `Today, ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) {
    return `Yesterday, ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
  }
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export function formatUptime(seconds: number | undefined): string {
  if (!seconds) return '—'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  return `${m}m`
}

export function fileKind(name: string, isDir: boolean): 'folder' | 'image' | 'video' | 'audio' | 'archive' | 'apk' | 'doc' | 'pdf' | 'code' | 'file' {
  if (isDir) return 'folder'
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'dng', 'svg'].includes(ext)) return 'image'
  if (['mp4', 'mkv', 'mov', 'webm', '3gp', 'avi', 'm4v'].includes(ext)) return 'video'
  if (['mp3', 'm4a', 'aac', 'wav', 'ogg', 'opus', 'flac', 'amr'].includes(ext)) return 'audio'
  if (['zip', 'rar', '7z', 'tar', 'gz', 'xz'].includes(ext)) return 'archive'
  if (['apk', 'xapk', 'apks', 'apkm', 'obb'].includes(ext)) return 'apk'
  if (ext === 'pdf') return 'pdf'
  if (['doc', 'docx', 'txt', 'rtf', 'odt', 'xls', 'xlsx', 'csv', 'ppt', 'pptx', 'md'].includes(ext)) return 'doc'
  if (['json', 'xml', 'html', 'js', 'ts', 'log', 'ini', 'cfg'].includes(ext)) return 'code'
  return 'file'
}

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}
