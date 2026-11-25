import { AlertTriangle, CheckCircle2, FileUp, Info, Package, PackagePlus, Play, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { FriendlyError, InstallAnalysis, InstallProgress } from '@shared/types'
import { Badge, Button, Card, IconButton, PageHeader, ProgressBar } from '../components/ui'
import { call, friendly, on, pathForFile } from '../lib/api'
import { cx, formatBytes } from '../lib/format'
import { useApp, useSelectedDevice } from '../store'

interface Item {
  key: string
  file: string
  analysis?: InstallAnalysis
  analyzeError?: FriendlyError
  jobId?: string
  progress?: InstallProgress
}

const KIND_INFO: Record<InstallAnalysis['kind'], string> = {
  apk: 'Single app file',
  xapk: 'XAPK bundle',
  apks: 'Split APK bundle',
  apkm: 'APKMirror bundle'
}

export function InstallScreen() {
  const device = useSelectedDevice()
  const serial = device?.serial ?? ''
  const toast = useApp((s) => s.toast)
  const [items, setItems] = useState<Item[]>([])
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    return on('install:progress', (p) => {
      setItems((list) => list.map((it) => (it.jobId === p.id ? { ...it, progress: p } : it)))
      if (p.stage === 'done') toast({ kind: 'success', title: 'App installed', message: p.fileName })
    })
  }, [toast])

  const add = useCallback(async (files: string[]) => {
    const fresh = files.filter(Boolean).map((file) => ({ key: `${file}-${Date.now()}-${Math.random()}`, file }))
    setItems((list) => [...list, ...fresh])
    for (const it of fresh) {
      try {
        const analysis = await call('install:analyze', it.file)
        setItems((list) => list.map((x) => (x.key === it.key ? { ...x, analysis } : x)))
      } catch (e) {
        setItems((list) => list.map((x) => (x.key === it.key ? { ...x, analyzeError: friendly(e) } : x)))
      }
    }
  }, [])

  const install = async (it: Item): Promise<void> => {
    try {
      const jobId = await call('install:run', serial, it.file)
      setItems((list) =>
        list.map((x) => (x.key === it.key ? { ...x, jobId, progress: { id: jobId, fileName: it.analysis?.fileName ?? '', stage: 'preparing', percent: 2, message: 'Getting ready…' } } : x))
      )
    } catch (e) {
      setItems((list) => list.map((x) => (x.key === it.key ? { ...x, analyzeError: friendly(e) } : x)))
    }
  }

  const ready = items.filter((i) => i.analysis && !i.jobId)

  return (
    <div
      className="mx-auto max-w-4xl animate-fade-in"
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        void add(Array.from(e.dataTransfer.files).map(pathForFile))
      }}
    >
      <PageHeader
        title="Install Apps"
        subtitle="Install apps from files on your computer — including split bundles that phones can’t open on their own."
        icon={<PackagePlus className="size-5" />}
        right={
          ready.length > 1 && (
            <Button icon={<Play className="size-4" />} onClick={() => ready.forEach((it) => void install(it))}>
              Install all ({ready.length})
            </Button>
          )
        }
      />

      <button
        onClick={async () => add(await call('install:pick'))}
        className={cx(
          'group flex w-full cursor-pointer flex-col items-center justify-center rounded-3xl border-2 border-dashed px-8 py-12 text-center transition-all',
          dragging ? 'scale-[1.01] border-brand-500 bg-brand-500/10' : 'border-soft surface-1 hover:border-brand-400 hover:bg-brand-500/5'
        )}
      >
        <div className="flex size-16 items-center justify-center rounded-3xl bg-gradient-to-br from-brand-500 to-violet-500 text-white shadow-lg shadow-brand-600/25 transition-transform group-hover:scale-105">
          <FileUp className="size-7" />
        </div>
        <div className="mt-4 text-lg font-semibold text-1">{dragging ? 'Drop to add' : 'Drop app files here'}</div>
        <div className="mt-1 text-sm text-2">or click to choose files</div>
        <div className="mt-4 flex gap-2">
          {['.apk', '.xapk', '.apks', '.apkm'].map((x) => (
            <Badge key={x} tone="neutral" className="font-mono">
              {x}
            </Badge>
          ))}
        </div>
      </button>

      {items.length > 0 && (
        <div className="mt-6 space-y-3">
          {items.map((it) => (
            <InstallCard
              key={it.key}
              item={it}
              onInstall={() => void install(it)}
              onRemove={() => setItems((l) => l.filter((x) => x.key !== it.key))}
            />
          ))}
        </div>
      )}

      <Card className="mt-6 flex gap-3 p-4 text-[13px] text-2">
        <Info className="mt-0.5 size-4 shrink-0 text-brand-500" />
        <div>
          Only install apps from sources you trust. Xiaomi, OPPO and vivo phones may ask you to confirm each install on the phone screen — keep it
          unlocked. Split bundles are unpacked automatically, and only the parts that match your phone are installed.
        </div>
      </Card>
    </div>
  )
}

