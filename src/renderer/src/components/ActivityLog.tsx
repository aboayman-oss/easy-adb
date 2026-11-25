import { ChevronDown, ScrollText, Trash2 } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { call } from '../lib/api'
import { cx } from '../lib/format'
import { useApp } from '../store'
import { IconButton } from './ui'

const DOT: Record<string, string> = {
  info: 'bg-slate-400',
  success: 'bg-emerald-500',
  warn: 'bg-amber-500',
  error: 'bg-rose-500'
}

export function ActivityLog() {
  const open = useApp((s) => s.logOpen)
  const log = useApp((s) => s.log)
  const toggle = useApp((s) => s.toggleLog)
  const setLog = useApp((s) => s.setLog)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ block: 'end' })
  }, [log.length, open])

  return (
    <div
      className={cx(
        'shrink-0 border-t border-soft surface-1 transition-[height] duration-300 ease-out',
        open ? 'h-56' : 'h-0 overflow-hidden border-t-0'
      )}
    >
      <div className="flex h-10 items-center justify-between border-b border-soft px-4">
        <div className="flex items-center gap-2 text-[13px] font-semibold text-1">
          <ScrollText className="size-4 text-3" />
          Activity Log
          <span className="font-normal text-3">— every action Easy ADB performs, for transparency</span>
        </div>
        <div className="flex items-center gap-1">
          <IconButton
            label="Clear log"
            onClick={() => {
              void call('log:clear')
              setLog([])
            }}
          >
            <Trash2 className="size-4" />
          </IconButton>
          <IconButton label="Hide log" onClick={() => toggle(false)}>
            <ChevronDown className="size-4" />
          </IconButton>
        </div>
      </div>
      <div className="selectable h-[calc(100%-2.5rem)] overflow-y-auto px-4 py-2 font-mono text-[12px] leading-relaxed">
        {log.length === 0 && <div className="py-6 text-center text-3">Nothing yet.</div>}
        {log.map((e) => (
          <div key={e.id} className="flex gap-3 py-0.5">
            <span className="shrink-0 text-3">{new Date(e.time).toLocaleTimeString()}</span>
            <span className={cx('mt-[7px] size-1.5 shrink-0 rounded-full', DOT[e.level])} />
            <span className="min-w-0 flex-1">
              <span className={cx(e.level === 'error' ? 'text-rose-600 dark:text-rose-400' : 'text-1')}>{e.message}</span>
              {e.command && <span className="ml-2 break-all text-3">{e.command}</span>}
              {e.durationMs !== undefined && <span className="ml-2 text-3">({e.durationMs} ms)</span>}
            </span>
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  )
}
