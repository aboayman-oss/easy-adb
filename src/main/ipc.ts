// Registers every IPC handler. Each handler returns { ok, data } or { ok: false, error }
// so the renderer never sees raw stack traces.
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell as electronShell } from 'electron'
import { existsSync } from 'node:fs'
import type { IpcChannel, IpcHandlers, IpcResult } from '@shared/ipc'
import { readBattery, readDetails } from './adb/deviceInfo'
import {
  cancelTransfer,
  clearFinished,
  deleteEntry,
  downloadPaths,
  listDirectory,
  listTransfers,
  makeDirectory,
  renameEntry,
  uploadPaths
} from './adb/files'
import { activeRecordings, startRecording, stopRecording, takeScreenshot } from './adb/capture'
import { analyzeInstall, runInstall } from './adb/installer'
import { runningMirrors, startMirror, stopMirror } from './adb/mirror'
import { appMeta, disableApp, enableApp, launchApp, listApps, openStorePage, removeApp, restoreApp, uninstallApp } from './adb/packages'
import { currentDevices, reconnectKnownWifi, restartServer, start as startTracker } from './adb/tracker'
import {
  confirmDensity,
  getAnimation,
  getDensity,
  getStayAwake,
  powerAction,
  revertDensity,
  setAnimation,
  setDensity,
  setStayAwake
} from './adb/tweaks'
import {
  cancelQrPairing,
  connect,
  disconnect,
  discoverConnectable,
  forget,
  pairManual,
  reconnect,
  rememberedDevices,
  startQrPairing,
  switchToWifi
} from './adb/wireless'
import { checkEngineUpdates, engineStatus, ensureEngine } from './engine/provisioner'
import { AppError, toFriendlyError } from './lib/errors'
import { checkDrivers, installGoogleUsbDriver } from './platform/drivers'
import { isPortable } from './portable'
import { setUsbWatch } from './platform/usbWatch'
import { clearLog, logHistory } from './services/log'
import { getSettings, updateSettings } from './services/settings'

type Impl<K extends IpcChannel> = (
  ...args: Parameters<IpcHandlers[K]>
) => ReturnType<IpcHandlers[K]> | Promise<Awaited<ReturnType<IpcHandlers[K]>>>

function handle<K extends IpcChannel>(channel: K, impl: Impl<K>): void {
  ipcMain.handle(channel, async (_event, ...args: unknown[]): Promise<IpcResult<Awaited<ReturnType<IpcHandlers[K]>>>> => {
    try {
      const data = (await impl(...(args as Parameters<IpcHandlers[K]>))) as Awaited<ReturnType<IpcHandlers[K]>>
      return { ok: true, data }
    } catch (e) {
      return { ok: false, error: toFriendlyError(e) }
    }
  })
}

function focusedWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
}

function deviceTitle(serial: string): string {
  const d = currentDevices().find((x) => x.serial === serial)
  return `Easy ADB - ${d?.model ?? 'Phone'}`
}

