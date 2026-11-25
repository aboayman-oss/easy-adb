// Shared domain types used by the main process, preload bridge and renderer.

export type DeviceState =
  | 'device'
  | 'unauthorized'
  | 'offline'
  | 'authorizing'
  | 'connecting'
  | 'no-permissions'
  | 'recovery'
  | 'sideload'
  | 'bootloader'
  | 'rescue'
  | 'unknown'

export type Transport = 'usb' | 'wifi'

export interface DeviceSummary {
  serial: string
  state: DeviceState
  transport: Transport
  /** Model from `adb devices -l` (underscores replaced by spaces). */
  model?: string
  product?: string
  device?: string
  transportId?: string
}

export type BatteryStatus = 'charging' | 'discharging' | 'not-charging' | 'full' | 'unknown'
export type BatteryHealth = 'good' | 'overheat' | 'dead' | 'over-voltage' | 'failure' | 'cold' | 'unknown'
export type PowerSource = 'ac' | 'usb' | 'wireless' | 'dock' | 'none'

export interface BatteryInfo {
  level: number
  status: BatteryStatus
  health: BatteryHealth
  plugged: PowerSource
  temperatureC?: number
  voltageV?: number
  technology?: string
  cycleCount?: number
  /** Remaining capacity versus design capacity, when the kernel exposes it. */
  capacityHealthPercent?: number
  chargeCounterMah?: number
}

export interface StorageBreakdown {
  apps?: number
  photos?: number
  videos?: number
  audio?: number
  downloads?: number
  system?: number
  other?: number
}

export interface StorageInfo {
  totalBytes: number
  usedBytes: number
  freeBytes: number
  breakdown?: StorageBreakdown
}

export interface MemoryInfo {
  totalBytes: number
  availableBytes: number
}

export interface DeviceDetails {
  serial: string
  manufacturer: string
  brand: string
  model: string
  /** Friendly marketing name such as "Galaxy S24 Ultra" when known. */
  marketingName?: string
  androidVersion: string
  sdk: number
  securityPatch?: string
  abiList: string[]
  battery?: BatteryInfo
  storage?: StorageInfo
  memory?: MemoryInfo
  screen?: { width: number; height: number; density: number; physicalDensity: number }
  uptimeSeconds?: number
}

// ---------------------------------------------------------------------------
// Engine

export type EngineComponent = 'platform-tools' | 'scrcpy'

export interface EngineComponentStatus {
  installed: boolean
  version?: string
  path?: string
}

export interface EngineStatus {
  ready: boolean
  adb: EngineComponentStatus
  scrcpy: EngineComponentStatus
  dir: string
}

export interface EngineProgress {
  phase: 'checking' | 'downloading' | 'extracting' | 'verifying' | 'done' | 'error'
  component?: EngineComponent
  /** 0..100 overall progress */
  percent: number
  message: string
  error?: string
}

export interface EngineUpdateInfo {
  adb: { current?: string; latest?: string; updateAvailable: boolean }
  scrcpy: { current?: string; latest?: string; updateAvailable: boolean }
}

// ---------------------------------------------------------------------------
// Files

export interface RemoteEntry {
  name: string
  path: string
  isDir: boolean
  isLink: boolean
  size: number
  mtime: number // unix seconds
}

export type TransferDirection = 'upload' | 'download'
export type TransferStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled'

export interface TransferJob {
  id: string
  serial: string
  direction: TransferDirection
  /** Display label (file or folder name). */
  label: string
  source: string
  destination: string
  status: TransferStatus
  totalBytes: number
  transferredBytes: number
  bytesPerSecond: number
  filesDone: number
  filesTotal: number
  currentFile?: string
  error?: string
  startedAt?: number
  finishedAt?: number
}

// ---------------------------------------------------------------------------
// Apps

export type SafetyLevel = 'safe' | 'caution' | 'core'

