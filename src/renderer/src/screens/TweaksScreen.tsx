import { BatteryCharging, Gauge, LifeBuoy, Power, RotateCw, Rabbit, SlidersHorizontal, Snail, Type, Zap } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AnimationPreset, DensityInfo } from '@shared/types'
import { Badge, Button, Card, Modal, PageHeader, SectionTitle, Spinner, Toggle } from '../components/ui'
import { call, friendly, on } from '../lib/api'
import { cx } from '../lib/format'
import { useApp, useSelectedDevice } from '../store'

const ANIMATIONS: { preset: AnimationPreset; scale: number; label: string; desc: string; icon: React.ReactNode }[] = [
  { preset: 'normal', scale: 1, label: 'Normal', desc: '1× · the way your phone came', icon: <Snail className="size-5" /> },
  { preset: 'fast', scale: 0.5, label: 'Snappy', desc: '0.5× · feels twice as fast', icon: <Rabbit className="size-5" /> },
  { preset: 'off', scale: 0, label: 'Instant', desc: '0× · no animations at all', icon: <Zap className="size-5" /> }
]

const POWER: { action: 'reboot' | 'recovery' | 'poweroff'; label: string; desc: string; icon: React.ReactNode; confirm: string }[] = [
  { action: 'reboot', label: 'Restart phone', desc: 'A normal restart. Fixes most glitches.', icon: <RotateCw className="size-5" />, confirm: 'Your phone will restart. Unsaved work in open apps may be lost.' },
  {
    action: 'recovery',
    label: 'Restart to Recovery',
    desc: 'A maintenance menu for clearing cache or factory reset. Doesn’t change anything by itself.',
    icon: <LifeBuoy className="size-5" />,
    confirm: 'Your phone will restart into Recovery mode — a text menu controlled with the volume and power buttons. To leave it, choose “Reboot system now”. Don’t choose “Wipe data” unless you want to erase your phone.'
  },
  { action: 'poweroff', label: 'Power off', desc: 'Turns the phone off completely.', icon: <Power className="size-5" />, confirm: 'Your phone will shut down. Turn it on with its power button. It will disconnect from Easy ADB.' }
]

