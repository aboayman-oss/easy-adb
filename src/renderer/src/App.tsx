import { useEffect, useRef } from 'react'
import type { DeviceSummary } from '@shared/types'
import { ActivityLog } from './components/ActivityLog'
import { Sidebar } from './components/Sidebar'
import { Toasts } from './components/Toasts'
import { Spinner } from './components/ui'
import { call, on } from './lib/api'
import { AppsScreen } from './screens/AppsScreen'
import { ConnectScreen } from './screens/ConnectScreen'
import { Dashboard } from './screens/Dashboard'
import { FilesScreen } from './screens/FilesScreen'
import { InstallScreen } from './screens/InstallScreen'
import { MirrorScreen } from './screens/MirrorScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { SetupScreen } from './screens/SetupScreen'
import { TweaksScreen } from './screens/TweaksScreen'
import { deviceDisplayName, useApp, useSelectedDevice } from './store'

function useTheme(): void {
  const theme = useApp((s) => s.settings?.theme ?? 'system')
  const setResolved = useApp((s) => s.setResolvedTheme)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      const dark = theme === 'dark' || (theme === 'system' && mq.matches)
      document.documentElement.classList.toggle('dark', dark)
      setResolved(dark ? 'dark' : 'light')
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme, setResolved])
}

function useBootstrap(): void {
  const s = useApp.getState
  const prevDevices = useRef<DeviceSummary[]>([])

  useEffect(() => {
    const st = s()
    void call('settings:get').then(st.setSettings)
    void call('engine:status').then(st.setEngine)
    void call('log:history').then(st.setLog)
    void call('files:transfers').then((list) => list.forEach(st.upsertTransfer))
    void call('mirror:running').then((list) => list.forEach((serial) => st.setMirroring(serial, true)))
    void call('capture:recording').then((list) => list.forEach((r) => st.setRecording(r.serial, r.startedAt)))

    // A phone can switch from one Wi-Fi link to another (e.g. after the engine restarts).
    // Treat a disconnect followed quickly by the same model reconnecting as one hand-over.
    const handoverKey = (d: DeviceSummary): string => `${d.transport}|${d.model ?? ''}`
    const pendingDisconnects = new Map<string, ReturnType<typeof setTimeout>>()

    const handleDevices = (devices: DeviceSummary[]): void => {
      const state = s()
      const before = prevDevices.current
      prevDevices.current = devices
      state.setDevices(devices)
      for (const d of devices) {
        const old = before.find((b) => b.serial === d.serial)
        if (d.state === 'device' && old?.state !== 'device') {
          const key = handoverKey(d)
          const handover = pendingDisconnects.has(key) || before.some((b) => b.serial !== d.serial && b.state === 'device' && handoverKey(b) === key)
          if (pendingDisconnects.has(key)) {
            clearTimeout(pendingDisconnects.get(key))
            pendingDisconnects.delete(key)
          }
          // Fetch details for the sidebar and greet the user.
          void call('devices:details', d.serial)
            .then((details) => {
              s().setDetails(d.serial, details)
              if (!handover) {
                s().toast({ kind: 'success', title: `${deviceDisplayName(d, details)} connected`, message: d.transport === 'wifi' ? 'Over Wi-Fi' : 'Over USB' })
              }
            })
            .catch(() => undefined)
          if (s().page === 'connect' && s().selectedSerial === d.serial) s().setPage('home')
        }
      }
      for (const b of before) {
        if (b.state === 'device' && !devices.find((d) => d.serial === b.serial && d.state === 'device')) {
          s().setMirroring(b.serial, false)
          s().setRecording(b.serial, undefined)
          const key = handoverKey(b)
          if (devices.some((d) => d.state === 'device' && handoverKey(d) === key)) continue // replaced already
          const name = deviceDisplayName(b, s().details[b.serial])
          pendingDisconnects.set(
            key,
            setTimeout(() => {
              pendingDisconnects.delete(key)
              s().toast({ kind: 'info', title: `${name} disconnected` })
            }, 4500) // a little longer than the store's reconnect grace period
          )
        }
      }
    }
    void call('devices:list').then(handleDevices)

    const offs = [
      on('engine:progress', (p) => s().setEngineProgress(p)),
      on('devices:changed', handleDevices),
      on('log:entry', (e) => s().addLog(e)),
      on('transfer:update', (t) => {
        s().upsertTransfer(t)
        if (t.status === 'error') s().toast({ kind: 'error', title: `Couldn’t transfer ${t.label}`, message: t.error })
      }),
      on('mirror:state', (m) => {
        s().setMirroring(m.serial, m.running)
        if (m.error) s().toastError(m.error)
      }),
      on('record:state', (r) => {
        s().setRecording(r.serial, r.recording ? r.startedAt : undefined)
        s().setSavingRecording(r.serial, !!r.saving)
        // A manual Stop reports its own result; the 3-minute limit can hit on any page, so announce it here.
        if (!r.auto) return
        if (r.saving) s().toast({ kind: 'info', title: 'Recording reached 3 minutes', message: 'Saving the video to your PC…' })
        else if (r.savedPath) {
          const path = r.savedPath
          s().toast({ kind: 'success', title: 'Recording saved', message: path, action: { label: 'Show in folder', run: () => void call('shell:showItem', path) } })
        } else if (r.error) s().toastError(r.error)
      })
    ]
    return () => offs.forEach((off) => off())
  }, [s])
}

/** Shown while the phone in use briefly drops and the app waits for it to come back. */
function ReconnectingNotice() {
  const reconnecting = useApp((s) => !!s.reconnecting && s.reconnecting.serial === s.selectedSerial)
  if (!reconnecting) return null
  return (
    <div className="pointer-events-none sticky top-0 z-30 -mt-2 mb-2 flex h-0 justify-center">
      <div className="flex h-8 items-center gap-2 rounded-full border border-soft surface-1 px-3.5 text-[12.5px] font-medium text-2 shadow-lg animate-fade-in">
        <Spinner className="size-3.5 text-brand-600" />
        Reconnecting to your phone…
      </div>
    </div>
  )
}

function Content() {
  const page = useApp((s) => s.page)
  const device = useSelectedDevice()
  const online = device?.state === 'device'

  if (page === 'settings') return <SettingsScreen />
  if (page === 'connect' || !online) return <ConnectScreen key={device?.serial ?? 'none'} />
  switch (page) {
    case 'files':
      return <FilesScreen key={device.serial} />
    case 'apps':
      return <AppsScreen key={device.serial} />
    case 'install':
      return <InstallScreen key={device.serial} />
    case 'mirror':
      return <MirrorScreen key={device.serial} />
    case 'tweaks':
      return <TweaksScreen key={device.serial} />
    default:
      return <Dashboard key={device.serial} />
  }
}

export function App() {
  useTheme()
  useBootstrap()
  const engine = useApp((s) => s.engine)
  const settings = useApp((s) => s.settings)
  const page = useApp((s) => s.page)

  if (!engine || !settings) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-8 text-brand-600" />
      </div>
    )
  }

  if (!engine.ready) {
    return (
      <>
        <SetupScreen />
        <Toasts />
      </>
    )
  }

  return (
    <div className="flex h-full">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <main
          className={page === 'files' || page === 'apps' ? 'relative min-h-0 flex-1 overflow-hidden p-7' : 'relative min-h-0 flex-1 overflow-y-auto p-7'}
        >
          <ReconnectingNotice />
          <Content />
        </main>
        <ActivityLog />
      </div>
      <Toasts />
    </div>
  )
}
