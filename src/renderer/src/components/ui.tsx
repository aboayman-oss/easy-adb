import { Loader2, X } from 'lucide-react'
import { useEffect, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cx } from '../lib/format'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'outline'
type Size = 'sm' | 'md' | 'lg'

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-brand-600 text-white hover:bg-brand-500 active:bg-brand-700 shadow-sm shadow-brand-600/25 disabled:bg-brand-600/50',
  secondary: 'surface-3 text-1 hover:brightness-95 dark:hover:brightness-125 disabled:opacity-50',
  ghost: 'text-2 hover:surface-3 hover:text-1 disabled:opacity-40',
  danger: 'bg-rose-600 text-white hover:bg-rose-500 active:bg-rose-700 shadow-sm shadow-rose-600/25 disabled:opacity-50',
  success: 'bg-emerald-600 text-white hover:bg-emerald-500 active:bg-emerald-700 shadow-sm shadow-emerald-600/25 disabled:opacity-50',
  outline: 'border border-soft text-1 hover:surface-3 disabled:opacity-50'
}

const SIZES: Record<Size, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-lg',
  md: 'h-10 px-4 text-sm gap-2 rounded-xl',
  lg: 'h-12 px-6 text-[15px] gap-2.5 rounded-2xl'
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading,
  icon,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; loading?: boolean; icon?: ReactNode }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(
        'inline-flex shrink-0 cursor-pointer items-center justify-center font-medium whitespace-nowrap transition-all duration-150 select-none disabled:cursor-not-allowed active:scale-[0.98]',
        VARIANTS[variant],
        SIZES[size],
        className
      )}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  )
}

export function IconButton({
  label,
  className,
  children,
  active,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      {...rest}
      title={label}
      aria-label={label}
      className={cx(
        'inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-xl transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        active ? 'bg-brand-600/10 text-brand-600 dark:text-brand-300' : 'text-2 hover:surface-3 hover:text-1',
        className
      )}
    >
      {children}
    </button>
  )
}

export function Card({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={cx('card', className)}>
      {children}
    </div>
  )
}

export function SectionTitle({ title, subtitle, right }: { title: string; subtitle?: string; right?: ReactNode }) {
  return (
    <div className="mb-3 flex items-end justify-between gap-4">
      <div>
        <h3 className="text-[15px] font-semibold text-1">{title}</h3>
        {subtitle && <p className="mt-0.5 text-[13px] text-3">{subtitle}</p>}
      </div>
      {right}
    </div>
  )
}

export function PageHeader({ title, subtitle, right, icon }: { title: string; subtitle?: string; right?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="mb-6 flex items-center justify-between gap-6">
      <div className="flex items-center gap-3.5">
        {icon && (
          <div className="flex size-11 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-500 to-violet-500 text-white shadow-lg shadow-brand-600/20">
            {icon}
          </div>
        )}
        <div>
          <h1 className="font-display text-[22px] leading-tight font-semibold tracking-tight text-1">{title}</h1>
          {subtitle && <p className="mt-0.5 text-sm text-2">{subtitle}</p>}
        </div>
      </div>
      {right && <div className="flex items-center gap-2">{right}</div>}
    </div>
  )
}

type Tone = 'neutral' | 'green' | 'amber' | 'red' | 'blue' | 'violet'
const TONES: Record<Tone, string> = {
  neutral: 'surface-3 text-2',
  green: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300',
  amber: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  red: 'bg-rose-500/12 text-rose-700 dark:text-rose-300',
  blue: 'bg-brand-500/12 text-brand-700 dark:text-brand-300',
  violet: 'bg-violet-500/12 text-violet-700 dark:text-violet-300'
}

export function Badge({ tone = 'neutral', children, icon, className }: { tone?: Tone; children: ReactNode; icon?: ReactNode; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-medium whitespace-nowrap', TONES[tone], className)}>
      {icon}
      {children}
    </span>
  )
}

