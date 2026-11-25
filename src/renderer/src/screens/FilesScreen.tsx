import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowUpFromLine,
  Camera,
  ChevronRight,
  Download,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  FolderDown,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Image as ImageIcon,
  MessageCircle,
  Music,
  Package,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  Video,
  X
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { RemoteEntry, TransferJob } from '@shared/types'
import { Button, EmptyState, IconButton, Modal, ProgressBar, Spinner, TextInput } from '../components/ui'
import { call, friendly, on, pathForFile } from '../lib/api'
import { cx, fileKind, formatBytes, formatDate, formatEta, formatSpeed } from '../lib/format'
import { useApp, useSelectedDevice } from '../store'

const ROOT = '/sdcard'
const ROW_H = 42

const SHORTCUTS: { label: string; icon: ReactNode; paths: string[] }[] = [
  { label: 'Camera & Photos', icon: <Camera className="size-4" />, paths: ['/sdcard/DCIM/Camera', '/sdcard/DCIM'] },
  { label: 'Screenshots', icon: <ImageIcon className="size-4" />, paths: ['/sdcard/DCIM/Screenshots', '/sdcard/Pictures/Screenshots', '/sdcard/Pictures'] },
  { label: 'Downloads', icon: <Download className="size-4" />, paths: ['/sdcard/Download'] },
  { label: 'Documents', icon: <FileText className="size-4" />, paths: ['/sdcard/Documents'] },
  {
    label: 'WhatsApp Media',
    icon: <MessageCircle className="size-4" />,
    paths: ['/sdcard/Android/media/com.whatsapp/WhatsApp/Media', '/sdcard/WhatsApp/Media']
  },
  { label: 'Music', icon: <Music className="size-4" />, paths: ['/sdcard/Music'] },
  { label: 'Videos', icon: <Video className="size-4" />, paths: ['/sdcard/Movies', '/sdcard/DCIM/Video'] },
  { label: 'Internal storage', icon: <HardDrive className="size-4" />, paths: [ROOT] }
]

function joinPath(dir: string, name: string): string {
  return (dir === '/' ? '' : dir) + '/' + name
}

function parentOf(path: string): string {
  if (path === ROOT) return ROOT
  const idx = path.lastIndexOf('/')
  return idx <= 0 ? '/' : path.slice(0, idx)
}

function crumbs(path: string): { name: string; path: string }[] {
  if (!path.startsWith(ROOT)) {
    const out = [{ name: '/', path: '/' }]
    let acc = ''
    for (const seg of path.split('/').filter(Boolean)) {
      acc += '/' + seg
      out.push({ name: seg, path: acc })
    }
    return out
  }
  const out = [{ name: 'Internal storage', path: ROOT }]
  let acc = ROOT
  for (const seg of path.slice(ROOT.length).split('/').filter(Boolean)) {
    acc += '/' + seg
    out.push({ name: seg, path: acc })
  }
  return out
}

function EntryIcon({ entry }: { entry: RemoteEntry }) {
  const kind = fileKind(entry.name, entry.isDir)
  const map: Record<string, [ReactNode, string]> = {
    folder: [<Folder className="size-[18px] fill-current" />, 'text-amber-400'],
    image: [<FileImage className="size-[18px]" />, 'text-emerald-500'],
    video: [<FileVideo className="size-[18px]" />, 'text-rose-500'],
    audio: [<FileAudio className="size-[18px]" />, 'text-pink-500'],
    archive: [<FileArchive className="size-[18px]" />, 'text-orange-500'],
    apk: [<Package className="size-[18px]" />, 'text-android-600'],
    pdf: [<FileText className="size-[18px]" />, 'text-red-500'],
    doc: [<FileText className="size-[18px]" />, 'text-brand-500'],
    code: [<FileCode className="size-[18px]" />, 'text-violet-500'],
    file: [<File className="size-[18px]" />, 'text-3']
  }
  const [icon, color] = map[kind]
  return <span className={color}>{icon}</span>
}

