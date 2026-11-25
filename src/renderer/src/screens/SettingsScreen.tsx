import type { IpcReturn } from '@shared/ipc'
import { CheckCircle2, Cpu, Download, FolderOpen, HardDriveDownload, Info, Monitor, Moon, Palette, RefreshCw, Sun, Trash2, Wifi, Wrench } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { DriverCheckResult, EngineUpdateInfo, RememberedDevice } from '@shared/types'
import { Badge, Button, Card, IconButton, PageHeader, SectionTitle, Segmented } from '../components/ui'
import { call, friendly } from '../lib/api'
import { useApp } from '../store'

const REPO_URL = 'https://github.com/aboayman-oss/easy-adb'

export function SettingsScreen() {
  const settings = useApp((s) => s.settings)
  const patch = useApp((s) => s.patchSettings)
  const engine = useApp((s) => s.engine)
  const setEngine = useApp((s) => s.setEngine)
  const progress = useApp((s) => s.engineProgress)
  const toast = useApp((s) => s.toast)
  const toastError = useApp((s) => s.toastError)
  const [updates, setUpdates] = useState<EngineUpdateInfo | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [remembered, setRemembered] = useState<RememberedDevice[]>([])
  const [drivers, setDrivers] = useState<DriverCheckResult | null>(null)
  const [info, setInfo] = useState<IpcReturn<'app:info'> | null>(null)

  const loadRemembered = useCallback(() => void call('wireless:remembered').then(setRemembered).catch(() => undefined), [])
  useEffect(() => {
    loadRemembered()
    void call('app:info').then(setInfo)
  }, [loadRemembered])

  if (!settings) return null

  const pick = async (key: 'downloadDir' | 'captureDir'): Promise<void> => {
    const dir = await call('files:pickFolder')
    if (dir) await patch({ [key]: dir })
  }

  const reinstall = async (force: boolean): Promise<void> => {
    setBusy(force ? 'repair' : 'update')
    try {
      setEngine(await call('engine:install', { force: true }))
      toast({ kind: 'success', title: 'Engine updated', message: 'You’re running the latest tools.' })
      setUpdates(null)
    } catch (e) {
      toastError(friendly(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mx-auto max-w-3xl animate-fade-in">
      <PageHeader title="Settings" icon={<Wrench className="size-5" />} />

      <Card className="mb-5 p-5">
        <SectionTitle title="Appearance" />
        <div className="flex items-center gap-3">
          <Palette className="size-4 text-3" />
          <span className="flex-1 text-[13.5px] text-1">Theme</span>
          <Segmented
            value={settings.theme}
            onChange={(theme) => void patch({ theme })}
            options={[
              { value: 'system', label: 'System', icon: <Monitor className="size-3.5" /> },
              { value: 'light', label: 'Light', icon: <Sun className="size-3.5" /> },
              { value: 'dark', label: 'Dark', icon: <Moon className="size-3.5" /> }
            ]}
          />
        </div>
      </Card>

      <Card className="mb-5 p-5">
        <SectionTitle title="Where files are saved" />
        {[
          { key: 'downloadDir' as const, label: 'Files copied from your phone', value: settings.downloadDir },
          { key: 'captureDir' as const, label: 'Screenshots & recordings', value: settings.captureDir }
        ].map((r) => (
          <div key={r.key} className="flex items-center gap-3 py-2">
            <FolderOpen className="size-4 shrink-0 text-3" />
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] text-1">{r.label}</div>
              <div className="selectable truncate text-[12px] text-3">{r.value}</div>
            </div>
            <Button size="sm" variant="ghost" onClick={() => void call('shell:openPath', r.value).catch(() => toast({ kind: 'info', title: 'Folder will be created on first use' }))}>
              Open
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void pick(r.key)}>
              Change
            </Button>
          </div>
        ))}
      </Card>

      <Card className="mb-5 p-5">
        <SectionTitle
          title="Engine"
          subtitle="The official Android tools that power Easy ADB. Kept inside the app — nothing is added to your system."
          right={engine?.ready && <Badge tone="green" icon={<CheckCircle2 className="size-3" />}>Ready</Badge>}
        />
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-2xl surface-2 p-3.5">
            <div className="flex items-center gap-1.5 text-[12px] text-3">
              <Cpu className="size-3.5" /> Android platform-tools (adb)
            </div>
            <div className="mt-1 font-semibold text-1">{engine?.adb.version ?? '—'}</div>
            {updates?.adb.updateAvailable && <Badge tone="blue" className="mt-1">Update: {updates.adb.latest}</Badge>}
          </div>
          <div className="rounded-2xl surface-2 p-3.5">
            <div className="flex items-center gap-1.5 text-[12px] text-3">
              <Monitor className="size-3.5" /> Screen mirroring (scrcpy)
            </div>
            <div className="mt-1 font-semibold text-1">{engine?.scrcpy.version ?? '—'}</div>
            {updates?.scrcpy.updateAvailable && <Badge tone="blue" className="mt-1">Update: {updates.scrcpy.latest}</Badge>}
          </div>
        </div>
        {busy && progress && progress.phase !== 'done' && <div className="mt-3 text-[12.5px] text-2">{progress.message} ({progress.percent}%)</div>}
        {updates && !updates.adb.updateAvailable && !updates.scrcpy.updateAvailable && (
          <div className="mt-3 flex items-center gap-1.5 text-[13px] text-emerald-600">
            <CheckCircle2 className="size-4" /> Everything is up to date.
          </div>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            icon={<RefreshCw className="size-3.5" />}
            loading={busy === 'check'}
            onClick={async () => {
              setBusy('check')
              try {
                setUpdates(await call('engine:checkUpdates'))
                setEngine(await call('engine:status'))
              } catch (e) {
                toastError(friendly(e))
              } finally {
                setBusy(null)
              }
            }}
          >
            Check for engine updates
          </Button>
          {(updates?.adb.updateAvailable || updates?.scrcpy.updateAvailable) && (
            <Button size="sm" icon={<Download className="size-3.5" />} loading={busy === 'update'} onClick={() => void reinstall(false)}>
              Update now
            </Button>
          )}
          <Button size="sm" variant="ghost" loading={busy === 'repair'} onClick={() => void reinstall(true)}>
            Repair engine
          </Button>
          <Button
            size="sm"
            variant="ghost"
            loading={busy === 'restart'}
            onClick={async () => {
              setBusy('restart')
              try {
                await call('devices:restartServer')
                toast({ kind: 'success', title: 'Connection engine restarted' })
              } catch (e) {
                toastError(friendly(e))
              } finally {
                setBusy(null)
              }
            }}
          >
            Restart connection engine
          </Button>
        </div>
      </Card>

      {info?.platform === 'win32' && (
        <Card className="mb-5 p-5">
          <SectionTitle title="USB drivers (Windows)" subtitle="Only needed if Windows doesn’t recognise your phone over USB." />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              icon={<HardDriveDownload className="size-3.5" />}
              loading={busy === 'drivers'}
              onClick={async () => {
                setBusy('drivers')
                try {
                  setDrivers(await call('drivers:check'))
                } catch (e) {
                  toastError(friendly(e))
                } finally {
                  setBusy(null)
                }
              }}
            >
              Check USB drivers
            </Button>
            <Button
              size="sm"
              variant="ghost"
              loading={busy === 'gdriver'}
              onClick={async () => {
                setBusy('gdriver')
                try {
                  const message = await call('drivers:installGoogle')
                  toast({ kind: 'success', title: 'USB driver ready', message })
                } catch (e) {
                  toastError(friendly(e))
                } finally {
                  setBusy(null)
                }
              }}
            >
              Install Google USB driver
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void call('shell:openExternal', 'https://developer.samsung.com/android-usb-driver')}>
              Samsung driver
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void call('shell:openExternal', 'https://developer.android.com/studio/run/oem-usb')}>
              Other brands
            </Button>
          </div>
          {drivers && (
            <div className="mt-3 rounded-xl surface-2 p-3 text-[13px] text-2">
              {drivers.problemDevices.length
                ? drivers.problemDevices.map((d) => (
                    <div key={d.instanceId}>
                      ⚠️ <b className="text-1">{d.name}</b>
                      {d.vendor ? ` (${d.vendor})` : ''} — driver problem ({d.status})
                    </div>
                  ))
                : drivers.androidUsbDevices
                  ? '✅ Your Android device has a working driver.'
                  : 'No Android device is plugged in right now.'}
            </div>
          )}
        </Card>
      )}

      <Card className="mb-5 p-5">
        <SectionTitle title="Remembered Wi-Fi phones" />
        {remembered.length === 0 ? (
          <div className="text-[13px] text-3">None yet. Phones you connect over Wi-Fi appear here for one-click reconnection.</div>
        ) : (
          remembered.map((d) => (
            <div key={d.id} className="flex items-center gap-3 py-2">
              <Wifi className="size-4 text-3" />
              <div className="flex-1">
                <div className="text-[13.5px] text-1">{d.name}</div>
                <div className="text-[12px] text-3">
                  {d.host}:{d.port}
                </div>
              </div>
              <IconButton
                label="Forget"
                onClick={async () => {
                  await call('wireless:forget', d.id)
                  loadRemembered()
                }}
              >
                <Trash2 className="size-4" />
              </IconButton>
            </div>
          ))
        )}
      </Card>

      <Card className="p-5">
        <SectionTitle title="About" />
        <div className="flex items-start gap-3 text-[13px] text-2">
          <Info className="mt-0.5 size-4 shrink-0 text-3" />
          <div>
            Easy ADB {info?.version} · {info?.platform} {info?.arch}
            {info?.portable && ' · portable'}
            {info?.portable && <div className="mt-1 text-3">Settings and the engine are kept in “{info.dataDir}”.</div>}
            <div className="mt-1 text-3">
              Uses Android SDK Platform-Tools by Google and scrcpy by Genymobile. Dangerous developer features (flashing, bootloader unlocking, raw shell
              access) are intentionally left out so your phone stays safe.
            </div>
            <div className="mt-2 flex gap-3">
              <button className="cursor-pointer font-medium text-brand-600 hover:underline dark:text-brand-300" onClick={() => void call('shell:openExternal', `${REPO_URL}`)}>
                Source code on GitHub
              </button>
              <button className="cursor-pointer font-medium text-brand-600 hover:underline dark:text-brand-300" onClick={() => void call('shell:openExternal', `${REPO_URL}/issues/new/choose`)}>
                Report a problem
              </button>
              <button className="cursor-pointer font-medium text-brand-600 hover:underline dark:text-brand-300" onClick={() => void call('shell:openExternal', `${REPO_URL}/releases/latest`)}>
                Latest version
              </button>
            </div>
          </div>
        </div>
      </Card>
    </div>
  )
}
