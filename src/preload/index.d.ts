import type { EasyAdbBridge } from '../shared/ipc'

declare global {
  interface Window {
    easyadb: EasyAdbBridge
  }
}

export {}
