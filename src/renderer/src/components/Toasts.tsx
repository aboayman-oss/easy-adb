import { CheckCircle2, Info, X, XCircle } from 'lucide-react'
import { useApp } from '../store'
import { cx } from '../lib/format'

export function Toasts() {
  const toasts = useApp((s) => s.toasts)
  const dismiss = useApp((s) => s.dismissToast)
  return (
    <div className="pointer-events-none fixed top-4 right-4 z-[60] flex w-[360px] flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className="pointer-events-auto flex items-start gap-3 rounded-2xl border border-soft surface-1 p-3.5 shadow-xl shadow-slate-900/10 animate-slide-up"
        >
          <div
            className={cx(
              'mt-0.5 shrink-0',
              t.kind === 'success' && 'text-emerald-500',
              t.kind === 'error' && 'text-rose-500',
              t.kind === 'info' && 'text-brand-500'
            )}
          >
            {t.kind === 'success' ? <CheckCircle2 className="size-5" /> : t.kind === 'error' ? <XCircle className="size-5" /> : <Info className="size-5" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-1">{t.title}</div>
            {t.message && <div className="mt-0.5 text-[13px] leading-snug text-2">{t.message}</div>}
            {t.action && (
              <button
                className="mt-1.5 cursor-pointer text-[13px] font-semibold text-brand-600 hover:underline dark:text-brand-300"
                onClick={() => {
                  t.action?.run()
                  dismiss(t.id)
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
          <button className="cursor-pointer text-3 hover:text-1" onClick={() => dismiss(t.id)} aria-label="Dismiss">
            <X className="size-4" />
          </button>
        </div>
      ))}
    </div>
  )
}
