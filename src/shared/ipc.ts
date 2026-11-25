// The typed IPC contract between the renderer and the main process.
import type {
  AnimationPreset,
  AppEntry,
  AppMeta,
  AppSettings,
  CaptureResult,
  DensityInfo,
  DeviceDetails,
  DeviceSummary,
  DriverCheckResult,
  EngineProgress,
  EngineStatus,
  EngineUpdateInfo,
  FriendlyError,
  InstallAnalysis,
  InstallProgress,
  LogEntry,
  MirrorOptions,
  PairingStatus,
  QrPairingSession,
  RememberedDevice,
  RemoteEntry,
  TransferJob,
  UsbPhone
} from './types'

/** Request/response handlers exposed by the main process. */
export interface IpcHandlers {
  // engine
  'engine:status': () => EngineStatus
  'engine:install': (opts?: { force?: boolean }) => EngineStatus
  'engine:checkUpdates': () => EngineUpdateInfo

  // devices
  'devices:list': () => DeviceSummary[]
  'devices:details': (serial: string) => DeviceDetails
  'devices:battery': (serial: string) => DeviceDetails['battery']
  'devices:restartServer': () => void

  // files
  'files:list': (serial: string, path: string) => RemoteEntry[]
  'files:upload': (serial: string, localPaths: string[], remoteDir: string) => string[]
  'files:download': (serial: string, remotePaths: string[], localDir?: string) => string[]
  'files:cancel': (jobId: string) => void
  'files:clearFinished': () => void
  'files:transfers': () => TransferJob[]
  'files:mkdir': (serial: string, path: string) => void
  'files:rename': (serial: string, from: string, to: string) => void
  'files:delete': (serial: string, path: string) => void
  'files:pickUpload': () => string[]
  'files:pickFolder': () => string | null

  // apps
  'apps:list': (serial: string) => AppEntry[]
  'apps:meta': (serial: string, packages: string[]) => AppMeta[]
  'apps:remove': (serial: string, pkg: string, allowCore?: boolean) => void
  'apps:disable': (serial: string, pkg: string, allowCore?: boolean) => void
  'apps:enable': (serial: string, pkg: string) => void
  'apps:restore': (serial: string, pkg: string) => void
  'apps:uninstall': (serial: string, pkg: string) => void
  'apps:launch': (serial: string, pkg: string) => void
  'apps:openStore': (serial: string, pkg: string) => void

  // installer
  'install:pick': () => string[]
  'install:analyze': (file: string) => InstallAnalysis
  'install:run': (serial: string, file: string) => string

  // mirror & capture
  'mirror:start': (serial: string, options: MirrorOptions, deviceName?: string) => void
  'mirror:stop': (serial: string) => void
  'mirror:running': () => string[]
  'capture:screenshot': (serial: string) => CaptureResult
  'capture:recordStart': (serial: string) => void
  'capture:recordStop': (serial: string) => CaptureResult
  'capture:recording': () => { serial: string; startedAt: number }[]

  // tweaks & power
  'tweaks:animation': (serial: string) => { preset: AnimationPreset; scale: number }
  'tweaks:setAnimation': (serial: string, scale: number) => void
  'tweaks:density': (serial: string) => DensityInfo
  'tweaks:setDensity': (serial: string, value: number | null) => { revertInSeconds: number }
  'tweaks:confirmDensity': (serial: string) => void
  'tweaks:revertDensity': (serial: string) => void
  'tweaks:stayAwake': (serial: string) => boolean
  'tweaks:setStayAwake': (serial: string, on: boolean) => void
  'power:action': (serial: string, action: 'reboot' | 'recovery' | 'poweroff') => void

  // wireless
  'wireless:startQr': () => QrPairingSession
  'wireless:cancelQr': (sessionId: string) => void
  'wireless:pairManual': (host: string, port: number, code: string) => boolean
  'wireless:connect': (host: string, port: number) => string
  'wireless:reconnect': (id: string) => string
  'wireless:disconnect': (serial: string) => void
  'wireless:switchToWifi': (serial: string) => string
  'wireless:discover': () => { name: string; host: string; port: number }[]
  'wireless:forget': (id: string) => void
  'wireless:remembered': () => RememberedDevice[]

  // drivers (Windows)
  'drivers:check': () => DriverCheckResult
  'drivers:installGoogle': () => string
  'usb:watch': (on: boolean) => UsbPhone[]

  // settings & app
  'settings:get': () => AppSettings
  'settings:set': (patch: Partial<AppSettings>) => AppSettings
  'log:history': () => LogEntry[]
  'log:clear': () => void
  'shell:openPath': (path: string) => void
  'shell:showItem': (path: string) => void
  'shell:openExternal': (url: string) => void
  'app:info': () => { version: string; platform: NodeJS.Platform; arch: string; portable: boolean; dataDir: string }
}

/** Push events emitted by the main process. */
export interface IpcEvents {
  'engine:progress': EngineProgress
  'devices:changed': DeviceSummary[]
  'log:entry': LogEntry
  'transfer:update': TransferJob
  'install:progress': InstallProgress
  'wireless:pairing': PairingStatus
  'mirror:state': { serial: string; running: boolean; error?: FriendlyError }
  /** saving: the video is being copied to the PC; savedPath / error: how that ended; auto: stopped by the 3-minute limit. */
  'record:state': { serial: string; recording: boolean; startedAt?: number; saving?: boolean; savedPath?: string; error?: FriendlyError; auto?: boolean }
  'density:reverted': { serial: string }
  'apps:changed': { serial: string }
  'usb:phones': UsbPhone[]
}

export type IpcChannel = keyof IpcHandlers
export type IpcEventName = keyof IpcEvents

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: FriendlyError }

export type IpcReturn<K extends IpcChannel> = Awaited<ReturnType<IpcHandlers[K]>>

export interface EasyAdbBridge {
  invoke<K extends IpcChannel>(
    channel: K,
    ...args: Parameters<IpcHandlers[K]>
  ): Promise<IpcResult<IpcReturn<K>>>
  on<E extends IpcEventName>(event: E, listener: (payload: IpcEvents[E]) => void): () => void
  /** Absolute filesystem path for a dropped File object. */
  pathForFile(file: File): string
}

/** Error thrown in the renderer when a handler fails; carries the friendly payload. */
export class BridgeError extends Error {
  constructor(public readonly friendly: FriendlyError) {
    super(friendly.message)
    this.name = 'BridgeError'
  }
}
