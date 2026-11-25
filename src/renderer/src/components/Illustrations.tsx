import { Check, Wifi } from 'lucide-react'
import type { ReactNode } from 'react'
import { cx } from '../lib/format'

export function PhoneFrame({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cx(
        'relative h-[300px] w-[150px] rounded-[28px] border-[6px] border-slate-800 bg-slate-800 shadow-2xl shadow-slate-900/30 dark:border-slate-700 dark:bg-slate-700',
        className
      )}
    >
      <div className="absolute top-2 left-1/2 z-10 h-1.5 w-12 -translate-x-1/2 rounded-full bg-slate-900/80" />
      <div className="relative h-full w-full overflow-hidden rounded-[22px] bg-gradient-to-b from-sky-100 to-indigo-100 dark:from-slate-800 dark:to-indigo-950">
        {children}
      </div>
    </div>
  )
}

/** The "Allow USB debugging?" prompt, drawn the way phones show it. */
export function AllowDebuggingIllustration() {
  return (
    <PhoneFrame>
      <div className="absolute inset-0 bg-slate-900/45" />
      <div className="absolute inset-x-2.5 top-1/2 -translate-y-1/2 rounded-2xl bg-white p-3 text-left shadow-xl animate-pop dark:bg-slate-900">
        <div className="text-[10.5px] leading-tight font-semibold text-slate-900 dark:text-slate-100">Allow USB debugging?</div>
        <div className="mt-1.5 text-[8px] leading-snug text-slate-500 dark:text-slate-400">
          The computer's RSA key fingerprint is: 3F:A2:…:9C
        </div>
        <div className="mt-2 flex items-center gap-1.5">
          <span className="flex size-3 items-center justify-center rounded-[3px] bg-brand-600 text-white">
            <Check className="size-2.5" strokeWidth={4} />
          </span>
          <span className="text-[8px] font-medium text-slate-700 dark:text-slate-200">Always allow from this computer</span>
        </div>
        <div className="mt-3 flex justify-end gap-3 text-[9px] font-semibold">
          <span className="text-slate-400">Cancel</span>
          <span className="relative text-brand-600">
            <span className="absolute -inset-2 rounded-full bg-brand-500/30 animate-pulse-ring" />
            <span className="relative">Allow</span>
          </span>
        </div>
      </div>
    </PhoneFrame>
  )
}

export function UsbIllustration() {
  return (
    <svg viewBox="0 0 220 140" className="h-full w-full" aria-hidden>
      <defs>
        <linearGradient id="lap" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#6189ff" />
          <stop offset="1" stopColor="#8b5cf6" />
        </linearGradient>
      </defs>
      <rect x="10" y="22" width="110" height="70" rx="8" fill="url(#lap)" opacity="0.9" />
      <rect x="17" y="29" width="96" height="56" rx="4" fill="white" opacity="0.92" />
      <rect x="0" y="92" width="130" height="8" rx="4" fill="#94a3b8" />
      <path d="M128 96 C 150 96, 150 70, 168 70" stroke="#64748b" strokeWidth="4" fill="none" strokeLinecap="round" />
      <rect x="166" y="20" width="44" height="88" rx="9" fill="#1e293b" />
      <rect x="170" y="26" width="36" height="76" rx="5" fill="#3ddc84" opacity="0.85" />
      <circle cx="188" cy="64" r="9" fill="white" opacity="0.9" />
      <path d="M184 64 l3 3 l6 -6" stroke="#16a34a" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function WifiIllustration() {
  return (
    <div className="relative flex h-full w-full items-center justify-center">
      <div className="absolute size-24 rounded-full bg-brand-500/20 animate-pulse-ring" />
      <div className="absolute size-24 rounded-full bg-brand-500/20 animate-pulse-ring [animation-delay:0.7s]" />
      <div className="relative flex size-20 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-violet-500 text-white shadow-xl shadow-brand-600/30">
        <Wifi className="size-9" />
      </div>
    </div>
  )
}

export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden>
      <defs>
        <linearGradient id="logo-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3ddc84" />
          <stop offset="0.55" stopColor="#3d63fb" />
          <stop offset="1" stopColor="#8b5cf6" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="16" fill="url(#logo-g)" />
      <rect x="20" y="11" width="24" height="42" rx="6" fill="none" stroke="white" strokeWidth="4" />
      <path d="M27 32 l4 4 l8 -9" fill="none" stroke="white" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="32" cy="47" r="2" fill="white" />
    </svg>
  )
}