export function FilesScreen() {
  const device = useSelectedDevice()
  const serial = device?.serial ?? ''
  const toast = useApp((s) => s.toast)
  const toastError = useApp((s) => s.toastError)
  const [path, setPath] = useState(ROOT)
  const [history, setHistory] = useState<string[]>([])
  const [entries, setEntries] = useState<RemoteEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [anchor, setAnchor] = useState<number | null>(null)
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<{ key: 'name' | 'size' | 'mtime'; dir: 1 | -1 }>({ key: 'name', dir: 1 })
  const [dragging, setDragging] = useState(false)
  const [modal, setModal] = useState<null | { kind: 'mkdir' | 'rename' | 'delete'; entry?: RemoteEntry }>(null)
  const [nameInput, setNameInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewH, setViewH] = useState(600)
  const listRef = useRef<HTMLDivElement>(null)
  const openAfterDownload = useRef(new Set<string>())
  const pathRef = useRef(path)
  pathRef.current = path

  const load = useCallback(
    async (p: string, opts: { quiet?: boolean } = {}) => {
      if (!serial) return
      if (!opts.quiet) setLoading(true)
      setError(null)
      try {
        const list = await call('files:list', serial, p)
        setEntries(list)
        if (!opts.quiet) {
          setSelected(new Set())
          setAnchor(null)
          listRef.current?.scrollTo({ top: 0 })
        }
      } catch (e) {
        setError(friendly(e).message)
        setEntries([])
      } finally {
        setLoading(false)
      }
    },
    [serial]
  )

  useEffect(() => {
    void load(path)
  }, [path, load])

  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewH(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Refresh after uploads into this folder, open finished "double-click" downloads.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    return on('transfer:update', (t: TransferJob) => {
      if (t.status !== 'done') return
      if (t.direction === 'upload' && parentOf(t.destination) === pathRef.current) {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => void load(pathRef.current, { quiet: true }), 300)
      }
      if (t.direction === 'download' && openAfterDownload.current.has(t.id)) {
        openAfterDownload.current.delete(t.id)
        void call('shell:openPath', t.destination).catch(() => undefined)
      }
    })
  }, [load])

  const navigate = (p: string): void => {
    setHistory((h) => [...h.slice(-30), path])
    setFilter('')
    setPath(p)
  }

  const goShortcut = async (paths: string[]): Promise<void> => {
    for (const p of paths) {
      try {
        await call('files:list', serial, p)
        navigate(p)
        return
      } catch {
        /* try next */
      }
    }
    toast({ kind: 'info', title: 'Folder not found', message: 'This folder doesn’t exist on your phone yet.' })
  }

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const list = q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries
    return [...list].sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      let r = 0
      if (sort.key === 'name') r = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      else if (sort.key === 'size') r = a.size - b.size
      else r = a.mtime - b.mtime
      return r * sort.dir
    })
  }, [entries, filter, sort])

  const selectedEntries = visible.filter((e) => selected.has(e.path))

  const onRowClick = (e: React.MouseEvent, entry: RemoteEntry, index: number): void => {
    if (e.shiftKey && anchor !== null) {
      const [a, b] = [Math.min(anchor, index), Math.max(anchor, index)]
      setSelected(new Set(visible.slice(a, b + 1).map((x) => x.path)))
    } else if (e.ctrlKey || e.metaKey) {
      setSelected((s) => {
        const n = new Set(s)
        if (n.has(entry.path)) n.delete(entry.path)
        else n.add(entry.path)
        return n
      })
      setAnchor(index)
    } else {
      setSelected(new Set([entry.path]))
      setAnchor(index)
    }
  }

  const download = async (items: RemoteEntry[], open = false): Promise<void> => {
    if (!items.length) return
    try {
      const ids = await call('files:download', serial, items.map((i) => i.path))
      if (open) ids.forEach((id) => openAfterDownload.current.add(id))
      else toast({ kind: 'info', title: `Saving ${items.length === 1 ? items[0].name : `${items.length} items`} to your PC…` })
    } catch (e) {
      toastError(friendly(e))
    }
  }

  const downloadTo = async (items: RemoteEntry[]): Promise<void> => {
    const dir = await call('files:pickFolder')
    if (!dir) return
    try {
      await call('files:download', serial, items.map((i) => i.path), dir)
    } catch (e) {
      toastError(friendly(e))
    }
  }

  const upload = async (paths: string[]): Promise<void> => {
    if (!paths.length) return
    try {
      await call('files:upload', serial, paths, path)
      toast({ kind: 'info', title: `Copying ${paths.length === 1 ? 'file' : `${paths.length} items`} to your phone…` })
    } catch (e) {
      toastError(friendly(e))
    }
  }

  const open = (entry: RemoteEntry): void => {
    if (entry.isDir) navigate(entry.path)
    else void download([entry], true)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    if (e.key === 'Delete' && selectedEntries.length) setModal({ kind: 'delete' })
    else if (e.key === 'Enter' && selectedEntries.length === 1) open(selectedEntries[0])
    else if (e.key === 'Backspace' && path !== ROOT) navigate(parentOf(path))
    else if (e.key === 'F2' && selectedEntries.length === 1) {
      setNameInput(selectedEntries[0].name)
      setModal({ kind: 'rename', entry: selectedEntries[0] })
    } else if (e.key.toLowerCase() === 'a' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      setSelected(new Set(visible.map((v) => v.path)))
    }
  }

  const runModal = async (): Promise<void> => {
    if (!modal) return
    setBusy(true)
    try {
      if (modal.kind === 'mkdir') {
        await call('files:mkdir', serial, joinPath(path, nameInput.trim()))
        toast({ kind: 'success', title: 'Folder created' })
      } else if (modal.kind === 'rename' && modal.entry) {
        await call('files:rename', serial, modal.entry.path, joinPath(path, nameInput.trim()))
        toast({ kind: 'success', title: 'Renamed' })
      } else if (modal.kind === 'delete') {
        for (const item of selectedEntries) await call('files:delete', serial, item.path)
        toast({ kind: 'success', title: `Deleted ${selectedEntries.length === 1 ? selectedEntries[0].name : `${selectedEntries.length} items`}` })
      }
      setModal(null)
      await load(path, { quiet: true })
      setSelected(new Set())
    } catch (e) {
      toastError(friendly(e))
    } finally {
      setBusy(false)
    }
  }

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 8)
  const last = Math.min(visible.length, Math.ceil((scrollTop + viewH) / ROW_H) + 8)
  const sortHeader = (key: 'name' | 'size' | 'mtime', label: string, className?: string) => (
    <button
      className={cx('cursor-pointer text-left hover:text-1', sort.key === key && 'text-1', className)}
      onClick={() => setSort((s) => ({ key, dir: s.key === key ? ((-s.dir) as 1 | -1) : 1 }))}
    >
      {label}
      {sort.key === key && (sort.dir === 1 ? ' ↑' : ' ↓')}
    </button>
  )

  return (
    <div className="@container/files flex h-full gap-4 animate-fade-in @min-[52rem]/files:gap-5">
      {/* shortcuts */}
      <div className="w-11 shrink-0 @min-[52rem]/files:w-52">
        <div className="mb-2 hidden px-2 text-[11px] font-semibold tracking-wider text-3 uppercase @min-[52rem]/files:block">Quick places</div>
        <div className="space-y-0.5">
          {SHORTCUTS.map((s) => {
            const active = s.paths.includes(path)
            return (
              <button
                key={s.label}
                title={s.label}
                aria-label={s.label}
                onClick={() => void goShortcut(s.paths)}
                className={cx(
                  'flex w-full cursor-pointer items-center justify-center gap-2.5 rounded-xl px-3 py-2.5 text-[13px] font-medium transition-colors @min-[52rem]/files:justify-start @min-[52rem]/files:py-2',
                  active ? 'bg-brand-600/10 text-brand-700 dark:text-brand-200' : 'text-2 hover:surface-3 hover:text-1'
                )}
              >
                <span className={active ? 'text-brand-600 dark:text-brand-300' : 'text-3'}>{s.icon}</span>
                <span className="hidden truncate @min-[52rem]/files:inline">{s.label}</span>
              </button>
            )
          })}
        </div>
        <div className="mt-5 hidden rounded-2xl surface-2 p-3 text-[12px] leading-relaxed text-3 @min-[52rem]/files:block">
          <b className="text-2">Tip:</b> drag files or folders from your computer straight into this window to copy them to your phone.
        </div>
      </div>

      {/* main panel */}
      <div
        className="@container/panel relative flex min-w-0 flex-1 flex-col overflow-hidden card outline-none"
        tabIndex={0}
        onKeyDown={onKeyDown}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault()
            setDragging(true)
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          const paths = Array.from(e.dataTransfer.files)
            .map((f) => pathForFile(f))
            .filter(Boolean)
          void upload(paths)
        }}
      >
        {/* toolbar */}
        <div className="flex items-center gap-1.5 border-b border-soft p-2.5">
          <IconButton label="Back" disabled={!history.length} onClick={() => {
            const prev = history[history.length - 1]
            if (prev) {
              setHistory((h) => h.slice(0, -1))
              setPath(prev)
            }
          }}>
            <ArrowLeft className="size-4" />
          </IconButton>
          <IconButton label="Up one folder" disabled={path === ROOT} onClick={() => navigate(parentOf(path))}>
            <ArrowUpFromLine className="size-4" />
          </IconButton>
          <div className="mx-1 flex min-w-0 flex-1 items-center overflow-hidden rounded-xl surface-2 px-2 py-1.5">
            {crumbs(path).map((c, i, arr) => (
              <span key={c.path} className="flex min-w-0 items-center">
                {i > 0 && <ChevronRight className="mx-0.5 size-3.5 shrink-0 text-3" />}
                <button
                  onClick={() => i < arr.length - 1 && navigate(c.path)}
                  className={cx(
                    'truncate rounded-md px-1.5 py-0.5 text-[13px]',
                    i === arr.length - 1 ? 'font-semibold text-1' : 'cursor-pointer text-2 hover:surface-3 hover:text-1'
                  )}
                >
                  {c.name}
                </button>
              </span>
            ))}
          </div>
          <div className="relative w-36 shrink-0 @2xl/panel:w-44">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-3" />
            <TextInput className="h-9 pl-8 text-[13px]" placeholder="Filter this folder" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          <IconButton label="Refresh" onClick={() => void load(path)}>
            <RefreshCw className={cx('size-4', loading && 'animate-spin')} />
          </IconButton>
        </div>

        <div className="flex items-center gap-2 border-b border-soft px-3 py-2">
          <Button size="sm" icon={<Upload className="size-3.5" />} onClick={async () => upload(await call('files:pickUpload'))}>
            Upload
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<FolderPlus className="size-3.5" />}
            onClick={() => {
              setNameInput('New folder')
              setModal({ kind: 'mkdir' })
            }}
          >
            New folder
          </Button>
          <div className="mx-1 h-5 w-px bg-[var(--border)]" />
          <Button size="sm" variant="secondary" disabled={!selectedEntries.length} icon={<ArrowDownToLine className="size-3.5" />} onClick={() => void download(selectedEntries)}>
            Save to PC
          </Button>
          <Button
            size="sm"
            variant="ghost"
            title="Save to a folder you choose"
            aria-label="Save to…"
            disabled={!selectedEntries.length}
            icon={<FolderDown className="size-3.5" />}
            onClick={() => void downloadTo(selectedEntries)}
          >
            <span className="hidden @2xl/panel:inline">Save to…</span>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={selectedEntries.length !== 1}
            title="Rename"
            aria-label="Rename"
            icon={<Pencil className="size-3.5" />}
            onClick={() => {
              setNameInput(selectedEntries[0].name)
              setModal({ kind: 'rename', entry: selectedEntries[0] })
            }}
          >
            <span className="hidden @2xl/panel:inline">Rename</span>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            title="Delete"
            aria-label="Delete"
            disabled={!selectedEntries.length}
            icon={<Trash2 className="size-3.5" />}
            onClick={() => setModal({ kind: 'delete' })}
          >
            <span className="hidden @2xl/panel:inline">Delete</span>
          </Button>
          <div className="ml-auto truncate pl-1 text-[12px] whitespace-nowrap text-3">
            {selectedEntries.length ? `${selectedEntries.length} selected · ` : ''}
            {visible.length} item{visible.length === 1 ? '' : 's'}
          </div>
        </div>

        {/* header */}
        <div className="grid grid-cols-[28px_1fr_80px_118px] @2xl/panel:grid-cols-[28px_1fr_110px_170px] gap-3 border-b border-soft px-4 py-2 text-[12px] font-medium text-3">
          <input
            type="checkbox"
            className="size-3.5 cursor-pointer accent-brand-600"
            checked={visible.length > 0 && selectedEntries.length === visible.length}
            onChange={(e) => setSelected(e.target.checked ? new Set(visible.map((v) => v.path)) : new Set())}
            aria-label="Select all"
          />
          {sortHeader('name', 'Name')}
          {sortHeader('size', 'Size', 'text-right')}
          {sortHeader('mtime', 'Modified')}
        </div>

        {/* list */}
        <div ref={listRef} className="relative flex-1 overflow-y-auto" onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
          {loading && entries.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <Spinner />
            </div>
          ) : error ? (
            <EmptyState icon={<FolderOpen className="size-7" />} title="Can’t open this folder" message={error} action={<Button variant="secondary" onClick={() => navigate(ROOT)}>Go to Internal storage</Button>} />
          ) : visible.length === 0 ? (
            <EmptyState
              icon={<FolderOpen className="size-7" />}
              title={filter ? 'No matches' : 'This folder is empty'}
              message={filter ? 'Try a different search.' : 'Drag files here from your computer, or click Upload.'}
            />
          ) : (
            <div style={{ height: visible.length * ROW_H, position: 'relative' }}>
              {visible.slice(first, last).map((entry, i) => {
                const index = first + i
                const isSel = selected.has(entry.path)
                return (
                  <div
                    key={entry.path}
                    onClick={(e) => onRowClick(e, entry, index)}
                    onDoubleClick={() => open(entry)}
                    style={{ position: 'absolute', top: index * ROW_H, left: 0, right: 0, height: ROW_H }}
                    className={cx(
                      'grid cursor-default grid-cols-[28px_1fr_80px_118px] @2xl/panel:grid-cols-[28px_1fr_110px_170px] items-center gap-3 px-4 text-[13.5px]',
                      isSel ? 'bg-brand-500/10' : 'hover:surface-2'
                    )}
                  >
                    <input
                      type="checkbox"
                      className="size-3.5 cursor-pointer accent-brand-600"
                      checked={isSel}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() =>
                        setSelected((s) => {
                          const n = new Set(s)
                          if (n.has(entry.path)) n.delete(entry.path)
                          else n.add(entry.path)
                          return n
                        })
                      }
                      aria-label={`Select ${entry.name}`}
                    />
                    <div className="flex min-w-0 items-center gap-2.5">
                      <EntryIcon entry={entry} />
                      <span className="truncate text-1">
                        {entry.name}
                      </span>
                    </div>
                    <div className="text-right text-[12.5px] text-2 tabular-nums">{entry.isDir ? '—' : formatBytes(entry.size)}</div>
                    <div className="truncate text-[12.5px] text-2">{formatDate(entry.mtime)}</div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {dragging && (
          <div className="pointer-events-none absolute inset-2 z-20 flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-brand-500 bg-brand-500/10 backdrop-blur-[1px] animate-fade-in">
            <Upload className="size-10 text-brand-600" />
            <div className="mt-3 text-lg font-semibold text-1">Drop to copy to your phone</div>
            <div className="text-sm text-2">into “{crumbs(path).at(-1)?.name}”</div>
          </div>
        )}
      </div>

      <TransferTray />

      <Modal
        open={modal?.kind === 'mkdir' || modal?.kind === 'rename'}
        onClose={() => setModal(null)}
        title={modal?.kind === 'mkdir' ? 'New folder' : 'Rename'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setModal(null)}>
              Cancel
            </Button>
            <Button loading={busy} disabled={!nameInput.trim() || /[/]/.test(nameInput)} onClick={() => void runModal()}>
              {modal?.kind === 'mkdir' ? 'Create' : 'Rename'}
            </Button>
          </>
        }
      >
        <TextInput
          autoFocus
          value={nameInput}
          onChange={(e) => setNameInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && nameInput.trim() && void runModal()}
          onFocus={(e) => {
            const dot = e.target.value.lastIndexOf('.')
            e.target.setSelectionRange(0, dot > 0 && modal?.kind === 'rename' ? dot : e.target.value.length)
          }}
        />
        {/[/]/.test(nameInput) && <div className="mt-2 text-[12px] text-rose-500">Names can’t contain “/”.</div>}
      </Modal>

      <Modal
        open={modal?.kind === 'delete'}
        onClose={() => setModal(null)}
        title={`Delete ${selectedEntries.length === 1 ? `“${selectedEntries[0]?.name}”` : `${selectedEntries.length} items`}?`}
        icon={<Trash2 className="size-5 text-rose-500" />}
        footer={
          <>
            <Button variant="ghost" onClick={() => setModal(null)}>
              Cancel
            </Button>
            <Button variant="danger" loading={busy} onClick={() => void runModal()}>
              Delete permanently
            </Button>
          </>
        }
      >
        This removes {selectedEntries.length === 1 ? 'it' : 'them'} from your phone. There is no recycle bin, so this can’t be undone.
        {selectedEntries.some((e) => e.isDir) && <div className="mt-2 font-medium text-rose-600 dark:text-rose-400">Folders are deleted with everything inside them.</div>}
      </Modal>
    </div>
  )
}

function TransferTray() {
  const transfers = useApp((s) => s.transfers)
  const removeFinished = useApp((s) => s.removeFinishedTransfers)
  const [collapsed, setCollapsed] = useState(false)
  const list = Object.values(transfers).sort((a, b) => (b.startedAt ?? Number.MAX_SAFE_INTEGER) - (a.startedAt ?? Number.MAX_SAFE_INTEGER))
  if (!list.length) return null
  const active = list.filter((t) => t.status === 'running' || t.status === 'queued')
  return (
    <div className="fixed right-6 bottom-6 z-30 w-[380px] overflow-hidden card shadow-2xl shadow-slate-900/15 animate-slide-up">
      <div className="flex items-center justify-between border-b border-soft px-4 py-2.5">
        <div className="text-[13px] font-semibold text-1">
          {active.length ? `Transferring ${active.length} item${active.length > 1 ? 's' : ''}…` : 'Transfers complete'}
        </div>
        <div className="flex items-center gap-1">
          {active.length < list.length && (
            <button
              className="cursor-pointer rounded-lg px-2 py-1 text-[12px] text-2 hover:surface-3"
              onClick={() => {
                removeFinished()
                void call('files:clearFinished')
              }}
            >
              Clear
            </button>
          )}
          <IconButton label={collapsed ? 'Expand' : 'Collapse'} className="size-7" onClick={() => setCollapsed((c) => !c)}>
            <ChevronRight className={cx('size-4 transition-transform', collapsed ? '-rotate-90' : 'rotate-90')} />
          </IconButton>
        </div>
      </div>
      {!collapsed && (
        <div className="max-h-72 divide-y divide-[var(--border)] overflow-y-auto">
          {list.map((t) => (
            <TransferRow key={t.id} t={t} />
          ))}
        </div>
      )}
    </div>
  )
}

function TransferRow({ t }: { t: TransferJob }) {
  const pct = t.totalBytes ? (t.transferredBytes / t.totalBytes) * 100 : t.status === 'done' ? 100 : 0
  const running = t.status === 'running'
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-2.5">
        <div
          className={cx(
            'flex size-7 shrink-0 items-center justify-center rounded-lg',
            t.direction === 'upload' ? 'bg-brand-500/12 text-brand-600' : 'bg-emerald-500/12 text-emerald-600'
          )}
        >
          {t.direction === 'upload' ? <Upload className="size-3.5" /> : <Download className="size-3.5" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-1">
            {t.label}
          </div>
          <div className="truncate text-[11.5px] text-3">
            {t.status === 'queued' && 'Waiting…'}
            {running &&
              `${formatBytes(t.transferredBytes)} of ${formatBytes(t.totalBytes)}${t.bytesPerSecond ? ` · ${formatSpeed(t.bytesPerSecond)} · ${formatEta(t.totalBytes - t.transferredBytes, t.bytesPerSecond)}` : ''}`}
            {t.status === 'done' &&
              `${t.direction === 'upload' ? 'Copied to phone' : 'Saved to PC'} · ${formatBytes(t.totalBytes)}${t.filesTotal > 1 ? ` · ${t.filesTotal} files` : ''}`}
            {t.status === 'cancelled' && 'Cancelled'}
            {t.status === 'error' && <span className="text-rose-500">{t.error}</span>}
          </div>
        </div>
        {(running || t.status === 'queued') && (
          <IconButton label="Cancel" className="size-7" onClick={() => void call('files:cancel', t.id)}>
            <X className="size-3.5" />
          </IconButton>
        )}
        {t.status === 'done' && t.direction === 'download' && (
          <button className="cursor-pointer text-[12px] font-medium text-brand-600 hover:underline dark:text-brand-300" onClick={() => void call('shell:showItem', t.destination)}>
            Show
          </button>
        )}
      </div>
      {(running || t.status === 'queued') && <ProgressBar className="mt-2 h-1.5" value={pct} indeterminate={t.status === 'queued' || !t.totalBytes} />}
    </div>
  )
}
