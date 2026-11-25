// Must stay the first import: it moves app data next to the .exe for the portable build.
import { isPortable } from './portable'
import { app, BrowserWindow, nativeTheme, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { abortRecording, activeRecordings } from './adb/capture'
import { cancelTransfersFor, listTransfers } from './adb/files'
import { runningMirrors, stopAllMirrors, stopMirror } from './adb/mirror'
import { killAllChildren } from './adb/runner'
import { markServerRestartedByUs, onDevicesChanged, setBusyCheck, shutdownServerIfOurs, start as startTracker, stop as stopTracker } from './adb/tracker'
import { shutdownWireless } from './adb/wireless'
import { hasAdb } from './engine/paths'
import { stopUsbWatch } from './platform/usbWatch'
import { cleanupEngineLeftovers, setBeforeEngineReplace } from './engine/provisioner'
import { adb } from './adb/runner'
import { registerIpc } from './ipc'
import { logInfo } from './services/log'
import { getSettings } from './services/settings'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  const dark = nativeTheme.shouldUseDarkColors
  const devIcon = join(__dirname, '../../build/icon.png')
  mainWindow = new BrowserWindow({
    icon: !app.isPackaged && existsSync(devIcon) ? devIcon : undefined,
    width: 1280,
    height: 840,
    minWidth: 980,
    minHeight: 640,
    show: false,
    title: 'Easy ADB',
    backgroundColor: dark ? '#0b0f17' : '#f6f7fb',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  // Never open new Electron windows; send safe external links to the browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    if (devUrl && url.startsWith(devUrl)) return
    event.preventDefault()
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    app.setAppUserModelId('app.easyadb.desktop')
    nativeTheme.themeSource = getSettings().theme
    registerIpc()

    // Clean up per-device activity when a phone disappears.
    onDevicesChanged((devices, previous) => {
      for (const p of previous) {
        const now = devices.find((d) => d.serial === p.serial)
        if (!now || now.state !== 'device') {
          cancelTransfersFor(p.serial)
          stopMirror(p.serial)
          abortRecording(p.serial)
        }
      }
    })

    // Never close a connection that a transfer, mirror or recording is using.
    setBusyCheck(
      (serial) =>
        runningMirrors().includes(serial) ||
        activeRecordings().some((r) => r.serial === serial) ||
        listTransfers().some((t) => t.serial === serial && (t.status === 'running' || t.status === 'queued'))
    )

    // Old engine folders that were still in use during an update can go now.
    cleanupEngineLeftovers()

    setBeforeEngineReplace(async () => {
      stopTracker()
      stopAllMirrors()
      if (hasAdb()) await adb(['kill-server'], { allowFailure: true, timeoutMs: 8000, log: 'Stopped the connection engine to update it' }).catch(() => undefined)
      // The server started after the update is Easy ADB's own.
      markServerRestartedByUs()
      await new Promise((r) => setTimeout(r, 800))
    })

    createWindow()
    logInfo(isPortable() ? 'Easy ADB started (portable: settings and engine are kept next to the app)' : 'Easy ADB started', {
      command: `data folder: ${app.getPath('userData')}`
    })
    if (hasAdb()) void startTracker()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  let cleanedUp = false
  app.on('will-quit', (event) => {
    if (cleanedUp) return
    event.preventDefault()
    cleanedUp = true
    stopAllMirrors()
    shutdownWireless()
    stopUsbWatch()
    const timeout = new Promise((r) => setTimeout(r, 3000))
    void Promise.race([shutdownServerIfOurs(), timeout]).finally(() => {
      killAllChildren()
      app.quit()
    })
  })
}
