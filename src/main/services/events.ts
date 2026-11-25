// Broadcasts typed events to every renderer window.
import { BrowserWindow } from 'electron'
import type { IpcEventName, IpcEvents } from '@shared/ipc'

export function emit<E extends IpcEventName>(event: E, payload: IpcEvents[E]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(event, payload)
  }
}
