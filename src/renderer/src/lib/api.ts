import { BridgeError, type IpcChannel, type IpcEventName, type IpcEvents, type IpcHandlers, type IpcReturn } from '@shared/ipc'
import type { FriendlyError } from '@shared/types'

/** Call the main process. Throws BridgeError (with a friendly message) on failure. */
export async function call<K extends IpcChannel>(channel: K, ...args: Parameters<IpcHandlers[K]>): Promise<IpcReturn<K>> {
  const res = await window.easyadb.invoke(channel, ...args)
  if (res.ok) return res.data
  throw new BridgeError(res.error)
}

export function on<E extends IpcEventName>(event: E, listener: (payload: IpcEvents[E]) => void): () => void {
  return window.easyadb.on(event, listener)
}

export function friendly(e: unknown): FriendlyError {
  if (e instanceof BridgeError) return e.friendly
  if (e instanceof Error) return { title: 'Something went wrong', message: e.message }
  return { title: 'Something went wrong', message: String(e) }
}

export function pathForFile(file: File): string {
  return window.easyadb.pathForFile(file)
}
