import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  Cable,
  HardDriveDownload,
  KeyRound,
  Loader2,
  QrCode,
  RefreshCw,
  Smartphone,
  Trash2,
  Usb,
  Wifi
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { DriverCheckResult, PairingStatus, QrPairingSession, RememberedDevice, UsbPhone } from '@shared/types'
import { AllowDebuggingIllustration, UsbIllustration, WifiIllustration } from '../components/Illustrations'
import { Badge, Button, Card, IconButton, PageHeader, Segmented, Spinner, TextInput } from '../components/ui'
import { BRANDS } from '../data/brands'
import { call, friendly, on } from '../lib/api'
import { cx } from '../lib/format'
import { deviceDisplayName, useApp } from '../store'

type Mode = 'hub' | 'usb' | 'wifi'

/** Android phones Windows sees on USB, including ones with USB debugging still off. */
function useUsbPhones(): UsbPhone[] {
  const [phones, setPhones] = useState<UsbPhone[]>([])
  useEffect(() => {
    let alive = true
    void call('usb:watch', true)
      .then((p) => alive && setPhones(p))
      .catch(() => undefined)
    const off = on('usb:phones', setPhones)
    return () => {
      alive = false
      off()
      void call('usb:watch', false).catch(() => undefined)
    }
  }, [])
  return phones
}

export function ConnectScreen() {
  const [mode, setMode] = useState<Mode>('hub')
  const device = useApp((s) => s.devices.find((d) => d.serial === s.selectedSerial))
  const adbUsbCount = useApp((s) => s.devices.filter((d) => d.transport === 'usb').length)
  const usbPhones = useUsbPhones()
  // Phones plugged in that adb can't see yet (USB debugging off or a driver problem).
  const detected = adbUsbCount === 0 ? usbPhones[0] : undefined

  if (mode === 'usb') return <UsbWizard onBack={() => setMode('hub')} detected={detected} />
  if (mode === 'wifi') return <WirelessPanel onBack={() => setMode('hub')} />

  if (device?.state === 'unauthorized') return <UnauthorizedView />
  if (device && ['offline', 'authorizing', 'connecting'].includes(device.state)) return <ConnectingView state={device.state} />

  return <Hub onUsb={() => setMode('usb')} onWifi={() => setMode('wifi')} detected={detected} />
}

