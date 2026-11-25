import { create } from 'zustand'
import type {
  AppSettings,
  DeviceDetails,
  DeviceSummary,
  EngineProgress,
  EngineStatus,
  FriendlyError,
  LogEntry,
  TransferJob
} from '@shared/types'
import { call } from './lib/api'

export type Page = 'home' | 'files' | 'apps' | 'install' | 'mirror' | 'tweaks' | 'connect' | 'settings'

export interface Toast {
  id: number
  kind: 'success' | 'error' | 'info'
  title: string
  message?: string
  action?: { label: string; run: () => void }
}

interface AppState {
  engine: EngineStatus | null
  engineProgress: EngineProgress | null
  devices: DeviceSummary[]
  selectedSerial: string | null
  /** The selected phone while it briefly drops and comes back (see RECONNECT_GRACE_MS). */
  reconnecting: DeviceSummary | null
  details: Record<string, DeviceDetails | undefined>
  settings: AppSettings | null
  page: Page
  logOpen: boolean
  log: LogEntry[]
  transfers: Record<string, TransferJob>
  toasts: Toast[]
  mirroring: Record<string, boolean>
  recording: Record<string, number | undefined>
  /** Recordings being copied from the phone to the PC. */
  savingRecording: Record<string, boolean>
  resolvedTheme: 'light' | 'dark'

  setPage: (p: Page) => void
  setDevices: (d: DeviceSummary[]) => void
  selectDevice: (serial: string | null) => void
  setDetails: (serial: string, d: DeviceDetails) => void
  setEngine: (e: EngineStatus) => void
  setEngineProgress: (p: EngineProgress | null) => void
  setSettings: (s: AppSettings) => void
  patchSettings: (patch: Partial<AppSettings>) => Promise<void>
  toggleLog: (open?: boolean) => void
  addLog: (e: LogEntry) => void
  setLog: (e: LogEntry[]) => void
  upsertTransfer: (t: TransferJob) => void
  removeFinishedTransfers: () => void
  toast: (t: Omit<Toast, 'id'>) => void
  toastError: (e: FriendlyError) => void
  dismissToast: (id: number) => void
  setMirroring: (serial: string, running: boolean) => void
  setRecording: (serial: string, startedAt: number | undefined) => void
  setSavingRecording: (serial: string, saving: boolean) => void
  setResolvedTheme: (t: 'light' | 'dark') => void
}

let toastId = 1

/** How long a phone may disappear before the app treats it as disconnected. */
const RECONNECT_GRACE_MS = 4000

export const useApp = create<AppState>((set, get) => ({
  engine: null,
  engineProgress: null,
  devices: [],
  selectedSerial: null,
  reconnecting: null,
  details: {},
  settings: null,
  page: 'home',
  logOpen: false,
  log: [],
  transfers: {},
  toasts: [],
  mirroring: {},
  recording: {},
  savingRecording: {},
  resolvedTheme: 'light',

  setPage: (page) => set({ page }),
  setDevices: (devices) => {
    const { selectedSerial, devices: before, reconnecting } = get()
    const online = devices.filter((d) => d.state === 'device')
    let next = selectedSerial
    const current = devices.find((d) => d.serial === selectedSerial)
    // Stop waiting as soon as the selected phone (or another one, e.g. the same phone over USB) is ready.
    let ghost = current?.state === 'device' || online.length ? null : reconnecting
    const dropped = before.find((d) => d.serial === selectedSerial && d.state === 'device')
    if (dropped && current?.state !== 'device' && !online.length) {
      // The phone in use dropped for a moment (e.g. its debugging service restarting after
      // "Go wireless"): keep the current page steady instead of flashing the Connect screen.
      ghost = dropped
      setTimeout(() => {
        if (get().reconnecting !== dropped) return
        set({ reconnecting: null })
        get().setDevices(get().devices)
      }, RECONNECT_GRACE_MS)
    }
    if (!ghost) {
      if (!current) next = online[0]?.serial ?? devices[0]?.serial ?? null
      else if (current.state !== 'device' && online.length) next = online[0].serial
    }
    set({ devices, selectedSerial: next, reconnecting: ghost })
  },
  selectDevice: (selectedSerial) => set({ selectedSerial }),
  setDetails: (serial, d) => set((s) => ({ details: { ...s.details, [serial]: d } })),
  setEngine: (engine) => set({ engine }),
  setEngineProgress: (engineProgress) => set({ engineProgress }),
  setSettings: (settings) => set({ settings, logOpen: settings.activityLogOpen }),
  patchSettings: async (patch) => {
    const next = await call('settings:set', patch)
    set({ settings: next })
  },
  toggleLog: (open) => {
    const next = open ?? !get().logOpen
    set({ logOpen: next })
    void call('settings:set', { activityLogOpen: next }).catch(() => undefined)
  },
  addLog: (e) => set((s) => ({ log: [...s.log.slice(-599), e] })),
  setLog: (log) => set({ log }),
  upsertTransfer: (t) => set((s) => ({ transfers: { ...s.transfers, [t.id]: t } })),
  removeFinishedTransfers: () =>
    set((s) => ({
      transfers: Object.fromEntries(Object.entries(s.transfers).filter(([, t]) => t.status === 'running' || t.status === 'queued'))
    })),
  toast: (t) => {
    const id = toastId++
    set((s) => ({ toasts: [...s.toasts.slice(-4), { ...t, id }] }))
    setTimeout(() => get().dismissToast(id), t.kind === 'error' ? 8000 : 4500)
  },
  toastError: (e) => get().toast({ kind: 'error', title: e.title, message: e.hint ? `${e.message} ${e.hint}` : e.message }),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setMirroring: (serial, running) => set((s) => ({ mirroring: { ...s.mirroring, [serial]: running } })),
  setRecording: (serial, startedAt) => set((s) => ({ recording: { ...s.recording, [serial]: startedAt } })),
  setSavingRecording: (serial, saving) => set((s) => ({ savingRecording: { ...s.savingRecording, [serial]: saving } })),
  setResolvedTheme: (resolvedTheme) => set({ resolvedTheme })
}))

export function useSelectedDevice(): DeviceSummary | undefined {
  return useApp((s) => {
    const d = s.devices.find((x) => x.serial === s.selectedSerial)
    if (s.reconnecting?.serial === s.selectedSerial && d?.state !== 'device') return s.reconnecting
    return d
  })
}

const modelKey = (model?: string): string => (model ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase()

export function deviceDisplayName(d: DeviceSummary | undefined, details?: DeviceDetails): string {
  // A phone reconnecting under a new address (e.g. USB → Wi-Fi) keeps the name we already know.
  const info =
    details ?? (d?.model ? Object.values(useApp.getState().details).find((x) => x && modelKey(x.model) === modelKey(d.model)) : undefined)
  if (info) return info.marketingName ?? info.model
  return d?.model ?? 'Android phone'
}