export function TweaksScreen() {
  const device = useSelectedDevice()
  const serial = device?.serial ?? ''
  const toast = useApp((s) => s.toast)
  const toastError = useApp((s) => s.toastError)
  const [anim, setAnim] = useState<{ preset: AnimationPreset; scale: number } | null>(null)
  const [density, setDensity] = useState<DensityInfo | null>(null)
  const [densityIdx, setDensityIdx] = useState(2)
  const [stayAwake, setStayAwakeState] = useState<boolean | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [countdown, setCountdown] = useState<number | null>(null)
  const [power, setPower] = useState<(typeof POWER)[number] | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async () => {
    if (!serial) return
    try {
      const [a, d, s] = await Promise.all([call('tweaks:animation', serial), call('tweaks:density', serial), call('tweaks:stayAwake', serial)])
      setAnim(a)
      setDensity(d)
      setStayAwakeState(s)
      const idx = d.presets.reduce((best, p, i) => (Math.abs(p.value - d.current) < Math.abs(d.presets[best].value - d.current) ? i : best), 0)
      setDensityIdx(idx)
    } catch (e) {
      toastError(friendly(e))
    }
  }, [serial, toastError])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(
    () =>
      on('density:reverted', (p) => {
        if (p.serial !== serial) return
        if (timer.current) clearInterval(timer.current)
        setCountdown(null)
        toast({ kind: 'info', title: 'Display size restored', message: 'The change wasn’t confirmed, so we put it back.' })
        void load()
      }),
    [serial, toast, load]
  )

  useEffect(() => () => {
    if (timer.current) clearInterval(timer.current)
  }, [])

  const applyAnimation = async (scale: number): Promise<void> => {
    setBusy('anim')
    try {
      await call('tweaks:setAnimation', serial, scale)
      setAnim({ preset: ANIMATIONS.find((a) => a.scale === scale)?.preset ?? 'custom', scale })
      toast({ kind: 'success', title: 'Animation speed updated' })
    } catch (e) {
      toastError(friendly(e))
    } finally {
      setBusy(null)
    }
  }

  const applyDensity = async (): Promise<void> => {
    if (!density) return
    setBusy('density')
    try {
      const value = density.presets[densityIdx].value
      const { revertInSeconds } = await call('tweaks:setDensity', serial, value === density.physical ? null : value)
      setCountdown(revertInSeconds)
      if (timer.current) clearInterval(timer.current)
      timer.current = setInterval(() => setCountdown((c) => (c === null || c <= 1 ? (timer.current && clearInterval(timer.current), null) : c - 1)), 1000)
    } catch (e) {
      toastError(friendly(e))
    } finally {
      setBusy(null)
    }
  }

  const keepDensity = async (): Promise<void> => {
    if (timer.current) clearInterval(timer.current)
    setCountdown(null)
    await call('tweaks:confirmDensity', serial)
    toast({ kind: 'success', title: 'Display size saved' })
    void load()
  }

  const revert = async (): Promise<void> => {
    if (timer.current) clearInterval(timer.current)
    setCountdown(null)
    await call('tweaks:revertDensity', serial).catch(() => undefined)
  }

  const currentDensityLabel = density ? density.presets.find((p) => p.value === density.current)?.label ?? `${density.current} dpi` : ''

  return (
    <div className="mx-auto max-w-5xl animate-fade-in">
      <PageHeader title="Tweaks & Power" subtitle="Safe tweaks that make your phone feel faster and easier to use." icon={<SlidersHorizontal className="size-5" />} />

      <Card className="mb-5 p-5">
        <SectionTitle
          title="Animation speed"
          subtitle="Shorter animations make every tap, swipe and app launch feel quicker."
          right={anim?.preset === 'custom' && <Badge tone="neutral">Custom ({anim.scale}×)</Badge>}
        />
        <div className="grid grid-cols-3 gap-3">
          {ANIMATIONS.map((a) => (
            <button
              key={a.preset}
              disabled={busy === 'anim' || !anim}
              onClick={() => void applyAnimation(a.scale)}
              className={cx(
                'flex cursor-pointer items-center gap-3 rounded-2xl border p-4 text-left transition disabled:cursor-wait',
                anim?.preset === a.preset ? 'border-brand-500 bg-brand-500/8 ring-4 ring-brand-500/10' : 'border-soft hover:border-brand-400/60'
              )}
            >
              <div className={cx('flex size-10 items-center justify-center rounded-xl', anim?.preset === a.preset ? 'bg-brand-600 text-white' : 'surface-3 text-2')}>{a.icon}</div>
              <div>
                <div className="font-semibold text-1">{a.label}</div>
                <div className="text-[12.5px] text-3">{a.desc}</div>
              </div>
            </button>
          ))}
        </div>
      </Card>

      <div className="mb-5 grid grid-cols-[1.4fr_1fr] gap-5">
        <Card className="p-5">
          <SectionTitle
            title="Text & display size"
            subtitle="Make everything on screen bigger or smaller."
            right={density && <Badge tone="neutral" icon={<Type className="size-3" />}>Now: {currentDensityLabel}</Badge>}
          />
          {density ? (
            <>
              <div className="flex items-end justify-between px-1 pb-2 text-3">
                <span className="text-[12px]">Aa</span>
                <span className="text-[20px] font-semibold">Aa</span>
              </div>
              <input
                type="range"
                min={0}
                max={density.presets.length - 1}
                step={1}
                value={densityIdx}
                onChange={(e) => setDensityIdx(Number(e.target.value))}
                className="w-full cursor-pointer accent-brand-600"
                aria-label="Display size"
              />
              <div className="mt-1 flex justify-between text-[11.5px] text-3">
                {density.presets.map((p, i) => (
                  <span key={p.label} className={cx(i === densityIdx && 'font-semibold text-brand-600 dark:text-brand-300')}>
                    {p.label}
                  </span>
                ))}
              </div>
              <div className="mt-4 flex items-center gap-3">
                <Button loading={busy === 'density'} disabled={density.presets[densityIdx].value === density.current} onClick={() => void applyDensity()}>
                  Apply
                </Button>
                <span className="text-[12.5px] text-3">You’ll have 10 seconds to keep it — otherwise it switches back automatically.</span>
              </div>
            </>
          ) : (
            <Spinner />
          )}
        </Card>

        <Card className="p-5">
          <SectionTitle title="Stay awake while charging" subtitle="Screen never sleeps while plugged in. Great for navigation or presentations." />
          <div className="flex items-center gap-3 rounded-2xl surface-2 p-4">
            <BatteryCharging className="size-5 text-3" />
            <span className="flex-1 text-[13.5px] font-medium text-1">{stayAwake ? 'On' : 'Off'}</span>
            {stayAwake === null ? (
              <Spinner className="size-4 text-brand-600" />
            ) : (
              <Toggle
                checked={stayAwake}
                label="Stay awake while charging"
                onChange={async (v) => {
                  try {
                    await call('tweaks:setStayAwake', serial, v)
                    setStayAwakeState(v)
                  } catch (e) {
                    toastError(friendly(e))
                  }
                }}
              />
            )}
          </div>
          <div className="mt-3 flex items-center gap-2 text-[12px] text-3">
            <Gauge className="size-3.5" /> Uses a little more battery while charging.
          </div>
        </Card>
      </div>

      <Card className="p-5">
        <SectionTitle title="Power" subtitle="Restart or turn off your phone from here." />
        <div className="grid grid-cols-3 gap-3">
          {POWER.map((p) => (
            <button
              key={p.action}
              onClick={() => setPower(p)}
              className="flex cursor-pointer flex-col items-start justify-start rounded-2xl border border-soft p-4 text-left transition hover:border-brand-400/60 hover:shadow-md"
            >
              <div className={cx('flex size-10 items-center justify-center rounded-xl', p.action === 'poweroff' ? 'bg-rose-500/12 text-rose-500' : 'surface-3 text-2')}>{p.icon}</div>
              <div className="mt-3 font-semibold text-1">{p.label}</div>
              <div className="mt-0.5 text-[12.5px] leading-snug text-3">{p.desc}</div>
            </button>
          ))}
        </div>
      </Card>

      <Modal
        open={countdown !== null}
        onClose={() => void revert()}
        dismissable={false}
        title="Keep this display size?"
        icon={<Type className="size-5 text-brand-500" />}
        footer={
          <>
            <Button variant="ghost" onClick={() => void revert()}>
              Revert
            </Button>
            <Button onClick={() => void keepDensity()}>Keep it</Button>
          </>
        }
      >
        <p>Look at your phone. If everything looks right, keep the new size.</p>
        <div className="mt-4 flex items-center gap-3 rounded-xl surface-2 p-3">
          <div className="flex size-10 items-center justify-center rounded-full bg-brand-600 font-mono text-lg font-bold text-white tabular-nums">{countdown}</div>
          <span className="text-[13px]">Switching back automatically in {countdown} second{countdown === 1 ? '' : 's'}…</span>
        </div>
      </Modal>

      <Modal
        open={!!power}
        onClose={() => setPower(null)}
        title={`${power?.label}?`}
        icon={<Power className="size-5 text-rose-500" />}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPower(null)}>
              Cancel
            </Button>
            <Button
              variant={power?.action === 'poweroff' ? 'danger' : 'primary'}
              loading={busy === 'power'}
              onClick={async () => {
                if (!power) return
                setBusy('power')
                try {
                  await call('power:action', serial, power.action)
                  toast({ kind: 'success', title: power.action === 'poweroff' ? 'Phone is shutting down' : 'Phone is restarting' })
                  setPower(null)
                } catch (e) {
                  toastError(friendly(e))
                } finally {
                  setBusy(null)
                }
              }}
            >
              {power?.label}
            </Button>
          </>
        }
      >
        {power?.confirm}
      </Modal>
    </div>
  )
}
