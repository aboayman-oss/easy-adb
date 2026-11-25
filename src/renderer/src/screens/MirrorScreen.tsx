import { Camera, Gauge, Leaf, MonitorSmartphone, MonitorX, Pin, Sparkles, Sun, SunMoon, Video, Volume2, Zap } from 'lucide-react'
import type { MirrorOptions, MirrorQuality } from '@shared/types'
import { PhoneFrame } from '../components/Illustrations'
import { Badge, Button, Card, Kbd, PageHeader, SectionTitle, Toggle } from '../components/ui'
import { call, friendly } from '../lib/api'
import { cx } from '../lib/format'
import { deviceDisplayName, useApp, useSelectedDevice } from '../store'
import { CapturePreview } from './Dashboard'
import { useCapture } from './useCapture'

const QUALITY: { value: MirrorQuality; label: string; desc: string; icon: React.ReactNode }[] = [
  { value: 'smooth', label: 'Smooth', desc: 'Full resolution, 60 fps. Best over USB.', icon: <Sparkles className="size-5" /> },
  { value: 'balanced', label: 'Balanced', desc: 'Sharp and fluid. Great for most uses.', icon: <Gauge className="size-5" /> },
  { value: 'saver', label: 'Data saver', desc: 'Lower resolution. Best over Wi-Fi.', icon: <Leaf className="size-5" /> }
]

export function MirrorScreen() {
  const device = useSelectedDevice()
  const serial = device?.serial ?? ''
  const settings = useApp((s) => s.settings)
  const patchSettings = useApp((s) => s.patchSettings)
  const running = useApp((s) => !!s.mirroring[serial])
  const toastError = useApp((s) => s.toastError)
  const capture = useCapture(serial)
  const opts = settings?.mirror

  const name = useApp((s) => deviceDisplayName(device, s.details[serial]))

  if (!opts) return null
  const update = (patch: Partial<MirrorOptions>): void => void patchSettings({ mirror: { ...opts, ...patch } })

  const toggleMirror = async (): Promise<void> => {
    try {
      if (running) await call('mirror:stop', serial)
      else await call('mirror:start', serial, opts, name)
    } catch (e) {
      toastError(friendly(e))
    }
  }

  return (
    <div className="@container/mirror mx-auto max-w-5xl animate-fade-in">
      <PageHeader title="Mirror & Capture" subtitle="See and control your phone on your computer, take screenshots and record the screen." icon={<MonitorSmartphone className="size-5" />} />

      <Card className="relative mb-5 overflow-hidden p-8">
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-brand-500/8 via-transparent to-violet-500/10" />
        <div className="relative flex items-center gap-10">
          <PhoneFrame className="h-[240px] w-[120px] shrink-0">
            <div className="flex h-full flex-col items-center justify-center gap-2 text-brand-600 dark:text-brand-300">
              {running ? (
                <>
                  <span className="relative flex size-3">
                    <span className="absolute inline-flex h-full w-full rounded-full bg-rose-500 animate-pulse-ring" />
                    <span className="relative inline-flex size-3 rounded-full bg-rose-500" />
                  </span>
                  <span className="text-[10px] font-semibold">LIVE</span>
                </>
              ) : (
                <MonitorSmartphone className="size-8 opacity-70" />
              )}
            </div>
          </PhoneFrame>
          <div className="flex-1">
            {running ? <Badge tone="red">Mirroring now</Badge> : <Badge tone="blue">Ready</Badge>}
            <h2 className="mt-3 font-display text-[24px] font-bold tracking-tight text-1">{running ? 'Your phone is on your screen' : 'Mirror your phone'}</h2>
            <p className="mt-1.5 max-w-md text-[14px] text-2">
              {running
                ? 'Use your mouse and keyboard to control it. Close the mirroring window or press Stop when you’re done.'
                : 'Opens a window showing your phone in real time. Click to tap, scroll to swipe, type with your keyboard.'}
            </p>
            <Button
              size="lg"
              className="mt-5"
              variant={running ? 'danger' : 'primary'}
              icon={running ? <MonitorX className="size-5" /> : <MonitorSmartphone className="size-5" />}
              onClick={() => void toggleMirror()}
            >
              {running ? 'Stop mirroring' : 'Start mirroring'}
            </Button>
            <ScreenWhileMirroring off={opts.turnScreenOff} running={running} onChange={(v) => update({ turnScreenOff: v })} />
          </div>
        </div>
      </Card>

      <div className="grid gap-5 @4xl/mirror:grid-cols-[1.3fr_1fr]">
        <Card className="p-5">
          <SectionTitle title="Quality" subtitle="Applies the next time you start mirroring." />
          <div className="grid grid-cols-3 gap-2.5">
            {QUALITY.map((q) => (
              <button
                key={q.value}
                onClick={() => update({ quality: q.value })}
                className={cx(
                  'flex cursor-pointer flex-col items-start justify-start rounded-2xl border p-3.5 text-left transition',
                  opts.quality === q.value ? 'border-brand-500 bg-brand-500/8 ring-4 ring-brand-500/10' : 'border-soft hover:border-brand-400/60'
                )}
              >
                <div className={cx(opts.quality === q.value ? 'text-brand-600 dark:text-brand-300' : 'text-3')}>{q.icon}</div>
                <div className="mt-2 text-[14px] font-semibold text-1">{q.label}</div>
                <div className="mt-0.5 text-[12px] leading-snug text-3">{q.desc}</div>
              </button>
            ))}
          </div>
          <div className="mt-5 space-y-1">
            {[
              { key: 'stayAwake' as const, icon: <Zap className="size-4" />, label: 'Keep phone awake', desc: 'Prevents the phone from locking while plugged in.' },
              { key: 'audio' as const, icon: <Volume2 className="size-4" />, label: 'Play phone sound on this computer', desc: 'Android 11 or newer.' },
              { key: 'alwaysOnTop' as const, icon: <Pin className="size-4" />, label: 'Keep mirroring window on top', desc: 'Handy while you work in other apps.' }
            ].map((t) => (
              <div key={t.key} className="flex items-center gap-3 rounded-xl px-2 py-2.5 hover:surface-2">
                <span className="text-3">{t.icon}</span>
                <div className="flex-1">
                  <div className="text-[13.5px] font-medium text-1">{t.label}</div>
                  <div className="text-[12px] text-3">{t.desc}</div>
                </div>
                <Toggle checked={opts[t.key]} onChange={(v) => update({ [t.key]: v })} label={t.label} />
              </div>
            ))}
          </div>
        </Card>

        <div className="grid content-start gap-5 @xl/mirror:grid-cols-2 @4xl/mirror:grid-cols-1">
          <Card className="p-5">
            <SectionTitle title="Screenshot to PC" subtitle="Saved instantly as a PNG on your computer." />
            <Button className="w-full" variant="secondary" size="lg" loading={capture.busy} icon={<Camera className="size-5" />} onClick={() => void capture.screenshot()}>
              Take screenshot
            </Button>
          </Card>
          <Card className="p-5">
            <SectionTitle title="Record screen" subtitle="Up to 3 minutes per recording, saved as MP4." />
            <Button
              className="w-full"
              variant={capture.recording ? 'danger' : 'secondary'}
              size="lg"
              loading={capture.stopping}
              icon={<Video className={cx('size-5', capture.recording && 'animate-pulse')} />}
              onClick={() => void capture.toggleRecord()}
            >
              {capture.saving ? 'Saving video…' : capture.recording ? `Stop & save · ${capture.elapsed}` : 'Start recording'}
            </Button>
            <p className="mt-2.5 text-[12px] text-3">Sound isn’t included in screen recordings (an Android limitation).</p>
          </Card>
          <Card className="p-4 text-[12.5px] text-2 @xl/mirror:col-span-2 @4xl/mirror:col-span-1">
            Files are saved to <span className="selectable font-medium text-1">{settings?.captureDir}</span>
            <button className="ml-1 cursor-pointer text-brand-600 hover:underline dark:text-brand-300" onClick={() => settings && void call('shell:openPath', settings.captureDir).catch(() => undefined)}>
              Open folder
            </button>
          </Card>
        </div>
      </div>
      {capture.preview && capture.lastPath && <CapturePreview src={capture.preview} path={capture.lastPath} onClose={capture.clearPreview} />}
    </div>
  )
}

