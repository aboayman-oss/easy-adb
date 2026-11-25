import {
  AppWindow,
  ChevronsUpDown,
  FolderOpen,
  Home,
  MonitorSmartphone,
  Moon,
  PackagePlus,
  Plus,
  ScrollText,
  Settings,
  SlidersHorizontal,
  Smartphone,
  Sun,
  Usb,
  Wifi
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { DeviceSummary } from '@shared/types'
import { cx } from '../lib/format'
import { deviceDisplayName, useApp, useSelectedDevice, type Page } from '../store'
import { Logo } from './Illustrations'

const NAV: { page: Page; label: string; icon: ReactNode; needsDevice: boolean }[] = [
  { page: 'home', label: 'Home', icon: <Home className="size-[18px]" />, needsDevice: true },
  { page: 'files', label: 'Files', icon: <FolderOpen className="size-[18px]" />, needsDevice: true },
  { page: 'apps', label: 'Apps & Debloat', icon: <AppWindow className="size-[18px]" />, needsDevice: true },
  { page: 'install', label: 'Install Apps', icon: <PackagePlus className="size-[18px]" />, needsDevice: true },
  { page: 'mirror', label: 'Mirror & Capture', icon: <MonitorSmartphone className="size-[18px]" />, needsDevice: true },
  { page: 'tweaks', label: 'Tweaks & Power', icon: <SlidersHorizontal className="size-[18px]" />, needsDevice: true }
]

function stateLabel(d: DeviceSummary): { text: string; tone: string } {
  switch (d.state) {
    case 'device':
      return { text: d.transport === 'wifi' ? 'Ready · Wi-Fi' : 'Ready · USB', tone: 'bg-emerald-500' }
    case 'unauthorized':
      return { text: 'Waiting for “Allow”', tone: 'bg-amber-500' }
    case 'authorizing':
    case 'connecting':
      return { text: 'Connecting…', tone: 'bg-amber-500' }
    case 'offline':
      return { text: 'Offline', tone: 'bg-rose-500' }
    default:
      return { text: d.state, tone: 'bg-slate-400' }
  }
}

function DeviceSwitcher() {
  const devices = useApp((s) => s.devices)
  const selected = useApp((s) => s.selectedSerial)
  const details = useApp((s) => s.details)
  const select = useApp((s) => s.selectDevice)
  const setPage = useApp((s) => s.setPage)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const current = useSelectedDevice()
  const reconnecting = useApp((s) => !!s.reconnecting && s.reconnecting === current)

  useEffect(() => {
    const close = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [])

  if (!current) {
    return (
      <button
        onClick={() => setPage('connect')}
        className="flex w-full cursor-pointer items-center gap-3 rounded-2xl border border-dashed border-soft p-3 text-left transition hover:border-brand-400 hover:bg-brand-500/5"
      >
        <div className="flex size-10 items-center justify-center rounded-xl surface-3 text-3">
          <Smartphone className="size-5" />
        </div>
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-1">No phone connected</div>
          <div className="text-[12px] text-brand-600 dark:text-brand-300">Connect a phone →</div>
        </div>
      </button>
    )
  }
  const st = reconnecting ? { text: 'Reconnecting…', tone: 'bg-amber-500 animate-pulse' } : stateLabel(current)
  const battery = details[current.serial]?.battery?.level
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full cursor-pointer items-center gap-3 rounded-2xl border border-soft surface-2 p-3 text-left transition hover:border-brand-400/60"
      >
        <div className="relative flex size-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-android-500 to-emerald-600 text-white shadow-md shadow-emerald-600/20">
          <Smartphone className="size-5" />
          <span className="absolute -right-1 -bottom-1 flex size-4.5 items-center justify-center rounded-full border-2 border-[var(--surface-2)] surface-1 text-2">
            {current.transport === 'wifi' ? <Wifi className="size-2.5" /> : <Usb className="size-2.5" />}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-1">{deviceDisplayName(current, details[current.serial])}</div>
          <div className="flex items-center gap-1.5 text-[11.5px] text-3">
            <span className={cx('size-1.5 rounded-full', st.tone)} />
            <span className="truncate">{st.text}</span>
            {battery !== undefined && <span className="ml-auto shrink-0">{battery}%</span>}
          </div>
        </div>
        <ChevronsUpDown className="size-4 shrink-0 text-3" />
      </button>
      {open && (
        <div className="absolute top-full right-0 left-0 z-30 mt-1.5 card p-1.5 animate-pop">
          {devices.map((d) => {
            const s = stateLabel(d)
            return (
              <button
                key={d.serial}
                onClick={() => {
                  select(d.serial)
                  setOpen(false)
                  if (d.state === 'device') setPage('home')
                }}
                className={cx(
                  'flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-2 text-left hover:surface-3',
                  d.serial === selected && 'surface-3'
                )}
              >
                {d.transport === 'wifi' ? <Wifi className="size-4 text-3" /> : <Usb className="size-4 text-3" />}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-1">{deviceDisplayName(d, details[d.serial])}</div>
                  <div className="truncate text-[11px] text-3">{s.text}</div>
                </div>
                <span className={cx('size-2 rounded-full', s.tone)} />
              </button>
            )
          })}
          <button
            onClick={() => {
              setPage('connect')
              setOpen(false)
            }}
            className="mt-1 flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-2 text-[13px] font-medium text-brand-600 hover:surface-3 dark:text-brand-300"
          >
            <Plus className="size-4" /> Connect another phone
          </button>
        </div>
      )}
    </div>
  )
}

export function Sidebar() {
  const rawPage = useApp((s) => s.page)
  const setPage = useApp((s) => s.setPage)
  const device = useSelectedDevice()
  const online = device?.state === 'device'
  // Device pages fall back to the Connect screen when no phone is ready — highlight that.
  const page: Page = !online && rawPage !== 'settings' ? 'connect' : rawPage
  const logOpen = useApp((s) => s.logOpen)
  const toggleLog = useApp((s) => s.toggleLog)
  const errors = useApp((s) => s.log.filter((l) => l.level === 'error').length)
  const theme = useApp((s) => s.resolvedTheme)
  const patchSettings = useApp((s) => s.patchSettings)
  const activeTransfers = useApp((s) => Object.values(s.transfers).filter((t) => t.status === 'running' || t.status === 'queued').length)

  const item = (p: Page, label: string, icon: ReactNode, disabled = false, badge?: ReactNode) => (
    <button
      key={p}
      onClick={() => setPage(p)}
      className={cx(
        'group flex w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-[13.5px] font-medium transition-colors',
        page === p
          ? 'bg-brand-600/10 text-brand-700 dark:bg-brand-500/15 dark:text-brand-200'
          : 'text-2 hover:surface-3 hover:text-1',
        disabled && 'opacity-45'
      )}
    >
      <span className={cx(page === p ? 'text-brand-600 dark:text-brand-300' : 'text-3 group-hover:text-2')}>{icon}</span>
      <span className="flex-1 text-left">{label}</span>
      {badge}
    </button>
  )

  return (
    <aside className="flex w-[248px] shrink-0 flex-col border-r border-soft surface-1">
      <div className="flex items-center gap-2.5 px-5 pt-5 pb-4">
        <Logo className="size-8" />
        <div>
          <div className="font-display text-[16px] leading-none font-bold tracking-tight text-1">Easy ADB</div>
          <div className="mt-1 text-[11px] text-3">Android tools, made simple</div>
        </div>
      </div>
      <div className="px-3 pb-3">
        <DeviceSwitcher />
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-3">
        {NAV.map((n) =>
          item(
            n.page,
            n.label,
            n.icon,
            n.needsDevice && !online,
            n.page === 'files' && activeTransfers > 0 ? (
              <span className="rounded-full bg-brand-600 px-1.5 text-[11px] leading-5 text-white">{activeTransfers}</span>
            ) : undefined
          )
        )}
        <div className="my-3 border-t border-soft" />
        {item('connect', 'Connect a Phone', <Plus className="size-[18px]" />)}
        {item('settings', 'Settings', <Settings className="size-[18px]" />)}
      </nav>
      <div className="flex items-center gap-1 border-t border-soft p-3">
        <button
          onClick={() => toggleLog()}
          className={cx(
            'flex flex-1 cursor-pointer items-center gap-2 rounded-xl px-3 py-2 text-[13px] font-medium transition-colors',
            logOpen ? 'surface-3 text-1' : 'text-2 hover:surface-3 hover:text-1'
          )}
        >
          <ScrollText className="size-4" />
          Activity Log
          {errors > 0 && <span className="ml-auto size-2 rounded-full bg-rose-500" />}
        </button>
        <button
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          onClick={() => void patchSettings({ theme: theme === 'dark' ? 'light' : 'dark' })}
          className="flex size-9 cursor-pointer items-center justify-center rounded-xl text-2 hover:surface-3 hover:text-1"
        >
          {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </button>
      </div>
    </aside>
  )
}
