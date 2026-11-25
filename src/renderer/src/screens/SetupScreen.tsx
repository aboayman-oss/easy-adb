import { AlertTriangle, CheckCircle2, Download, MonitorSmartphone, RefreshCw, ShieldCheck, Usb } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Logo } from '../components/Illustrations'
import { Button, ProgressBar } from '../components/ui'
import { call, friendly } from '../lib/api'
import { cx } from '../lib/format'
import { useApp } from '../store'

const STEPS = [
  { key: 'platform-tools', label: 'Android connection tools', detail: 'Official Google platform-tools', icon: Usb },
  { key: 'scrcpy', label: 'Screen mirroring engine', detail: 'Open-source scrcpy', icon: MonitorSmartphone },
  { key: 'verify', label: 'Safety check', detail: 'Checksums verified & tested', icon: ShieldCheck }
] as const

export function SetupScreen() {
  const progress = useApp((s) => s.engineProgress)
  const setEngine = useApp((s) => s.setEngine)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  const run = useCallback(async () => {
    setError(null)
    setRunning(true)
    try {
      const status = await call('engine:install')
      setEngine(status)
    } catch (e) {
      setError(friendly(e).message)
    } finally {
      setRunning(false)
    }
  }, [setEngine])

  useEffect(() => {
    void run()
  }, [run])

  const percent = progress?.percent ?? 0
  const failed = !!error || progress?.phase === 'error'
  const activeIdx = progress?.component === 'scrcpy' ? 1 : 0
  const doneIdx = progress?.phase === 'done' ? 3 : progress?.component === 'scrcpy' ? 1 : 0

  return (
    <div className="flex h-full items-center justify-center surface-0 p-8">
      <div className="w-full max-w-lg animate-slide-up">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="relative mb-5">
            <div className="absolute inset-0 rounded-3xl bg-brand-500/30 blur-2xl" />
            <Logo className="relative size-20" />
          </div>
          <h1 className="font-display text-[28px] font-bold tracking-tight text-1">Welcome to Easy ADB</h1>
          <p className="mt-2 max-w-sm text-[15px] text-2">
            We’re setting everything up for you. No downloads to find, nothing to configure — this only happens once.
          </p>
        </div>

        <div className="card p-6">
          {failed ? (
            <div className="text-center">
              <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-2xl bg-rose-500/10 text-rose-500">
                <AlertTriangle className="size-6" />
              </div>
              <div className="font-semibold text-1">We couldn’t finish preparing the engine</div>
              <p className="mt-1.5 text-sm text-2">{progress?.error ?? error}</p>
              <Button className="mt-5" icon={<RefreshCw className="size-4" />} onClick={() => void run()} loading={running}>
                Try again
              </Button>
            </div>
          ) : (
            <>
              <div className="mb-2 flex items-baseline justify-between">
                <div className="text-[15px] font-semibold text-1">Preparing Easy ADB engine…</div>
                <div className="font-mono text-sm font-semibold text-brand-600 tabular-nums dark:text-brand-300">{percent}%</div>
              </div>
              <ProgressBar value={percent} />
              <div className="mt-2 h-5 truncate text-[13px] text-3">{progress?.message ?? 'Checking what’s needed…'}</div>

              <div className="mt-5 space-y-2.5">
                {STEPS.map((s, i) => {
                  const done = i < doneIdx || progress?.phase === 'done'
                  const active = !done && (i === activeIdx || (i === 2 && progress?.phase === 'verifying'))
                  const Icon = s.icon
                  return (
                    <div
                      key={s.key}
                      className={cx('flex items-center gap-3 rounded-xl p-2.5 transition-colors', active && 'surface-2')}
                    >
                      <div
                        className={cx(
                          'flex size-9 items-center justify-center rounded-xl',
                          done ? 'bg-emerald-500/12 text-emerald-600' : active ? 'bg-brand-500/12 text-brand-600' : 'surface-3 text-3'
                        )}
                      >
                        {done ? <CheckCircle2 className="size-5" /> : active ? <Download className="size-[18px] animate-pulse" /> : <Icon className="size-[18px]" />}
                      </div>
                      <div>
                        <div className={cx('text-sm font-medium', done || active ? 'text-1' : 'text-3')}>{s.label}</div>
                        <div className="text-[12px] text-3">{s.detail}</div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>
        <p className="mt-5 text-center text-[12px] text-3">Downloads come directly from Google and the official scrcpy project.</p>
      </div>
    </div>
  )
}