/** "Your phone is plugged in, but..." guides a first-time user from the exact state their phone is in. */
function PluggedInCard({ phone, onAllGuides }: { phone: UsbPhone; onAllGuides: () => void }) {
  const brand = BRANDS.find((b) => b.id === phone.brandId) ?? BRANDS[BRANDS.length - 1]
  const toast = useApp((s) => s.toast)
  const toastError = useApp((s) => s.toastError)
  const [installing, setInstalling] = useState(false)

  if (phone.driverProblem) {
    const samsung = phone.vendor === 'Samsung'
    return (
      <Card className="mb-6 border-amber-400/50 p-5 animate-slide-up">
        <div className="flex items-start gap-4">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-amber-500/12 text-amber-500">
            <AlertTriangle className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[16px] font-semibold text-1">Windows needs a driver for {phone.name}</div>
            <p className="mt-1 text-[13.5px] text-2">
              Your {phone.vendor ?? 'Android'} phone is plugged in, but Windows couldn’t set up “{phone.driverProblem}”. Install the driver, then unplug
              and reconnect the phone.
            </p>
            <div className="mt-3 flex gap-2">
              {samsung ? (
                <Button size="sm" onClick={() => void call('shell:openExternal', 'https://developer.samsung.com/android-usb-driver')}>
                  Get the Samsung USB driver
                </Button>
              ) : (
                <Button
                  size="sm"
                  loading={installing}
                  onClick={async () => {
                    setInstalling(true)
                    try {
                      toast({ kind: 'success', title: 'USB driver ready', message: await call('drivers:installGoogle') })
                    } catch (e) {
                      toastError(friendly(e))
                    } finally {
                      setInstalling(false)
                    }
                  }}
                >
                  Install USB driver
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => void call('shell:openExternal', 'https://developer.android.com/studio/run/oem-usb')}>
                Other brands
              </Button>
            </div>
          </div>
        </div>
      </Card>
    )
  }

  if (phone.adbInterface) {
    return (
      <Card className="mb-6 flex items-center gap-4 p-5 animate-slide-up">
        <Spinner className="size-6 text-brand-600" />
        <div>
          <div className="font-semibold text-1">{phone.name} is almost ready…</div>
          <div className="text-[13px] text-2">Unlock your phone and watch for the “Allow USB debugging?” popup.</div>
        </div>
      </Card>
    )
  }

  return (
    <Card className="mb-6 overflow-hidden border-brand-400/40 animate-slide-up">
      <div className="flex items-center gap-4 border-b border-soft bg-brand-500/6 px-5 py-4">
        <div className="relative flex size-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-android-500 to-emerald-600 text-white">
          <Smartphone className="size-5" />
          <span className="absolute -top-1 -right-1 flex size-3">
            <span className="absolute inline-flex h-full w-full rounded-full bg-amber-400 animate-pulse-ring" />
            <span className="relative inline-flex size-3 rounded-full bg-amber-400" />
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[16px] font-semibold text-1">{phone.name} is plugged in — now turn on USB debugging</div>
          <div className="text-[13px] text-2">
            {phone.vendor ? `${phone.vendor} · ` : ''}Easy ADB continues by itself as soon as it’s on. Steps for {brand.name} ({brand.skin}):
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-5 p-5">
        {[
          { title: 'Turn on Developer options', items: brand.devOptions },
          { title: 'Turn on USB debugging', items: brand.usbDebugging }
        ].map((step, i) => (
          <div key={step.title}>
            <div className="flex items-center gap-2 font-semibold text-1">
              <span className="flex size-6 items-center justify-center rounded-full bg-brand-600 text-[12px] font-bold text-white">{i + 1}</span>
              {step.title}
            </div>
            <ol className="mt-2 space-y-1.5 text-[13px] text-2">
              {step.items.map((it) => (
                <li key={it} className="flex gap-1.5">
                  <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-brand-500" />
                  <span>{it}</span>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between border-t border-soft px-5 py-3 text-[12.5px] text-3">
        <span className="flex items-center gap-2">
          <span className="size-2 animate-pulse rounded-full bg-brand-500" /> Watching for the change…
        </span>
        <button className="cursor-pointer font-medium text-brand-600 hover:underline dark:text-brand-300" onClick={onAllGuides}>
          Not a {brand.name}? See all guides
        </button>
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------

function Hub({ onUsb, onWifi, detected }: { onUsb: () => void; onWifi: () => void; detected?: UsbPhone }) {
  const devices = useApp((s) => s.devices)
  const details = useApp((s) => s.details)
  const select = useApp((s) => s.selectDevice)
  const setPage = useApp((s) => s.setPage)
  const online = devices.filter((d) => d.state === 'device')

  return (
    <div className="mx-auto max-w-4xl animate-fade-in">
      <div className="mb-8 text-center">
        <h1 className="font-display text-[30px] font-bold tracking-tight text-1">{detected ? 'Almost there!' : 'Let’s connect your phone'}</h1>
        <p className="mt-2 text-[15px] text-2">
          {detected ? 'We found your phone. One quick setting and you’re connected.' : 'Choose how you’d like to connect. You only need to set this up once.'}
        </p>
      </div>

      {detected && <PluggedInCard phone={detected} onAllGuides={onUsb} />}

      <div className="grid grid-cols-2 gap-5">
        <OptionCard
          onClick={onUsb}
          art={<UsbIllustration />}
          icon={<Usb className="size-5" />}
          title="With a USB cable"
          text="Fastest and most reliable. Works with every Android phone."
          badge={<Badge tone="green">Recommended</Badge>}
        />
        <OptionCard
          onClick={onWifi}
          art={<WifiIllustration />}
          icon={<Wifi className="size-5" />}
          title="Over Wi-Fi"
          text="No cable needed. Scan a QR code from your phone (Android 11 or newer)."
        />
      </div>

      {online.length > 0 && (
        <div className="mt-8">
          <h3 className="mb-3 text-sm font-semibold text-1">Connected phones</h3>
          <div className="grid grid-cols-2 gap-3">
            {online.map((d) => (
              <button
                key={d.serial}
                onClick={() => {
                  select(d.serial)
                  setPage('home')
                }}
                className="flex cursor-pointer items-center gap-3 card p-4 text-left transition hover:border-brand-400"
              >
                <div className="flex size-10 items-center justify-center rounded-xl bg-emerald-500/12 text-emerald-600">
                  <Smartphone className="size-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-1">{deviceDisplayName(d, details[d.serial])}</div>
                  <div className="text-[12px] text-3">{d.transport === 'wifi' ? 'Wi-Fi' : 'USB'} · ready</div>
                </div>
                <ChevronRight className="size-4 text-3" />
              </button>
            ))}
          </div>
        </div>
      )}

      <RememberedDevices />
    </div>
  )
}

function OptionCard({
  onClick,
  art,
  icon,
  title,
  text,
  badge
}: {
  onClick: () => void
  art: React.ReactNode
  icon: React.ReactNode
  title: string
  text: string
  badge?: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className="group cursor-pointer overflow-hidden card text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-brand-400 hover:shadow-xl hover:shadow-brand-600/10"
    >
      <div className="flex h-44 items-center justify-center bg-gradient-to-br from-brand-50 to-violet-50 p-6 dark:from-brand-500/10 dark:to-violet-500/10">
        <div className="h-full w-full max-w-[240px]">{art}</div>
      </div>
      <div className="p-5">
        <div className="flex items-center gap-2">
          <span className="text-brand-600 dark:text-brand-300">{icon}</span>
          <span className="text-[16px] font-semibold whitespace-nowrap text-1">{title}</span>
          <span className="hidden min-[1100px]:inline-flex">{badge}</span>
          <ChevronRight className="ml-auto size-5 text-3 transition-transform group-hover:translate-x-1" />
        </div>
        <p className="mt-1.5 text-[13.5px] text-2">{text}</p>
      </div>
    </button>
  )
}

function RememberedDevices() {
  const [list, setList] = useState<RememberedDevice[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const toast = useApp((s) => s.toast)
  const toastError = useApp((s) => s.toastError)

  const load = useCallback(() => {
    void call('wireless:remembered').then(setList).catch(() => undefined)
  }, [])
  useEffect(load, [load])

  if (!list.length) return null
  return (
    <div className="mt-8">
      <h3 className="mb-3 text-sm font-semibold text-1">Remembered Wi-Fi phones</h3>
      <Card className="divide-y divide-[var(--border)]">
        {list.map((d) => (
          <div key={d.id} className="flex items-center gap-3 px-4 py-3">
            <Wifi className="size-4 text-3" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-1">{d.name}</div>
              <div className="text-[12px] text-3">
                {d.host}:{d.port} · last used {new Date(d.lastConnected).toLocaleDateString()}
              </div>
            </div>
            <Button
              size="sm"
              variant="secondary"
              loading={busy === d.id}
              onClick={async () => {
                setBusy(d.id)
                try {
                  await call('wireless:reconnect', d.id)
                  toast({ kind: 'success', title: `Connected to ${d.name}` })
                } catch (e) {
                  toastError(friendly(e))
                } finally {
                  setBusy(null)
                  load()
                }
              }}
            >
              Connect
            </Button>
            <IconButton
              label="Forget"
              onClick={async () => {
                await call('wireless:forget', d.id)
                load()
              }}
            >
              <Trash2 className="size-4" />
            </IconButton>
          </div>
        ))}
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------

function UnauthorizedView() {
  return (
    <div className="mx-auto flex max-w-3xl items-center gap-12 py-6 animate-fade-in">
      <div className="shrink-0">
        <AllowDebuggingIllustration />
      </div>
      <div>
        <Badge tone="amber" icon={<Loader2 className="size-3 animate-spin" />}>
          Waiting for your permission
        </Badge>
        <h1 className="mt-3 font-display text-[28px] leading-tight font-bold tracking-tight text-1">Look at your phone screen</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-2">
          Tap <b className="text-1">“Allow”</b> on the <b className="text-1">“Allow USB debugging?”</b> popup.
        </p>
        <p className="mt-2 text-[15px] leading-relaxed text-2">
          Tick <b className="text-1">“Always allow from this computer”</b> so you won’t be asked again.
        </p>
        <div className="mt-6 rounded-2xl surface-2 p-4 text-[13px] text-2">
          <div className="mb-1.5 font-semibold text-1">Don’t see the popup?</div>
          <ul className="list-disc space-y-1 pl-5">
            <li>Unlock your phone — the popup only appears on an unlocked screen.</li>
            <li>Unplug the cable and plug it back in.</li>
            <li>In Developer options, tap “Revoke USB debugging authorizations”, then reconnect.</li>
          </ul>
        </div>
      </div>
    </div>
  )
}

function ConnectingView({ state }: { state: string }) {
  // Phones normally pass through "offline" for a moment while connecting; only call it a
  // problem when it stays that way.
  const [patient, setPatient] = useState(true)
  useEffect(() => {
    const t = setTimeout(() => setPatient(false), 3000)
    return () => clearTimeout(t)
  }, [])
  const stuck = state === 'offline' && !patient
  return (
    <div className="mx-auto max-w-xl py-16 text-center animate-fade-in">
      <Spinner className="mx-auto size-10 text-brand-600" />
      <h1 className="mt-5 font-display text-2xl font-bold text-1">{stuck ? 'Your phone isn’t responding' : 'Connecting to your phone…'}</h1>
      <p className="mt-2 text-[15px] text-2">
        {stuck ? 'Try unplugging and reconnecting the cable, or turn Wireless debugging off and on again.' : 'This usually takes just a few seconds.'}
      </p>
      {stuck && (
        <Button
          className="mt-6"
          variant="secondary"
          icon={<RefreshCw className="size-4" />}
          onClick={() => void call('devices:restartServer').catch(() => undefined)}
        >
          Restart connection engine
        </Button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

function UsbWizard({ onBack, detected }: { onBack: () => void; detected?: UsbPhone }) {
  const [brandId, setBrandId] = useState(detected?.brandId ?? 'samsung')
  const brand = BRANDS.find((b) => b.id === brandId) ?? BRANDS[0]
  const devices = useApp((s) => s.devices)
  const usbDevice = devices.find((d) => d.transport === 'usb')
  const [drivers, setDrivers] = useState<DriverCheckResult | null>(null)
  const [checking, setChecking] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [platform, setPlatform] = useState<string>('')
  const toast = useApp((s) => s.toast)
  const toastError = useApp((s) => s.toastError)

  useEffect(() => {
    void call('app:info').then((i) => setPlatform(i.platform))
  }, [])

  const steps = [
    { title: 'Turn on Developer options', items: brand.devOptions },
    { title: 'Turn on USB debugging', items: brand.usbDebugging },
    { title: 'Plug in your phone and tap “Allow”', items: ['Use a cable that supports data (charge-only cables won’t work)', 'Unlock your phone and tap “Allow” on the popup'] }
  ]

  return (
    <div className="mx-auto max-w-4xl animate-fade-in">
      <PageHeader
        title="Connect with a USB cable"
        subtitle="Follow these steps on your phone. It takes about a minute."
        icon={<Usb className="size-5" />}
        right={
          <Button variant="ghost" icon={<ArrowLeft className="size-4" />} onClick={onBack}>
            Back
          </Button>
        }
      />

      <div className="mb-5">
        <div className="mb-2 text-[13px] font-medium text-2">What brand is your phone?</div>
        <div className="flex flex-wrap gap-2">
          {BRANDS.map((b) => (
            <button
              key={b.id}
              onClick={() => setBrandId(b.id)}
              className={cx(
                'cursor-pointer rounded-xl border px-3.5 py-2 text-[13px] font-medium transition',
                b.id === brandId ? 'border-brand-500 bg-brand-500/10 text-brand-700 dark:text-brand-200' : 'border-soft surface-1 text-2 hover:text-1'
              )}
            >
              {b.name}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-[1fr_280px] gap-5">
        <div className="space-y-3">
          {steps.map((s, i) => (
            <Card key={s.title} className="p-5">
              <div className="flex gap-4">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-600 text-sm font-bold text-white">{i + 1}</div>
                <div>
                  <div className="font-semibold text-1">{s.title}</div>
                  <ol className="mt-2 space-y-1.5 text-[13.5px] text-2">
                    {s.items.map((it) => (
                      <li key={it} className="flex gap-2">
                        <ChevronRight className="mt-0.5 size-4 shrink-0 text-brand-500" />
                        <span>{it}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              </div>
            </Card>
          ))}
          {brand.extra?.map((x) => (
            <Card key={x.title} className="border-amber-400/40 bg-amber-500/5 p-5">
              <div className="flex items-center gap-2 font-semibold text-1">
                <AlertTriangle className="size-4 text-amber-500" />
                {x.title}
              </div>
              <ul className="mt-2 list-disc space-y-1 pl-6 text-[13.5px] text-2">
                {x.steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </Card>
          ))}
        </div>

        <div className="space-y-4">
          <Card className="p-5 text-center">
            {usbDevice ? (
              <>
                <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-emerald-500/12 text-emerald-600">
                  <CheckCircle2 className="size-6" />
                </div>
                <div className="mt-3 font-semibold text-1">Phone detected!</div>
                <div className="mt-1 text-[13px] text-2">
                  {usbDevice.state === 'unauthorized' ? 'Now tap “Allow” on your phone.' : usbDevice.state === 'device' ? 'You’re all set.' : 'Connecting…'}
                </div>
              </>
            ) : detected ? (
              <>
                <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-amber-500/12 text-amber-500">
                  <Smartphone className="size-6" />
                </div>
                <div className="mt-3 font-semibold text-1">{detected.name} is plugged in</div>
                <div className="mt-1 text-[13px] text-2">
                  {detected.driverProblem ? 'Windows is missing a driver for it.' : 'USB debugging is still off. Finish steps 1 and 2 on the phone.'}
                </div>
              </>
            ) : (
              <>
                <div className="relative mx-auto flex size-12 items-center justify-center">
                  <span className="absolute inset-0 rounded-full bg-brand-500/25 animate-pulse-ring" />
                  <Cable className="relative size-6 text-brand-600" />
                </div>
                <div className="mt-3 font-semibold text-1">Waiting for your phone…</div>
                <div className="mt-1 text-[13px] text-2">We’ll notice it automatically as soon as you plug it in.</div>
              </>
            )}
          </Card>

          {platform === 'win32' && (
            <Card className="p-5">
              <div className="flex items-center gap-2 text-sm font-semibold text-1">
                <HardDriveDownload className="size-4 text-3" /> Phone plugged in but not found?
              </div>
              <p className="mt-1.5 text-[13px] text-2">Windows may be missing the USB driver for your phone.</p>
              <Button
                className="mt-3 w-full"
                size="sm"
                variant="secondary"
                loading={checking}
                onClick={async () => {
                  setChecking(true)
                  try {
                    setDrivers(await call('drivers:check'))
                  } catch (e) {
                    toastError(friendly(e))
                  } finally {
                    setChecking(false)
                  }
                }}
              >
                Check USB drivers
              </Button>
              {drivers && (
                <div className="mt-3 text-[13px]">
                  {drivers.problemDevices.length ? (
                    <>
                      <div className="text-rose-600 dark:text-rose-400">
                        Found {drivers.problemDevices.length} device{drivers.problemDevices.length > 1 ? 's' : ''} without a working driver
                        {drivers.problemDevices[0].vendor ? ` (${drivers.problemDevices[0].vendor})` : ''}.
                      </div>
                      {drivers.problemDevices.some((d) => d.vendor === 'Samsung') ? (
                        <Button
                          className="mt-2 w-full"
                          size="sm"
                          onClick={() => void call('shell:openExternal', 'https://developer.samsung.com/android-usb-driver')}
                        >
                          Get Samsung USB Driver
                        </Button>
                      ) : (
                        <Button
                          className="mt-2 w-full"
                          size="sm"
                          loading={installing}
                          onClick={async () => {
                            setInstalling(true)
                            try {
                              const message = await call('drivers:installGoogle')
                              toast({ kind: 'success', title: 'USB driver ready', message: `${message} Unplug and reconnect your phone.` })
                            } catch (e) {
                              toastError(friendly(e))
                            } finally {
                              setInstalling(false)
                            }
                          }}
                        >
                          Install USB driver
                        </Button>
                      )}
                      <button
                        className="mt-2 w-full cursor-pointer text-[12px] text-brand-600 hover:underline dark:text-brand-300"
                        onClick={() => void call('shell:openExternal', 'https://developer.android.com/studio/run/oem-usb')}
                      >
                        Other brands: official driver list
                      </button>
                    </>
                  ) : drivers.androidUsbDevices > 0 ? (
                    <div className="text-2">
                      Your phone is visible to Windows and its driver is fine. Make sure <b>USB debugging</b> is turned on.
                    </div>
                  ) : (
                    <div className="text-2">No Android phone is plugged in. Try another cable or USB port.</div>
                  )}
                </div>
              )}
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

function WirelessPanel({ onBack }: { onBack: () => void }) {
  const [tab, setTab] = useState<'qr' | 'code' | 'usb'>('qr')
  return (
    <div className="mx-auto max-w-4xl animate-fade-in">
      <PageHeader
        title="Connect over Wi-Fi"
        subtitle="Your phone and this computer must be on the same Wi-Fi network."
        icon={<Wifi className="size-5" />}
        right={
          <Button variant="ghost" icon={<ArrowLeft className="size-4" />} onClick={onBack}>
            Back
          </Button>
        }
      />
      <div className="mb-5">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'qr', label: 'Scan QR code', icon: <QrCode className="size-4" /> },
            { value: 'code', label: 'Pairing code', icon: <KeyRound className="size-4" /> },
            { value: 'usb', label: 'From USB', icon: <Usb className="size-4" /> }
          ]}
        />
      </div>
      {tab === 'qr' && <QrPairing />}
      {tab === 'code' && <CodePairing />}
      {tab === 'usb' && <UsbToWifi />}
    </div>
  )
}

function QrPairing() {
  const [session, setSession] = useState<QrPairingSession | null>(null)
  const [status, setStatus] = useState<PairingStatus | null>(null)
  const [brandId, setBrandId] = useState('samsung')
  const brand = BRANDS.find((b) => b.id === brandId) ?? BRANDS[0]
  const toast = useApp((s) => s.toast)
  const setPage = useApp((s) => s.setPage)
  const select = useApp((s) => s.selectDevice)

  const start = useCallback(async () => {
    setStatus(null)
    try {
      setSession(await call('wireless:startQr'))
    } catch (e) {
      setStatus({ sessionId: '', phase: 'error', message: friendly(e).message })
    }
  }, [])

  useEffect(() => {
    void start()
  }, [start])

  useEffect(() => {
    return on('wireless:pairing', (s) => {
      setStatus((prev) => (session && s.sessionId !== session.sessionId ? prev : s))
      if (s.phase === 'connected') {
        toast({ kind: 'success', title: 'Connected over Wi-Fi!', message: 'Your phone is ready.' })
        if (s.serial) select(s.serial)
        setPage('home')
      }
    })
  }, [session, toast, setPage, select])

  useEffect(() => {
    return () => {
      if (session) void call('wireless:cancelQr', session.sessionId).catch(() => undefined)
    }
  }, [session])

  const phase = status?.phase ?? 'waiting'
  return (
    <div className="grid grid-cols-[320px_1fr] gap-6">
      <Card className="flex flex-col items-center p-6">
        <div className="relative flex size-[260px] items-center justify-center rounded-2xl bg-white p-3">
          {session ? (
            <img src={session.qrDataUrl} alt="Wireless debugging pairing QR code" className={cx('size-full', phase !== 'waiting' && 'opacity-25')} />
          ) : (
            <Spinner />
          )}
          {session && phase !== 'waiting' && phase !== 'error' && phase !== 'cancelled' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-900">
              {phase === 'connected' ? <CheckCircle2 className="size-12 text-emerald-500" /> : <Loader2 className="size-10 animate-spin text-brand-600" />}
            </div>
          )}
        </div>
        <div
          className={cx(
            'mt-4 flex items-center gap-2 text-[13px] font-medium',
            phase === 'error' ? 'text-rose-600 dark:text-rose-400' : phase === 'connected' ? 'text-emerald-600' : 'text-2'
          )}
        >
          {phase === 'waiting' && <span className="size-2 animate-pulse rounded-full bg-brand-500" />}
          {status?.message ?? 'Waiting for your phone to scan the code…'}
        </div>
        {(phase === 'error' || phase === 'cancelled') && (
          <Button className="mt-3" size="sm" variant="secondary" icon={<RefreshCw className="size-3.5" />} onClick={() => void start()}>
            New QR code
          </Button>
        )}
      </Card>
      <Card className="p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="font-semibold whitespace-nowrap text-1">On your phone</div>
          <select
            value={brandId}
            onChange={(e) => setBrandId(e.target.value)}
            className="h-8 cursor-pointer rounded-lg border border-soft surface-2 px-2 text-[13px] text-1 outline-none"
          >
            {BRANDS.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
        <ol className="mt-4 space-y-4">
          {[
            'Connect your phone to the same Wi-Fi as this computer.',
            'Make sure Developer options are on (see the USB guide if not).',
            ...brand.wireless,
            'Point your phone’s camera at this QR code. Easy ADB does the rest.'
          ].map((s, i) => (
            <li key={s} className="flex gap-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-600/10 text-[12px] font-bold text-brand-700 dark:text-brand-300">
                {i + 1}
              </span>
              <span className="text-[13.5px] text-2">{s}</span>
            </li>
          ))}
        </ol>
        <div className="mt-6 rounded-xl surface-2 p-3 text-[12.5px] text-3">
          Wireless debugging needs Android 11 or newer. On older phones, connect once with USB and use “From USB”.
        </div>
      </Card>
    </div>
  )
}

function CodePairing() {
  const [host, setHost] = useState('')
  const [pairPort, setPairPort] = useState('')
  const [code, setCode] = useState('')
  const [connectPort, setConnectPort] = useState('')
  const [busy, setBusy] = useState<'pair' | 'connect' | null>(null)
  const [paired, setPaired] = useState(false)
  const toast = useApp((s) => s.toast)
  const toastError = useApp((s) => s.toastError)
  const setPage = useApp((s) => s.setPage)
  const devices = useApp((s) => s.devices)

  useEffect(() => {
    if (paired && devices.some((d) => d.transport === 'wifi' && d.state === 'device' && d.serial.startsWith(host + ':'))) {
      toast({ kind: 'success', title: 'Connected over Wi-Fi!' })
      setPage('home')
    }
  }, [paired, devices, host, toast, setPage])

  return (
    <div className="grid grid-cols-2 gap-6">
      <Card className="p-6">
        <div className="font-semibold text-1">1 · Pair with a code</div>
        <p className="mt-1 text-[13px] text-2">
          On your phone, open Wireless debugging and tap <b>“Pair device with pairing code”</b>. Enter what it shows:
        </p>
        <div className="mt-4 grid grid-cols-[1fr_110px] gap-3">
          <label className="text-[12px] font-medium text-2">
            IP address
            <TextInput className="mt-1" placeholder="192.168.1.23" value={host} onChange={(e) => setHost(e.target.value.trim())} />
          </label>
          <label className="text-[12px] font-medium text-2">
            Port
            <TextInput className="mt-1" placeholder="37123" inputMode="numeric" value={pairPort} onChange={(e) => setPairPort(e.target.value.replace(/\D/g, ''))} />
          </label>
        </div>
        <label className="mt-3 block text-[12px] font-medium text-2">
          Wi-Fi pairing code
          <TextInput
            className="mt-1 font-mono text-lg tracking-[0.4em]"
            placeholder="••••••"
            maxLength={6}
            inputMode="numeric"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          />
        </label>
        <Button
          className="mt-4 w-full"
          disabled={!host || !pairPort || code.length !== 6}
          loading={busy === 'pair'}
          onClick={async () => {
            setBusy('pair')
            try {
              const connected = await call('wireless:pairManual', host, Number(pairPort), code)
              setPaired(true)
              // When it connected by itself the app moves to Home and says so; only ask for step 2 otherwise.
              if (!connected) toast({ kind: 'success', title: 'Paired!', message: 'Now connect using the port on the main Wireless debugging screen.' })
            } catch (e) {
              toastError(friendly(e))
            } finally {
              setBusy(null)
            }
          }}
        >
          Pair
        </Button>
      </Card>
      <Card className={cx('p-6 transition-opacity', !paired && 'opacity-90')}>
        <div className="flex items-center gap-2 font-semibold text-1">
          2 · Connect {paired && <Badge tone="green">Paired</Badge>}
        </div>
        <p className="mt-1 text-[13px] text-2">
          Close the pairing popup. Under <b>“IP address &amp; Port”</b> on the Wireless debugging screen, enter the port number (it’s different from the
          pairing port):
        </p>
        <div className="mt-4 grid grid-cols-[1fr_110px] gap-3">
          <label className="text-[12px] font-medium text-2">
            IP address
            <TextInput className="mt-1" placeholder="192.168.1.23" value={host} onChange={(e) => setHost(e.target.value.trim())} />
          </label>
          <label className="text-[12px] font-medium text-2">
            Port
            <TextInput className="mt-1" placeholder="41567" inputMode="numeric" value={connectPort} onChange={(e) => setConnectPort(e.target.value.replace(/\D/g, ''))} />
          </label>
        </div>
        <Button
          className="mt-4 w-full"
          variant="secondary"
          disabled={!host || !connectPort}
          loading={busy === 'connect'}
          onClick={async () => {
            setBusy('connect')
            try {
              await call('wireless:connect', host, Number(connectPort))
              toast({ kind: 'success', title: 'Connected over Wi-Fi!' })
              setPage('home')
            } catch (e) {
              toastError(friendly(e))
            } finally {
              setBusy(null)
            }
          }}
        >
          Connect
        </Button>
        <p className="mt-3 text-[12px] text-3">Tip: once paired, Easy ADB usually connects by itself within a few seconds.</p>
      </Card>
    </div>
  )
}

function UsbToWifi() {
  const devices = useApp((s) => s.devices)
  const details = useApp((s) => s.details)
  const usb = devices.filter((d) => d.transport === 'usb' && d.state === 'device')
  const [busy, setBusy] = useState<string | null>(null)
  const toast = useApp((s) => s.toast)
  const toastError = useApp((s) => s.toastError)
  const select = useApp((s) => s.selectDevice)

  return (
    <Card className="p-6">
      <div className="font-semibold text-1">Switch a USB-connected phone to Wi-Fi</div>
      <p className="mt-1 text-[13px] text-2">
        Works on any Android version. Connect with a cable once, click the button, then unplug — the phone stays connected over Wi-Fi until it
        restarts.
      </p>
      {usb.length === 0 ? (
        <div className="mt-5 rounded-xl surface-2 p-4 text-[13px] text-3">Plug in your phone with a USB cable first.</div>
      ) : (
        <div className="mt-5 space-y-2">
          {usb.map((d) => (
            <div key={d.serial} className="flex items-center gap-3 rounded-xl surface-2 p-3">
              <Usb className="size-4 text-3" />
              <div className="flex-1 text-sm font-medium text-1">{deviceDisplayName(d, details[d.serial])}</div>
              <Button
                size="sm"
                loading={busy === d.serial}
                icon={<Wifi className="size-3.5" />}
                onClick={async () => {
                  setBusy(d.serial)
                  try {
                    const serial = await call('wireless:switchToWifi', d.serial)
                    select(serial)
                    toast({ kind: 'success', title: 'Wi-Fi connection ready', message: 'You can unplug the cable now.' })
                  } catch (e) {
                    toastError(friendly(e))
                  } finally {
                    setBusy(null)
                  }
                }}
              >
                Go wireless
              </Button>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}