function InstallCard({ item, onInstall, onRemove }: { item: Item; onInstall: () => void; onRemove: () => void }) {
  const a = item.analysis
  const p = item.progress
  const running = p && p.stage !== 'done' && p.stage !== 'error'
  const err = item.analyzeError ?? p?.error
  return (
    <Card className="p-4 animate-slide-up">
      <div className="flex items-center gap-4">
        <div
          className={cx(
            'flex size-12 shrink-0 items-center justify-center rounded-2xl',
            p?.stage === 'done' ? 'bg-emerald-500/12 text-emerald-600' : err ? 'bg-rose-500/12 text-rose-500' : 'bg-android-500/15 text-android-600'
          )}
        >
          {p?.stage === 'done' ? <CheckCircle2 className="size-6" /> : err ? <AlertTriangle className="size-6" /> : <Package className="size-6" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold text-1">
            {a?.appName ?? a?.fileName ?? item.file.split(/[\\/]/).pop()}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12.5px] text-3">
            {a ? (
              <>
                <span>{KIND_INFO[a.kind]}</span>
                <span>·</span>
                <span>{formatBytes(a.totalBytes)}</span>
                {a.apkCount > 1 && (
                  <>
                    <span>·</span>
                    <span>{a.apkCount} parts</span>
                  </>
                )}
                {a.obbCount > 0 && (
                  <>
                    <span>·</span>
                    <span>includes game data</span>
                  </>
                )}
                {a.versionName && (
                  <>
                    <span>·</span>
                    <span>v{a.versionName}</span>
                  </>
                )}
                {a.packageName && <span className="font-mono">· {a.packageName}</span>}
              </>
            ) : err ? null : (
              <span>Reading file…</span>
            )}
          </div>
        </div>
        {!p && a && (
          <Button icon={<Play className="size-4" />} onClick={onInstall}>
            Install
          </Button>
        )}
        {!running && (
          <IconButton label="Remove from list" onClick={onRemove}>
            {p?.stage === 'done' ? <X className="size-4" /> : <Trash2 className="size-4" />}
          </IconButton>
        )}
      </div>
      {running && p && (
        <div className="mt-3">
          <div className="mb-1.5 flex justify-between text-[12.5px] text-2">
            <span>{p.message}</span>
            {p.stage !== 'installing' && <span className="tabular-nums">{p.percent}%</span>}
          </div>
          <ProgressBar value={p.percent} indeterminate={p.stage === 'installing'} />
        </div>
      )}
      {err && (
        <div className="mt-3 rounded-xl bg-rose-500/8 p-3.5">
          <div className="text-[13.5px] font-semibold text-rose-700 dark:text-rose-300">{err.title}</div>
          <div className="mt-0.5 text-[13px] text-2">{err.message}</div>
          {err.hint && <div className="mt-1.5 text-[13px] text-1">💡 {err.hint}</div>}
          {p?.stage === 'error' && (
            <Button className="mt-3" size="sm" variant="secondary" onClick={onInstall}>
              Try again
            </Button>
          )}
        </div>
      )}
    </Card>
  )
}
