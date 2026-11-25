import {
  AppWindow,
  ExternalLink,
  Lock,
  LockOpen,
  Power,
  PowerOff,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  Trash2
} from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppEntry, AppMeta, SafetyLevel } from '@shared/types'
import { Badge, Button, EmptyState, IconButton, Modal, PageHeader, ProgressBar, Segmented, Spinner, TextInput } from '../components/ui'
import { call, friendly, on } from '../lib/api'
import { cx } from '../lib/format'
import { useApp, useSelectedDevice } from '../store'

const SAFETY: Record<SafetyLevel, { label: string; tone: 'green' | 'amber' | 'red'; icon: React.ReactNode }> = {
  safe: { label: 'Safe to remove', tone: 'green', icon: <ShieldCheck className="size-3" /> },
  caution: { label: 'Use caution', tone: 'amber', icon: <ShieldQuestion className="size-3" /> },
  core: { label: 'Core system', tone: 'red', icon: <ShieldAlert className="size-3" /> }
}

type Scope = 'all' | 'mine' | 'system'
type RowAction = 'remove' | 'disable' | 'enable' | 'restore' | 'uninstall' | 'launch' | 'store'

/**
 * Phone models where Android refused per-user removal of system apps (Android 17+).
 * Remembered in local storage so "Remove" isn't offered again after a restart.
 */
const BLOCKED_KEY = 'easyadb.removeBlockedModels'
function loadBlocked(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(BLOCKED_KEY) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}
const removeBlockedDevices = loadBlocked()
function markBlocked(key: string): void {
  removeBlockedDevices.add(key)
  try {
    localStorage.setItem(BLOCKED_KEY, JSON.stringify([...removeBlockedDevices]))
  } catch {
    /* storage unavailable: remember for this session only */
  }
}
type Confirm = { action: 'remove' | 'uninstall' | 'disable'; apps: AppEntry[] } | null

const AVATAR_COLORS = ['from-sky-400 to-blue-600', 'from-emerald-400 to-green-600', 'from-amber-400 to-orange-600', 'from-pink-400 to-rose-600', 'from-violet-400 to-purple-600', 'from-teal-400 to-cyan-600']

function AppIcon({ app }: { app: AppEntry }) {
  if (app.icon) return <img src={app.icon} alt="" className="size-10 shrink-0 rounded-[12px] object-contain" draggable={false} />
  const hash = [...app.packageName].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)
  return (
    <div className={cx('flex size-10 shrink-0 items-center justify-center rounded-[12px] bg-gradient-to-br text-[15px] font-bold text-white', AVATAR_COLORS[hash % AVATAR_COLORS.length])}>
      {app.label.charAt(0).toUpperCase()}
    </div>
  )
}

