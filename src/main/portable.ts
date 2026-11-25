// Portable mode: keep settings, the engine and caches in an "Easy ADB Data" folder next to the
// app so the whole thing can live on a USB stick or in any folder, without touching AppData.
//
// It switches on when a "portable.txt" file sits next to Easy ADB.exe (the portable zip ships
// with one), or when launched by electron-builder's single-file portable launcher.
// Imported first by index.ts so the path is set before anything reads it.
import { app } from 'electron'
import { accessSync, constants, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

function portableBaseDir(): string | null {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR
  if (!app.isPackaged) return null
  const exeDir = dirname(process.execPath)
  return existsSync(join(exeDir, 'portable.txt')) ? exeDir : null
}

const base = portableBaseDir()
export const portableDataDir = base ? join(base, 'Easy ADB Data') : null

if (portableDataDir) {
  try {
    mkdirSync(portableDataDir, { recursive: true })
    accessSync(portableDataDir, constants.W_OK)
    app.setPath('userData', portableDataDir)
  } catch {
    // Read-only location (e.g. a locked folder or CD): fall back to the normal app-data folder.
  }
}

export function isPortable(): boolean {
  return !!portableDataDir && app.getPath('userData') === portableDataDir
}