/** Whether the phone's own screen stays on while it is mirrored (next to the Start button, where people look). */
function ScreenWhileMirroring({ off, running, onChange }: { off: boolean; running: boolean; onChange: (off: boolean) => void }) {
  return (
    <div className="mt-5 max-w-md">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-[13px] font-medium text-2">Phone screen while mirroring</span>
        <div className="flex rounded-xl surface-2 p-0.5" role="radiogroup" aria-label="Phone screen while mirroring">
          {[
            { value: false, label: 'Keep on', icon: <Sun className="size-3.5" /> },
            { value: true, label: 'Turn off', icon: <SunMoon className="size-3.5" /> }
          ].map((o) => (
            <button
              key={o.label}
              role="radio"
              aria-checked={off === o.value}
              onClick={() => onChange(o.value)}
              className={cx(
                'flex cursor-pointer items-center gap-1.5 rounded-[10px] px-3 py-1.5 text-[12.5px] font-medium transition',
                off === o.value ? 'surface-1 text-1 shadow-sm' : 'text-3 hover:text-1'
              )}
            >
              {o.icon}
              {o.label}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-2 text-[12px] leading-relaxed text-3">
        {running ? (
          <>
            In the mirroring window, <Kbd>Alt</Kbd> + <Kbd>Shift</Kbd> + <Kbd>O</Kbd> turns the phone screen on and <Kbd>Alt</Kbd> + <Kbd>O</Kbd> turns it
            off. Changes here apply next time.
          </>
        ) : off ? (
          'Saves battery and keeps your screen private. The phone still responds if someone touches it.'
        ) : (
          'You can use the phone normally while it’s mirrored.'
        )}
      </p>
    </div>
  )
}