export function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-brand-600' : 'bg-slate-300 dark:bg-slate-600'
      )}
    >
      <span
        className={cx(
          'inline-block size-5 rounded-full bg-white shadow transition-transform duration-200',
          checked ? 'translate-x-[22px]' : 'translate-x-0.5'
        )}
      />
    </button>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = 'md'
}: {
  value: T
  options: { value: T; label: string; icon?: ReactNode }[]
  onChange: (v: T) => void
  size?: 'sm' | 'md'
}) {
  return (
    <div className="inline-flex rounded-xl surface-3 p-1">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            'inline-flex cursor-pointer items-center gap-1.5 rounded-lg font-medium transition-all',
            size === 'sm' ? 'px-2.5 py-1 text-[12.5px]' : 'px-3.5 py-1.5 text-[13px]',
            value === o.value ? 'surface-1 text-1 shadow-sm' : 'text-2 hover:text-1'
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function ProgressBar({ value, tone = 'brand', indeterminate, className }: { value: number; tone?: 'brand' | 'green' | 'amber' | 'red'; indeterminate?: boolean; className?: string }) {
  const color = { brand: 'bg-brand-600', green: 'bg-emerald-500', amber: 'bg-amber-500', red: 'bg-rose-500' }[tone]
  return (
    <div className={cx('relative h-2 w-full overflow-hidden rounded-full surface-3', className)}>
      {indeterminate ? (
        <div className={cx('absolute inset-y-0 w-2/5 rounded-full animate-indeterminate', color)} />
      ) : (
        <div className={cx('h-full rounded-full transition-[width] duration-300 ease-out', color)} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      )}
    </div>
  )
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx('animate-spin', className ?? 'size-5 text-brand-600')} />
}

export function EmptyState({ icon, title, message, action }: { icon: ReactNode; title: string; message?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center animate-fade-in">
      <div className="mb-4 flex size-16 items-center justify-center rounded-3xl surface-3 text-3">{icon}</div>
      <h3 className="text-base font-semibold text-1">{title}</h3>
      {message && <p className="mt-1 max-w-sm text-sm text-2">{message}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 'max-w-md',
  dismissable = true,
  icon
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ReactNode
  width?: string
  dismissable?: boolean
  icon?: ReactNode
}) {
  useEffect(() => {
    if (!open || !dismissable) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, dismissable, onClose])
  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-slate-950/40 backdrop-blur-[2px] animate-fade-in" onClick={dismissable ? onClose : undefined} />
      <div role="dialog" aria-modal="true" className={cx('relative w-full card p-6 animate-pop', width)}>
        <div className="mb-4 flex items-start gap-3">
          {icon && <div className="mt-0.5 shrink-0">{icon}</div>}
          <h2 className="flex-1 text-lg font-semibold text-1">{title}</h2>
          {dismissable && (
            <IconButton label="Close" onClick={onClose} className="-mt-1 -mr-2">
              <X className="size-4" />
            </IconButton>
          )}
        </div>
        <div className="text-sm text-2">{children}</div>
        {footer && <div className="mt-6 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>,
    document.body
  )
}

export function TextInput({ className, ...rest }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...rest}
      className={cx(
        'h-10 w-full rounded-xl border border-soft surface-2 px-3 text-sm text-1 transition outline-none placeholder:text-3 focus:border-brand-500 focus:ring-4 focus:ring-brand-500/15',
        className
      )}
    />
  )
}

export function Stat({ label, value, sub, icon }: { label: string; value: ReactNode; sub?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-2xl surface-2 p-3.5">
      <div className="flex min-w-0 items-center gap-1.5 text-[12px] font-medium text-3" title={label}>
        <span className="shrink-0">{icon}</span>
        <span className="truncate">{label}</span>
      </div>
      <div
        className="mt-1 truncate text-[17px] font-semibold text-1 tabular-nums"
        title={typeof value === 'string' || typeof value === 'number' ? String(value) : undefined}
      >
        {value}
      </div>
      {sub && <div className="mt-0.5 text-[12px] text-3">{sub}</div>}
    </div>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return <span className="rounded-md border border-soft surface-2 px-1.5 py-0.5 font-mono text-[11px] text-2">{children}</span>
}
