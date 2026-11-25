import { describe, expect, it } from 'vitest'
import { isInstallSuccess, translateInstallError } from '../src/main/lib/installErrors'

describe('install error translation', () => {
  it('explains a version downgrade', () => {
    const e = translateInstallError(
      'Performing Streamed Install\nadb: failed to install app.apk: Failure [INSTALL_FAILED_VERSION_DOWNGRADE: Downgrade detected: Update version code 10 is older than current 12]'
    )
    expect(e.code).toBe('INSTALL_FAILED_VERSION_DOWNGRADE')
    expect(e.title).toMatch(/newer version/i)
    expect(e.hint).toMatch(/uninstall/i)
  })

  it('explains missing ABIs and storage problems', () => {
    expect(translateInstallError('Failure [INSTALL_FAILED_NO_MATCHING_ABIS: Failed to extract native libraries, res=-113]').title).toMatch(/processor/i)
    expect(translateInstallError('Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]').title).toMatch(/storage/i)
    expect(translateInstallError('Error: Requested internal only, but not enough space').code).toBe('INSTALL_FAILED_INSUFFICIENT_STORAGE')
  })

  it('explains signature conflicts and Xiaomi restrictions', () => {
    expect(translateInstallError('Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Package x signatures do not match]').title).toMatch(/signature/i)
    expect(translateInstallError('Failure [INSTALL_FAILED_USER_RESTRICTED: Install canceled by user]').hint).toMatch(/Install via USB/)
  })

  it('handles unknown failure codes gracefully', () => {
    const e = translateInstallError('Failure [INSTALL_FAILED_SOMETHING_NEW]')
    expect(e.code).toBe('INSTALL_FAILED_SOMETHING_NEW')
    expect(e.title).toBe('Installation failed')
  })

  it('never shows raw text for unrecognised output', () => {
    const e = translateInstallError('java.lang.NullPointerException at com.android.server...')
    expect(e.code).toBe('UNKNOWN')
    expect(e.message).not.toMatch(/Exception/)
  })

  it('detects success', () => {
    expect(isInstallSuccess('Performing Streamed Install\nSuccess\n')).toBe(true)
    expect(isInstallSuccess('Success\r\n')).toBe(true)
    expect(isInstallSuccess('Failure [INSTALL_FAILED_ABORTED]')).toBe(false)
    expect(isInstallSuccess('')).toBe(false)
  })
})