export function registerIpc(): void {
  // engine
  handle('engine:status', () => engineStatus())
  handle('engine:install', async (opts) => {
    const status = await ensureEngine({ force: opts?.force })
    // If the update had to restart the adb server, bring Wi-Fi phones back immediately.
    void startTracker().then(() => reconnectKnownWifi())
    return status
  })
  handle('engine:checkUpdates', () => checkEngineUpdates())

  // devices
  handle('devices:list', () => currentDevices())
  handle('devices:details', (serial) => readDetails(serial))
  handle('devices:battery', (serial) => readBattery(serial))
  handle('devices:restartServer', () => restartServer())

  // files
  handle('files:list', (serial, path) => listDirectory(serial, path))
  handle('files:upload', (serial, paths, dir) => uploadPaths(serial, paths, dir))
  handle('files:download', (serial, paths, dir) => downloadPaths(serial, paths, dir))
  handle('files:cancel', (id) => cancelTransfer(id))
  handle('files:clearFinished', () => clearFinished())
  handle('files:transfers', () => listTransfers())
  handle('files:mkdir', (serial, path) => makeDirectory(serial, path))
  handle('files:rename', (serial, from, to) => renameEntry(serial, from, to))
  handle('files:delete', (serial, path) => deleteEntry(serial, path))
  handle('files:pickUpload', async () => {
    const win = focusedWindow()
    const opts = { title: 'Choose files to copy to your phone', properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[] }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return res.canceled ? [] : res.filePaths
  })
  handle('files:pickFolder', async () => {
    const win = focusedWindow()
    const opts = { title: 'Choose a folder', properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return res.canceled || !res.filePaths[0] ? null : res.filePaths[0]
  })

  // apps
  handle('apps:list', (serial) => listApps(serial))
  handle('apps:meta', (serial, pkgs) => appMeta(serial, pkgs))
  handle('apps:remove', (serial, pkg, allowCore) => removeApp(serial, pkg, allowCore))
  handle('apps:disable', (serial, pkg, allowCore) => disableApp(serial, pkg, allowCore))
  handle('apps:enable', (serial, pkg) => enableApp(serial, pkg))
  handle('apps:restore', (serial, pkg) => restoreApp(serial, pkg))
  handle('apps:uninstall', (serial, pkg) => uninstallApp(serial, pkg))
  handle('apps:launch', (serial, pkg) => launchApp(serial, pkg))
  handle('apps:openStore', (serial, pkg) => openStorePage(serial, pkg))

  // installer
  handle('install:pick', async () => {
    const win = focusedWindow()
    const opts = {
      title: 'Choose apps to install',
      properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[],
      filters: [{ name: 'Android apps', extensions: ['apk', 'xapk', 'apks', 'apkm'] }]
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return res.canceled ? [] : res.filePaths
  })
  handle('install:analyze', (file) => analyzeInstall(file))
  handle('install:run', (serial, file) => runInstall(serial, file))

  // mirror & capture
  handle('mirror:start', (serial, options, deviceName) => {
    updateSettings({ mirror: options })
    const name = deviceName?.replace(/[^\p{L}\p{N} ()+.-]/gu, '').slice(0, 60)
    startMirror(serial, options, name ? `Easy ADB - ${name}` : deviceTitle(serial))
  })
  handle('mirror:stop', (serial) => stopMirror(serial))
  handle('mirror:running', () => runningMirrors())
  handle('capture:screenshot', (serial) => takeScreenshot(serial))
  handle('capture:recordStart', (serial) => startRecording(serial))
  handle('capture:recordStop', (serial) => stopRecording(serial))
  handle('capture:recording', () => activeRecordings())

  // tweaks & power
  handle('tweaks:animation', (serial) => getAnimation(serial))
  handle('tweaks:setAnimation', (serial, scale) => setAnimation(serial, scale))
  handle('tweaks:density', (serial) => getDensity(serial))
  handle('tweaks:setDensity', (serial, value) => setDensity(serial, value))
  handle('tweaks:confirmDensity', (serial) => confirmDensity(serial))
  handle('tweaks:revertDensity', (serial) => revertDensity(serial))
  handle('tweaks:stayAwake', (serial) => getStayAwake(serial))
  handle('tweaks:setStayAwake', (serial, on) => setStayAwake(serial, on))
  handle('power:action', (serial, action) => powerAction(serial, action))

  // wireless
  handle('wireless:startQr', () => startQrPairing())
  handle('wireless:cancelQr', (id) => cancelQrPairing(id))
  handle('wireless:pairManual', (host, port, code) => pairManual(host, port, code))
  handle('wireless:connect', (host, port) => connect(host.trim(), port))
  handle('wireless:reconnect', (id) => {
    const d = rememberedDevices().find((r) => r.id === id)
    if (!d) throw new AppError({ title: 'Not found', message: 'That device is no longer remembered.' })
    return reconnect(d.host, d.port)
  })
  handle('wireless:disconnect', (serial) => disconnect(serial))
  handle('wireless:switchToWifi', (serial) => switchToWifi(serial))
  handle('wireless:discover', () => discoverConnectable())
  handle('wireless:forget', (id) => forget(id))
  handle('wireless:remembered', () => rememberedDevices())

  // drivers
  handle('drivers:check', () => checkDrivers())
  handle('drivers:installGoogle', () => installGoogleUsbDriver())
  handle('usb:watch', (on) => setUsbWatch(on))

  // settings & app
  handle('settings:get', () => getSettings())
  handle('settings:set', (patch) => {
    const next = updateSettings(patch)
    if (patch.theme) nativeTheme.themeSource = patch.theme
    return next
  })
  handle('log:history', () => logHistory())
  handle('log:clear', () => clearLog())
  handle('shell:openPath', async (path) => {
    if (!existsSync(path)) throw new AppError({ title: 'Not found', message: 'That file or folder no longer exists.' })
    const err = await electronShell.openPath(path)
    if (err) throw new Error(err)
  })
  handle('shell:showItem', (path) => {
    if (!existsSync(path)) throw new AppError({ title: 'Not found', message: 'That file or folder no longer exists.' })
    electronShell.showItemInFolder(path)
  })
  handle('shell:openExternal', async (url) => {
    if (!/^https:\/\//i.test(url)) throw new AppError({ title: 'Blocked link', message: 'Only secure web links can be opened.' })
    await electronShell.openExternal(url)
  })
  handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, arch: process.arch, portable: isPortable(), dataDir: app.getPath('userData') }))
}