export function AppsScreen() {
  const device = useSelectedDevice()
  const serial = device?.serial ?? ''
  const details = useApp((s) => s.details[serial])
  const toast = useApp((s) => s.toast)
  const toastError = useApp((s) => s.toastError)
  const [apps, setApps] = useState<AppEntry[]>([])
  const [meta, setMeta] = useState<Record<string, AppMeta>>({})
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'installed' | 'removed'>('installed')
  const [scope, setScope] = useState<Scope>('system')
  const [safety, setSafety] = useState<SafetyLevel | 'any'>('any')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [unlockCore, setUnlockCore] = useState(false)
  const [unlockPrompt, setUnlockPrompt] = useState(false)
  const [understood, setUnderstood] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null)
  const blockKey = `${device?.model ?? serial}|${details?.androidVersion ?? ''}`
  const [removeBlocked, setRemoveBlocked] = useState(() => removeBlockedDevices.has(blockKey))
  useEffect(() => setRemoveBlocked(removeBlockedDevices.has(blockKey)), [blockKey])
  const pending = useRef(new Set<string>())
  const requested = useRef(new Set<string>())
  const attempts = useRef(new Map<string, number>())
  const inFlight = useRef(false)
  const listRef = useRef<HTMLDivElement>(null)
  const [listTop, setListTop] = useState(0)
  const [listH, setListH] = useState(700)

  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setListH(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(
    async (quiet = false) => {
      if (!serial) return
      if (!quiet) setLoading(true)
      try {
        setApps(await call('apps:list', serial))
      } catch (e) {
        toastError(friendly(e))
      } finally {
        setLoading(false)
      }
    },
    [serial, toastError]
  )

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => on('apps:changed', (p) => p.serial === serial && void load(true)), [serial, load])

  // Lazy name/icon resolution for rows scrolled into view.
  const flush = useCallback(() => {
    flushTimer.current = null
    // One batch at a time: piling up requests overloads the phone link and they time out.
    if (inFlight.current) return
    // Newest requests first, so the rows on screen fill in before ones scrolled past.
    const batch = [...pending.current].slice(-12).reverse()
    batch.forEach((p) => pending.current.delete(p))
    if (!batch.length) return
    inFlight.current = true
    // Temporary failures (phone briefly offline) are retried a few times, a little later.
    const retryLater = (pkgs: string[]): void => {
      const again = pkgs.filter((p) => (attempts.current.set(p, (attempts.current.get(p) ?? 0) + 1), attempts.current.get(p)! <= 3))
      if (!again.length) return
      setTimeout(() => {
        again.forEach((p) => pending.current.add(p))
        if (!flushTimer.current) flushTimer.current = setTimeout(flush, 50)
      }, 4000)
    }
    void call('apps:meta', serial, batch)
      .then((res) => {
        setMeta((m) => ({ ...m, ...Object.fromEntries(res.filter((r) => !r.retry).map((r) => [r.packageName, r])) }))
        retryLater(res.filter((r) => r.retry).map((r) => r.packageName))
      })
      .catch(() => retryLater(batch))
      .finally(() => {
        inFlight.current = false
        if (pending.current.size) flushTimer.current = setTimeout(flush, 50)
      })
  }, [serial])

  const requestMeta = useCallback(
    (pkg: string) => {
      if (requested.current.has(pkg)) return
      requested.current.add(pkg)
      pending.current.add(pkg)
      if (!flushTimer.current) flushTimer.current = setTimeout(flush, 200)
    },
    [flush]
  )

  const merged = useMemo(
    () =>
      apps.map((a) => {
        const m = meta[a.packageName]
        return m ? { ...a, label: m.label || a.label, icon: m.icon || a.icon, labelResolved: a.labelResolved || !!m.label } : a
      }),
    [apps, meta]
  )

  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 })
    setListTop(0)
  }, [tab, scope, safety, query])

  const installed = merged.filter((a) => !a.removed)
  const removed = merged.filter((a) => a.removed)

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const base = tab === 'removed' ? removed : installed
    return base
      .filter((a) => (tab === 'removed' ? true : scope === 'all' ? true : scope === 'mine' ? !a.isSystem : a.isSystem))
      .filter((a) => (safety === 'any' ? true : a.safety === safety))
      .filter((a) => !q || a.label.toLowerCase().includes(q) || a.packageName.toLowerCase().includes(q))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }))
  }, [installed, removed, tab, scope, safety, query])

  const setRowBusy = (pkg: string, on: boolean): void =>
    setBusy((s) => {
      const n = new Set(s)
      if (on) n.add(pkg)
      else n.delete(pkg)
      return n
    })

  /** Runs an action; returns 'ok', 'blocked' (Android refused per-user removal) or 'error'. */
  const act = async (app: AppEntry, action: RowAction, quiet = false): Promise<'ok' | 'blocked' | 'error'> => {
    setRowBusy(app.packageName, true)
    try {
      if (action === 'remove') await call('apps:remove', serial, app.packageName, unlockCore)
      else if (action === 'disable') await call('apps:disable', serial, app.packageName, unlockCore)
      else if (action === 'enable') await call('apps:enable', serial, app.packageName)
      else if (action === 'restore') await call('apps:restore', serial, app.packageName)
      else if (action === 'uninstall') await call('apps:uninstall', serial, app.packageName)
      else if (action === 'store') {
        await call('apps:openStore', serial, app.packageName)
        toast({ kind: 'info', title: 'Store opened on your phone', message: `Tap “Install” to bring back ${app.label} — its data was kept.` })
      } else await call('apps:launch', serial, app.packageName)
      return 'ok'
    } catch (e) {
      const f = friendly(e)
      if (f.code === 'REMOVE_BLOCKED') {
        markBlocked(blockKey)
        setRemoveBlocked(true)
        if (!quiet) {
          toast({
            kind: 'info',
            title: f.title,
            message: f.message,
            action: { label: 'Turn it off instead', run: () => void act(app, 'disable').then((r) => r === 'ok' && toast({ kind: 'success', title: `Turned off ${app.label}` })) }
          })
        }
        return 'blocked'
      }
      if (f.code === 'NEEDS_REINSTALL') {
        toast({ kind: 'error', title: f.title, message: `${f.message} ${f.hint ?? ''}`, action: { label: 'Open store on phone', run: () => void act(app, 'store') } })
      } else if (!quiet) toastError(f)
      return 'error'
    } finally {
      setRowBusy(app.packageName, false)
    }
  }

  const runConfirm = async (): Promise<void> => {
    if (!confirm) return
    const { apps: targets } = confirm
    // On phones that block removal, bulk "remove" turns apps off instead.
    let action = confirm.action === 'remove' && removeBlocked ? 'disable' : confirm.action
    setConfirm(null)
    if (targets.length === 1) {
      const res = await act(targets[0], action)
      if (res === 'ok') {
        const verb = action === 'disable' ? 'Turned off' : action === 'uninstall' ? 'Uninstalled' : 'Removed'
        toast({
          kind: 'success',
          title: `${verb} ${targets[0].label}`,
          message: action === 'remove' ? 'You can restore it anytime from “Removed apps”.' : action === 'disable' ? 'Turn it back on anytime.' : undefined,
          action: action === 'remove' ? { label: 'Undo', run: () => void act(targets[0], 'restore') } : action === 'disable' ? { label: 'Undo', run: () => void act(targets[0], 'enable') } : undefined
        })
      }
      return
    }
    setBulk({ done: 0, total: targets.length })
    let ok = 0
    for (const app of targets) {
      let res = await act(app, action, true)
      if (res === 'blocked') {
        action = 'disable'
        res = await act(app, 'disable', true)
      }
      if (res === 'ok') ok++
      setBulk((b) => (b ? { ...b, done: b.done + 1 } : b))
    }
    setBulk(null)
    setPicked(new Set())
    toast(
      action === 'disable'
        ? { kind: 'success', title: `Turned off ${ok} of ${targets.length} apps`, message: 'Turn any of them back on from the list.' }
        : { kind: 'success', title: `Removed ${ok} of ${targets.length} apps`, message: 'Restore any of them from “Removed apps”.' }
    )
  }

  const pickedApps = visible.filter((a) => picked.has(a.packageName))
  // Only rows near the viewport are rendered (the list can hold 800+ apps with icons).
  const firstRow = Math.max(0, Math.floor(listTop / APP_ROW_H) - 6)
  const lastRow = Math.min(visible.length, Math.ceil((listTop + listH) / APP_ROW_H) + 6)

  return (
    <div className="mx-auto flex h-full max-w-6xl flex-col animate-fade-in">
      <PageHeader
        title="Apps & Debloat"
        subtitle="Remove or turn off pre-installed bloatware safely. Everything can be undone."
        icon={<AppWindow className="size-5" />}
        right={
          <IconButton label="Refresh" onClick={() => void load()}>
            <RefreshCw className={cx('size-4', loading && 'animate-spin')} />
          </IconButton>
        }
      />

      <div className="@container/bar mb-4 flex flex-wrap items-center gap-3">
        <Segmented
          value={tab}
          onChange={(v) => {
            setTab(v)
            setPicked(new Set())
          }}
          options={[
            { value: 'installed', label: `Installed (${installed.length})` },
            { value: 'removed', label: `Removed apps (${removed.length})` }
          ]}
        />
        {tab === 'installed' && (
          <Segmented
            size="sm"
            value={scope}
            onChange={setScope}
            options={[
              { value: 'system', label: 'Pre-installed' },
              { value: 'mine', label: 'My apps' },
              { value: 'all', label: 'All' }
            ]}
          />
        )}
        <select
          value={safety}
          onChange={(e) => setSafety(e.target.value as SafetyLevel | 'any')}
          className="h-9 cursor-pointer rounded-xl border border-soft surface-1 px-3 text-[13px] text-1 outline-none"
        >
          <option value="any">Any safety level</option>
          <option value="safe">Safe to remove</option>
          <option value="caution">Use caution</option>
          <option value="core">Core system</option>
        </select>
        <div className="relative w-full @4xl/bar:ml-auto @4xl/bar:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-3" />
          <TextInput className="pl-9" placeholder="Search apps" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      </div>

      {tab === 'installed' && (
        <div className="mb-3 flex items-center gap-3 rounded-2xl surface-2 px-4 py-2.5 text-[12.5px] text-2">
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-emerald-500" /> Safe to remove
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-amber-500" /> Use caution — may turn off a feature
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-rose-500" /> Core system — locked
          </span>
          <button
            className={cx(
              'ml-auto flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1 font-medium',
              unlockCore ? 'bg-rose-500/12 text-rose-600 dark:text-rose-300' : 'text-3 hover:text-1'
            )}
            onClick={() => (unlockCore ? setUnlockCore(false) : setUnlockPrompt(true))}
          >
            {unlockCore ? <LockOpen className="size-3.5" /> : <Lock className="size-3.5" />}
            {unlockCore ? 'Core apps unlocked' : 'Core apps locked'}
          </button>
        </div>
      )}

      {tab === 'installed' && removeBlocked && (
        <div className="mb-3 rounded-2xl border border-brand-400/30 bg-brand-500/8 px-4 py-3 text-[13px] text-2 animate-slide-up">
          <b className="text-1">This phone only allows turning pre-installed apps off.</b> Newer Android versions block removing them from a
          computer. Turned-off apps stop running, stop updating and disappear from your app drawer — and you can turn them back on anytime.
        </div>
      )}

      {pickedApps.length > 0 && (
        <div className="mb-3 flex items-center gap-3 rounded-2xl border border-brand-400/40 bg-brand-500/8 px-4 py-2.5 animate-slide-up">
          <span className="text-[13px] font-medium text-1">{pickedApps.length} selected</span>
          {bulk ? (
            <ProgressBar className="w-48" value={(bulk.done / bulk.total) * 100} />
          ) : (
            <>
              <Button
                size="sm"
                variant="danger"
                icon={removeBlocked ? <PowerOff className="size-3.5" /> : <Trash2 className="size-3.5" />}
                onClick={() => setConfirm({ action: removeBlocked ? 'disable' : 'remove', apps: pickedApps })}
              >
                {removeBlocked ? 'Turn off selected' : 'Remove selected'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>
                Clear
              </Button>
            </>
          )}
        </div>
      )}

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto card" onScroll={(e) => setListTop(e.currentTarget.scrollTop)}>
        {loading && apps.length === 0 ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-14 rounded-xl skeleton" />
            ))}
          </div>
        ) : visible.length === 0 ? (
          tab === 'removed' ? (
            <EmptyState icon={<RotateCcw className="size-7" />} title="No removed apps" message="Apps you remove will appear here so you can restore them with one click." />
          ) : (
            <EmptyState icon={<Search className="size-7" />} title="No apps match" message="Try a different filter or search." />
          )
        ) : (
          <div style={{ height: visible.length * APP_ROW_H, position: 'relative' }}>
            {visible.slice(firstRow, lastRow).map((app, i) => (
              <AppRow
                key={app.packageName}
                style={{ position: 'absolute', top: (firstRow + i) * APP_ROW_H, left: 0, right: 0, height: APP_ROW_H }}
                app={app}
                busy={busy.has(app.packageName)}
                unlockCore={unlockCore}
                removeBlocked={removeBlocked}
                picked={picked.has(app.packageName)}
                canPick={tab === 'installed' && app.isSystem && (app.safety !== 'core' || unlockCore)}
                onPick={(v) =>
                  setPicked((s) => {
                    const n = new Set(s)
                    if (v) n.add(app.packageName)
                    else n.delete(app.packageName)
                    return n
                  })
                }
                onVisible={requestMeta}
                onAction={(action) => {
                  if (action === 'remove' || action === 'uninstall' || action === 'disable') setConfirm({ action, apps: [app] })
                  else
                    void act(app, action).then((res) => {
                      if (res === 'ok' && action === 'restore') toast({ kind: 'success', title: `Restored ${app.label}` })
                      if (res === 'ok' && action === 'enable') toast({ kind: 'success', title: `Turned on ${app.label}` })
                    })
                }}
              />
            ))}
          </div>
        )}
      </div>

      <Modal
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={
          confirm
            ? confirm.apps.length > 1
              ? `${confirm.action === 'disable' ? 'Turn off' : 'Remove'} ${confirm.apps.length} apps?`
              : `${confirm.action === 'disable' ? 'Turn off' : confirm.action === 'uninstall' ? 'Uninstall' : 'Remove'} ${confirm.apps[0].label}?`
            : ''
        }
        icon={confirm?.action === 'uninstall' ? <Trash2 className="size-5 text-rose-500" /> : <ShieldCheck className="size-5 text-emerald-500" />}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button variant={confirm?.action === 'disable' ? 'primary' : 'danger'} onClick={() => void runConfirm()}>
              {confirm?.action === 'disable' ? 'Turn off' : confirm?.action === 'uninstall' ? 'Uninstall' : 'Remove'}
            </Button>
          </>
        }
      >
        {confirm?.action === 'uninstall' && <p>This deletes the app and its data from your phone. You can reinstall it later from the Play Store.</p>}
        {confirm?.action === 'remove' && (
          <p>
            {confirm.apps.length > 1 ? 'These apps' : 'This app'} will be removed for your user. The original stays safely inside Android, so you can
            bring {confirm.apps.length > 1 ? 'them' : 'it'} back anytime from <b className="text-1">Removed apps</b>.
          </p>
        )}
        {confirm?.action === 'disable' && <p>The app stays installed but is hidden and can’t run. Turn it back on anytime.</p>}
        {confirm?.apps.some((a) => a.safety !== 'safe') && (
          <div className="mt-3 rounded-xl bg-amber-500/10 p-3 text-[13px] text-amber-800 dark:text-amber-200">
            {confirm.apps
              .filter((a) => a.safety !== 'safe')
              .slice(0, 4)
              .map((a) => (
                <div key={a.packageName}>
                  <b>{a.label}</b>: {a.description ?? 'May affect a phone feature.'}
                </div>
              ))}
          </div>
        )}
      </Modal>

      <Modal
        open={unlockPrompt}
        onClose={() => {
          setUnlockPrompt(false)
          setUnderstood(false)
        }}
        title="Unlock core system apps?"
        icon={<ShieldAlert className="size-5 text-rose-500" />}
        footer={
          <>
            <Button variant="ghost" onClick={() => setUnlockPrompt(false)}>
              Keep locked
            </Button>
            <Button
              variant="danger"
              disabled={!understood}
              onClick={() => {
                setUnlockCore(true)
                setUnlockPrompt(false)
                setUnderstood(false)
              }}
            >
              Unlock for this session
            </Button>
          </>
        }
      >
        <p>Core system apps are part of Android itself. Removing the wrong one can make your phone restart in a loop or lose calls, Wi-Fi or the home screen.</p>
        <label className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-xl surface-2 p-3">
          <input type="checkbox" className="mt-0.5 size-4 accent-rose-600" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
          <span className="text-[13px] text-1">I understand the risk and know how to factory-reset my phone if needed.</span>
        </label>
      </Modal>
    </div>
  )
}