export interface AppEntry {
  packageName: string
  label: string
  /** True when the label came from the dictionary or the APK, not a guess. */
  labelResolved: boolean
  description?: string
  safety: SafetyLevel
  isSystem: boolean
  enabled: boolean
  /** Removed for the current user (data kept). */
  removed: boolean
  /** For removed apps: true when the system image still has it (one-click restore). */
  restorable?: boolean
  apkPath?: string
  versionCode?: number
  uid?: number
  icon?: string // data URL
}

export interface AppMeta {
  packageName: string
  label?: string
  icon?: string
  /** True when reading the APK failed temporarily (e.g. the phone dropped); try again later. */
  retry?: boolean
}

// ---------------------------------------------------------------------------
// Installer

export interface InstallAnalysis {
  file: string
  fileName: string
  kind: 'apk' | 'xapk' | 'apks' | 'apkm'
  packageName?: string
  appName?: string
  versionName?: string
  apkCount: number
  obbCount: number
  totalBytes: number
}

export interface InstallProgress {
  id: string
  fileName: string
  stage: 'preparing' | 'extracting' | 'installing' | 'copying-obb' | 'done' | 'error'
  percent: number
  message: string
  error?: FriendlyError
}

export interface FriendlyError {
  title: string
  message: string
  hint?: string
  code?: string
}

// ---------------------------------------------------------------------------
// Mirroring & capture

export type MirrorQuality = 'smooth' | 'balanced' | 'saver'

export interface MirrorOptions {
  quality: MirrorQuality
  turnScreenOff: boolean
  stayAwake: boolean
  audio: boolean
  alwaysOnTop: boolean
}

export interface CaptureResult {
  path: string
  previewDataUrl?: string
}

// ---------------------------------------------------------------------------
// Tweaks

export type AnimationPreset = 'normal' | 'fast' | 'off' | 'custom'

export interface DensityInfo {
  physical: number
  current: number
  presets: { label: string; value: number }[]
}

// ---------------------------------------------------------------------------
// Wireless

export interface RememberedDevice {
  id: string
  name: string
  host: string
  port: number
  lastConnected: number
}

export type PairingPhase =
  | 'waiting'
  | 'found'
  | 'pairing'
  | 'connecting'
  | 'connected'
  | 'error'
  | 'cancelled'

export interface PairingStatus {
  sessionId: string
  phase: PairingPhase
  message: string
  serial?: string
}

export interface QrPairingSession {
  sessionId: string
  qrDataUrl: string
  payload: string
  serviceName: string
}

// ---------------------------------------------------------------------------
// Drivers

export interface DriverProblemDevice {
  name: string
  instanceId: string
  status: string
  vendor?: string
}

/** An Android phone Windows sees on USB (whether or not adb can talk to it). */
export interface UsbPhone {
  key: string
  vendor?: string
  /** Brand guide id for the USB debugging wizard. */
  brandId: string
  /** The phone's own name when it shares files (e.g. "Sam's Galaxy S24"). */
  name: string
  serial?: string
  /** True once USB debugging is on (Windows shows an ADB interface). */
  adbInterface: boolean
  /** Name of a sub-device whose driver isn't working, if any. */
  driverProblem?: string
}

export interface DriverCheckResult {
  supported: boolean
  problemDevices: DriverProblemDevice[]
  androidUsbDevices: number
}

// ---------------------------------------------------------------------------
// Settings & log

export type ThemePreference = 'system' | 'light' | 'dark'

export interface AppSettings {
  theme: ThemePreference
  downloadDir: string
  captureDir: string
  mirror: MirrorOptions
  rememberedDevices: RememberedDevice[]
  activityLogOpen: boolean
  /** Phone model → the name people know it by ("SM-S928B" → "Galaxy S24 Ultra"), for messages before details load. */
  phoneNames?: Record<string, string>
}

export interface LogEntry {
  id: number
  time: number
  level: 'info' | 'success' | 'warn' | 'error'
  message: string
  command?: string
  durationMs?: number
}
