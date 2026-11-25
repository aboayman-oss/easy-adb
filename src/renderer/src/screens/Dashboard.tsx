import {
  Activity,
  BatteryCharging,
  BatteryFull,
  BatteryLow,
  BatteryMedium,
  Camera,
  Clock,
  Cpu,
  FolderOpen,
  HeartPulse,
  MonitorSmartphone,
  PackagePlus,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Thermometer,
  Unplug,
  Video,
  Wifi,
  Zap
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { BatteryInfo, DeviceDetails, StorageBreakdown } from '@shared/types'
import { Badge, Button, Card, IconButton, SectionTitle, Stat } from '../components/ui'
import { call, friendly } from '../lib/api'
import { cx, formatBytes, formatUptime } from '../lib/format'
import { deviceDisplayName, useApp, useSelectedDevice } from '../store'
import { useCapture } from './useCapture'

const HEALTH_TEXT: Record<BatteryInfo['health'], { label: string; tone: 'green' | 'amber' | 'red' | 'neutral' }> = {
  good: { label: 'Good', tone: 'green' },
  overheat: { label: 'Overheating', tone: 'red' },
  dead: { label: 'Needs replacement', tone: 'red' },
  'over-voltage': { label: 'Over-voltage', tone: 'red' },
  failure: { label: 'Fault detected', tone: 'red' },
  cold: { label: 'Too cold', tone: 'amber' },
  unknown: { label: 'Not reported', tone: 'neutral' }
}

const STATUS_TEXT: Record<BatteryInfo['status'], string> = {
  charging: 'Charging',
  discharging: 'On battery',
  'not-charging': 'Plugged in, not charging',
  full: 'Fully charged',
  unknown: '—'
}

function BatteryRing({ level, charging }: { level: number; charging: boolean }) {
  const r = 52
  const c = 2 * Math.PI * r
  const color = level <= 15 ? '#f43f5e' : level <= 35 ? '#f59e0b' : '#22c55e'
  return (
    <div className="relative size-[132px]">
      <svg viewBox="0 0 120 120" className="size-full -rotate-90">
        <circle cx="60" cy="60" r={r} fill="none" stroke="var(--surface-3)" strokeWidth="10" />
        <circle
          cx="60"
          cy="60"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - level / 100)}
          style={{ transition: 'stroke-dashoffset 0.8s ease' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className="flex items-center gap-0.5 text-[26px] font-bold text-1 tabular-nums">
          {charging && <Zap className="size-5 fill-amber-400 text-amber-400" />}
          {level}
          <span className="text-base font-semibold text-3">%</span>
        </div>
      </div>
    </div>
  )
}

const STORAGE_COLORS: { key: keyof StorageBreakdown; label: string; color: string }[] = [
  { key: 'apps', label: 'Apps', color: '#3d63fb' },
  { key: 'photos', label: 'Photos', color: '#22c55e' },
  { key: 'videos', label: 'Videos', color: '#f59e0b' },
  { key: 'audio', label: 'Audio', color: '#ec4899' },
  { key: 'downloads', label: 'Downloads', color: '#06b6d4' },
]

function StorageCard({ d }: { d: DeviceDetails }) {
  const s = d.storage
  if (!s) return null
  const used = s.usedBytes
  const pct = (used / s.totalBytes) * 100
  const raw = STORAGE_COLORS.map((c) => ({ ...c, value: s.breakdown?.[c.key] ?? 0 })).filter((x) => x.value > 0)
  const rawKnown = raw.reduce((a, b) => a + b.value, 0)
  // Android caches these category sizes, so they can briefly add up to more than the
  // space actually used. Scale them to fit; whatever's left is "System & other".
  const scale = rawKnown > used ? used / rawKnown : 1
  const segs = raw.map((x) => ({ ...x, value: x.value * scale }))
  const known = rawKnown * scale
  const rest = { key: 'rest', label: 'System & other', color: '#94a3b8', value: Math.max(0, used - known) }
  const hasBreakdown = rawKnown > 0
  return (
    <Card className="p-5">
      <SectionTitle title="Storage" subtitle={`${formatBytes(s.freeBytes)} free of ${formatBytes(s.totalBytes)}`} />
      <div className="flex h-3.5 w-full overflow-hidden rounded-full surface-3">
        {hasBreakdown ? (
          [...segs, rest].map((x) => (
            <div key={x.key} style={{ width: `${(x.value / s.totalBytes) * 100}%`, background: x.color }} title={`${x.label}: ${formatBytes(x.value)}`} />
          ))
        ) : (
          <div className={cx('h-full rounded-full', pct > 90 ? 'bg-rose-500' : 'bg-brand-600')} style={{ width: `${pct}%` }} />
        )}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 @2xl/main:grid-cols-3 @4xl/main:grid-cols-2">
        {hasBreakdown ? (
          [...segs, rest].map((x) => (
            <div key={x.key} className="flex min-w-0 items-center gap-2 text-[12.5px]">
              <span className="size-2.5 shrink-0 rounded-full" style={{ background: x.color }} />
              <span className="truncate text-2">{x.label}</span>
              <span className="ml-auto font-medium whitespace-nowrap text-1 tabular-nums">{formatBytes(x.value)}</span>
            </div>
          ))
        ) : (
          <div className="col-span-2 text-[12.5px] text-2">{formatBytes(used)} used ({pct.toFixed(0)}%)</div>
        )}
      </div>
    </Card>
  )
}

export function Dashboard() {
  const device = useSelectedDevice()
  const serial = device?.serial ?? ''
  const details = useApp((s) => s.details[serial])
  const setDetails = useApp((s) => s.setDetails)
  const setPage = useApp((s) => s.setPage)
  const toast = useApp((s) => s.toast)
  const toastError = useApp((s) => s.toastError)
  const mirroring = useApp((s) => !!s.mirroring[serial])
  const settings = useApp((s) => s.settings)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [wifiBusy, setWifiBusy] = useState(false)
  const capture = useCapture(serial)

  const load = useCallback(async () => {
    if (!serial) return
    setLoading(true)
    setError(null)
    try {
      setDetails(serial, await call('devices:details', serial))
    } catch (e) {
      setError(friendly(e).message)
    } finally {
      setLoading(false)
    }
  }, [serial, setDetails])

  useEffect(() => {
    void load()
  }, [load])

  // Refresh the battery every 30 seconds.
  useEffect(() => {
    if (!serial) return
    const t = setInterval(async () => {
      try {
        const battery = await call('devices:battery', serial)
        const cur = useApp.getState().details[serial]
        if (cur && battery) setDetails(serial, { ...cur, battery })
      } catch {
        /* ignore */
      }
    }, 30_000)
    return () => clearInterval(t)
  }, [serial, setDetails])

  if (!device) return null
  const b = details?.battery
  const health = b ? HEALTH_TEXT[b.health] : undefined
  const BatteryIcon = !b ? BatteryMedium : b.status === 'charging' ? BatteryCharging : b.level > 70 ? BatteryFull : b.level > 25 ? BatteryMedium : BatteryLow

  const startMirror = async (): Promise<void> => {
    try {
      if (mirroring) await call('mirror:stop', serial)
      else if (settings) await call('mirror:start', serial, settings.mirror, deviceDisplayName(device, details))
    } catch (e) {
      toastError(friendly(e))
    }
  }

  return (
    <div className="@container/main mx-auto max-w-6xl animate-fade-in">
      {/* Hero */}
      <Card className="relative mb-5 overflow-hidden p-6">
        <div className="pointer-events-none absolute -top-24 -right-16 size-72 rounded-full bg-gradient-to-br from-brand-500/20 to-violet-500/10 blur-3xl" />
        <div className="relative flex items-center gap-6">
          <div className="flex h-[92px] w-[54px] shrink-0 items-center justify-center rounded-[14px] border-[4px] border-slate-800 bg-gradient-to-b from-android-400 to-emerald-600 shadow-lg dark:border-slate-600">
            <Smartphone className="size-6 text-white/90" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="green" icon={<span className="size-1.5 rounded-full bg-emerald-500" />}>
                Connected
              </Badge>
              <Badge tone="neutral" icon={device.transport === 'wifi' ? <Wifi className="size-3" /> : <Unplug className="size-3" />}>
                {device.transport === 'wifi' ? 'Wi-Fi' : 'USB cable'}
              </Badge>
              {details?.securityPatch && <Badge tone="neutral" icon={<ShieldCheck className="size-3" />}>Security patch {details.securityPatch}</Badge>}
            </div>
            <h1 className="mt-2 truncate font-display text-[28px] leading-tight font-bold tracking-tight text-1">
              {details ? deviceDisplayName(device, details) : <span className="inline-block h-8 w-64 rounded-lg skeleton" />}
            </h1>
            <div className="mt-1 text-[14px] text-2">
              {details ? (
                <>
                  {details.brand} · {details.model} · Android {details.androidVersion}
                  <span className="text-3"> (API {details.sdk})</span>
                </>
              ) : (
                <span className="inline-block h-4 w-48 rounded skeleton" />
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {device.transport === 'usb' ? (
              <Button
                variant="secondary"
                size="sm"
                icon={<Wifi className="size-3.5" />}
                loading={wifiBusy}
                onClick={async () => {
                  setWifiBusy(true)
                  try {
                    await call('wireless:switchToWifi', serial)
                    toast({ kind: 'success', title: 'Wi-Fi connection ready', message: 'You can unplug the cable now.' })
                  } catch (e) {
                    toastError(friendly(e))
                  } finally {
                    setWifiBusy(false)
                  }
                }}
              >
                Go wireless
              </Button>
            ) : (
              <Button variant="secondary" size="sm" icon={<Unplug className="size-3.5" />} onClick={() => void call('wireless:disconnect', serial)}>
                Disconnect
              </Button>
            )}
            <IconButton label="Refresh" onClick={() => void load()}>
              <RefreshCw className={cx('size-4', loading && 'animate-spin')} />
            </IconButton>
          </div>
        </div>
        {error && <div className="relative mt-4 rounded-xl bg-rose-500/10 px-3 py-2 text-[13px] text-rose-700 dark:text-rose-300">{error}</div>}
      </Card>

      {/* Quick actions */}
      <div className="mb-5 grid grid-cols-3 gap-3 @3xl/main:grid-cols-6">
        {[
          { label: mirroring ? 'Stop mirroring' : 'Mirror screen', icon: MonitorSmartphone, run: startMirror, accent: true },
          { label: 'Screenshot', icon: Camera, run: () => void capture.screenshot() },
          {
            label: capture.saving ? 'Saving video…' : capture.recording ? `Stop · ${capture.elapsed}` : 'Record screen',
            icon: Video,
            run: () => void capture.toggleRecord(),
            danger: capture.recording
          },
          { label: 'Files', icon: FolderOpen, run: () => setPage('files') },
          { label: 'Install app', icon: PackagePlus, run: () => setPage('install') },
          { label: 'Clean up apps', icon: Activity, run: () => setPage('apps') }
        ].map((a) => (
          <button
            key={a.label}
            onClick={a.run}
            disabled={capture.busy && a.icon === Camera}
            className={cx(
              'group flex cursor-pointer items-center justify-center gap-2.5 rounded-2xl border px-3 py-3.5 text-[13px] font-medium whitespace-nowrap transition-all hover:-translate-y-0.5 @3xl/main:flex-col @3xl/main:gap-2 @3xl/main:p-4',
              a.accent
                ? 'border-transparent bg-gradient-to-br from-brand-600 to-violet-600 text-white shadow-lg shadow-brand-600/25'
                : a.danger
                  ? 'border-rose-400/50 bg-rose-500/10 text-rose-700 dark:text-rose-300'
                  : 'border-soft surface-1 text-1 hover:border-brand-400/60 hover:shadow-md'
            )}
          >
            <a.icon className={cx('size-5 shrink-0 @3xl/main:size-6', !a.accent && !a.danger && 'text-brand-600 dark:text-brand-300', a.danger && 'animate-pulse')} />
            {a.label}
          </button>
        ))}
      </div>

      <div className="grid gap-5 @4xl/main:grid-cols-[1.1fr_1fr]">
        {/* Battery */}
        <Card className="@container/battery p-5">
          <SectionTitle
            title="Battery & health"
            subtitle={b ? STATUS_TEXT[b.status] + (b.plugged !== 'none' ? ` · ${b.plugged.toUpperCase()} power` : '') : 'Reading…'}
            right={health && <Badge tone={health.tone} icon={<HeartPulse className="size-3" />}>{health.label}</Badge>}
          />
          {b ? (
            <div className="flex items-center gap-6">
              <BatteryRing level={b.level} charging={b.status === 'charging'} />
              <div className="grid min-w-0 flex-1 grid-cols-2 gap-2.5 @3xl/battery:grid-cols-4">
                <Stat
                  label="Temperature"
                  icon={<Thermometer className="size-3.5" />}
                  value={b.temperatureC !== undefined ? `${b.temperatureC.toFixed(1)} °C` : '—'}
                  sub={b.temperatureC === undefined ? undefined : b.temperatureC > 42 ? 'Hot — let it cool' : b.temperatureC < 5 ? 'Cold' : 'Normal'}
                />
                <Stat label="Voltage" icon={<Zap className="size-3.5" />} value={b.voltageV ? `${b.voltageV.toFixed(2)} V` : '—'} sub={b.technology} />
                <Stat
                  label="Charge cycles"
                  icon={<RefreshCw className="size-3.5" />}
                  value={b.cycleCount ?? '—'}
                  sub={b.cycleCount === undefined ? 'Not shared by this phone' : b.cycleCount > 800 ? 'Battery is aging' : 'Healthy range'}
                />
                <Stat
                  label="Capacity"
                  icon={<BatteryIcon className="size-3.5" />}
                  value={b.capacityHealthPercent ? `${b.capacityHealthPercent}%` : b.chargeCounterMah ? `${b.chargeCounterMah} mAh` : '—'}
                  sub={b.capacityHealthPercent ? 'of original capacity' : b.chargeCounterMah ? 'charge remaining' : 'Not shared by this phone'}
                />
              </div>
            </div>
          ) : (
            <div className="h-[132px] rounded-2xl skeleton" />
          )}
        </Card>

        <div className="min-w-0 space-y-5">
          {details ? <StorageCard d={details} /> : <div className="h-[150px] card skeleton" />}
          <Card className="p-5">
            <SectionTitle title="Phone at a glance" />
            <div className="grid grid-cols-3 gap-2.5">
              <Stat
                label="Memory"
                icon={<Cpu className="size-3.5" />}
                value={details?.memory ? formatBytes(details.memory.totalBytes, 0) : '—'}
                sub={details?.memory ? `${formatBytes(details.memory.availableBytes)} free` : undefined}
              />
              <Stat
                label="Screen"
                icon={<Smartphone className="size-3.5" />}
                value={details?.screen ? `${details.screen.width}×${details.screen.height}` : '—'}
                sub={details?.screen ? `${details.screen.density} dpi` : undefined}
              />
              <Stat label="Running for" icon={<Clock className="size-3.5" />} value={formatUptime(details?.uptimeSeconds)} sub="since last restart" />
            </div>
          </Card>
        </div>
      </div>
      {capture.preview && capture.lastPath && (
        <CapturePreview src={capture.preview} path={capture.lastPath} onClose={capture.clearPreview} />
      )}
    </div>
  )
}

export function CapturePreview({ src, path, onClose }: { src: string; path: string; onClose: () => void }) {
  return (
    <div className="fixed right-6 bottom-6 z-40 w-[220px] card p-2.5 animate-pop">
      <img src={src} alt="Screenshot preview" className="max-h-[300px] w-full rounded-xl object-contain surface-3" />
      <div className="mt-2 flex gap-1.5">
        <Button size="sm" className="flex-1" onClick={() => void call('shell:openPath', path)}>
          Open
        </Button>
        <Button size="sm" variant="secondary" className="flex-1" onClick={() => void call('shell:showItem', path)}>
          Folder
        </Button>
        <IconButton label="Close preview" className="size-8" onClick={onClose}>
          ×
        </IconButton>
      </div>
    </div>
  )
}
