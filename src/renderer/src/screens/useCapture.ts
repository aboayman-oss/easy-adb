import { useCallback, useEffect, useState } from 'react'
import { call, friendly } from '../lib/api'
import { formatDuration } from '../lib/format'
import { useApp } from '../store'

/** Shared screenshot / screen-recording logic used by the dashboard and the Mirror page. */
export function useCapture(serial: string) {
  const toast = useApp((s) => s.toast)
  const toastError = useApp((s) => s.toastError)
  const startedAt = useApp((s) => s.recording[serial])
  const setRecording = useApp((s) => s.setRecording)
  const saving = useApp((s) => !!s.savingRecording[serial])
  const [busy, setBusy] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)
  const [lastPath, setLastPath] = useState<string | null>(null)
  const [, tick] = useState(0)

  useEffect(() => {
    if (!startedAt) return
    const t = setInterval(() => tick((n) => n + 1), 500)
    return () => clearInterval(t)
  }, [startedAt])

  const savedToast = useCallback(
    (title: string, path: string) =>
      toast({ kind: 'success', title, message: path, action: { label: 'Show in folder', run: () => void call('shell:showItem', path) } }),
    [toast]
  )

  const screenshot = useCallback(async () => {
    setBusy(true)
    try {
      const r = await call('capture:screenshot', serial)
      setPreview(r.previewDataUrl ?? null)
      setLastPath(r.path)
      savedToast('Screenshot saved', r.path)
    } catch (e) {
      toastError(friendly(e))
    } finally {
      setBusy(false)
    }
  }, [serial, savedToast, toastError])

  const toggleRecord = useCallback(async () => {
    if (saving) return
    if (startedAt) {
      setStopping(true)
      setRecording(serial, undefined)
      try {
        const r = await call('capture:recordStop', serial)
        savedToast('Recording saved', r.path)
        setLastPath(r.path)
      } catch (e) {
        toastError(friendly(e))
      } finally {
        setStopping(false)
      }
    } else {
      try {
        await call('capture:recordStart', serial)
        setRecording(serial, Date.now())
        toast({ kind: 'info', title: 'Recording started', message: 'Recording stops automatically after 3 minutes.' })
      } catch (e) {
        toastError(friendly(e))
      }
    }
  }, [saving, startedAt, serial, setRecording, savedToast, toast, toastError])

  return {
    busy,
    stopping: stopping || saving,
    /** The video is being copied from the phone to the PC. */
    saving: stopping || saving,
    recording: !!startedAt,
    elapsed: startedAt ? formatDuration((Date.now() - startedAt) / 1000) : '00:00',
    screenshot,
    toggleRecord,
    preview,
    lastPath,
    clearPreview: () => setPreview(null)
  }
}
