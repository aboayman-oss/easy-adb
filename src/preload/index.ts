import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { EasyAdbBridge, IpcChannel, IpcEventName, IpcEvents } from '@shared/ipc'

const bridge: EasyAdbBridge = {
  invoke: (channel: IpcChannel, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  on: <E extends IpcEventName>(event: E, listener: (payload: IpcEvents[E]) => void) => {
    const wrapped = (_e: Electron.IpcRendererEvent, payload: IpcEvents[E]): void => listener(payload)
    ipcRenderer.on(event, wrapped)
    return () => {
      ipcRenderer.removeListener(event, wrapped)
    }
  },
  pathForFile: (file: File) => webUtils.getPathForFile(file)
} as EasyAdbBridge

contextBridge.exposeInMainWorld('easyadb', bridge)