const APP_ROW_H = 66

const AppRow = memo(function AppRow({
  style,
  app,
  busy,
  unlockCore,
  removeBlocked,
  picked,
  canPick,
  onPick,
  onVisible,
  onAction
}: {
  style?: React.CSSProperties
  app: AppEntry
  busy: boolean
  unlockCore: boolean
  removeBlocked: boolean
  picked: boolean
  canPick: boolean
  onPick: (v: boolean) => void
  onVisible: (pkg: string) => void
  onAction: (a: RowAction) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (app.icon && app.labelResolved) return
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          onVisible(app.packageName)
          io.disconnect()
        }
      },
      { rootMargin: '200px' }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [app.packageName, app.icon, app.labelResolved, onVisible])

  const s = SAFETY[app.safety]
  const locked = app.safety === 'core' && !unlockCore
  return (
    <div
      ref={ref}
      style={style}
      data-app-row={app.packageName}
      className={cx('flex items-center gap-3.5 border-b border-soft px-4 transition-colors', picked ? 'bg-brand-500/8' : 'hover:surface-2')}
    >
      <input
        type="checkbox"
        className={cx('size-4 accent-brand-600', canPick ? 'cursor-pointer' : 'invisible')}
        checked={picked}
        onChange={(e) => onPick(e.target.checked)}
        aria-label={`Select ${app.label}`}
      />
      <AppIcon app={app} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[14px] font-semibold text-1" dir="auto">
            {app.label}
          </span>
          {app.isSystem && (
            <Badge tone={s.tone} icon={s.icon}>
              {removeBlocked && app.safety === 'safe' ? 'Safe to turn off' : s.label}
            </Badge>
          )}
          {!app.isSystem && !app.removed && (
            <Badge tone="blue" className="cursor-help">
              <span title="A regular app (installed from a store or by your phone’s seller). Uninstalling removes it completely.">Regular app</span>
            </Badge>
          )}
          {!app.enabled && !app.removed && <Badge tone="neutral" icon={<PowerOff className="size-3" />}>Turned off</Badge>}
          {app.removed && app.restorable === false && <Badge tone="amber">Needs reinstall</Badge>}
        </div>
        <div className="mt-0.5 truncate text-[12px] text-3">
          {app.removed && app.restorable === false
            ? 'Its data was kept — reinstall it from the store to bring it back. · '
            : app.description
              ? `${app.description} · `
              : ''}
          <span className="selectable font-mono">{app.packageName}</span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {busy ? (
          <Spinner className="mx-6 size-5 text-brand-600" />
        ) : app.removed ? (
          app.restorable === false ? (
            <Button size="sm" variant="outline" icon={<ExternalLink className="size-3.5" />} onClick={() => onAction('store')}>
              Reinstall from store
            </Button>
          ) : (
            <Button size="sm" variant="success" icon={<RotateCcw className="size-3.5" />} onClick={() => onAction('restore')}>
              Restore
            </Button>
          )
        ) : !app.isSystem ? (
          <>
            {app.enabled && (
              <IconButton label="Open on phone" onClick={() => onAction('launch')}>
                <ExternalLink className="size-4" />
              </IconButton>
            )}
            <Button size="sm" variant="outline" icon={<Trash2 className="size-3.5" />} onClick={() => onAction('uninstall')}>
              Uninstall
            </Button>
          </>
        ) : locked ? (
          <span className="flex items-center gap-1.5 px-2 text-[12px] font-medium text-3" title="Core system apps are locked to protect your phone">
            <Lock className="size-3.5" /> Locked
          </span>
        ) : (
          <>
            {app.enabled ? (
              <Button size="sm" variant="ghost" icon={<PowerOff className="size-3.5" />} onClick={() => onAction('disable')}>
                Turn off
              </Button>
            ) : (
              <Button size="sm" variant="ghost" icon={<Power className="size-3.5" />} onClick={() => onAction('enable')}>
                Turn on
              </Button>
            )}
            {!removeBlocked && (
              <Button size="sm" variant={app.safety === 'safe' ? 'danger' : 'outline'} icon={<Trash2 className="size-3.5" />} onClick={() => onAction('remove')}>
                Remove
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  )
})
