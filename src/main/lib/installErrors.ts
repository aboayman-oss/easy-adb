import type { FriendlyError } from '@shared/types'

interface Explanation {
  title: string
  message: string
  hint?: string
}

const EXPLANATIONS: Record<string, Explanation> = {
  INSTALL_FAILED_VERSION_DOWNGRADE: {
    title: 'A newer version is already installed',
    message: 'Your phone already has a newer version of this app, and Android won’t replace it with an older one.',
    hint: 'Uninstall the app from the Apps tab first, then install this version again (its data will be removed).'
  },
  INSTALL_FAILED_ALREADY_EXISTS: {
    title: 'App already installed',
    message: 'This app is already on your phone.',
    hint: 'Uninstall it first if you want a clean install.'
  },
  INSTALL_FAILED_UPDATE_INCOMPATIBLE: {
    title: 'Signature doesn’t match',
    message: 'The app on your phone was published by a different source, so Android won’t let this file update it.',
    hint: 'Uninstall the existing app first, then try again (its data will be removed).'
  },
  INSTALL_PARSE_FAILED_INCONSISTENT_CERTIFICATES: {
    title: 'Signature doesn’t match',
    message: 'The installed app and this file were signed by different publishers.',
    hint: 'Uninstall the existing app first, then try again.'
  },
  INSTALL_FAILED_SHARED_USER_INCOMPATIBLE: {
    title: 'Signature doesn’t match',
    message: 'This app conflicts with another app on your phone that uses a different signature.'
  },
  INSTALL_FAILED_NO_MATCHING_ABIS: {
    title: 'Not made for this phone’s processor',
    message: 'This file was built for a different type of processor (for example, x86 instead of ARM).',
    hint: 'Download the version labelled “arm64-v8a” (most modern phones) or “universal”.'
  },
  INSTALL_FAILED_INSUFFICIENT_STORAGE: {
    title: 'Not enough storage',
    message: 'Your phone doesn’t have enough free space to install this app.',
    hint: 'Free up some space (Files tab or remove unused apps) and try again.'
  },
  INSTALL_FAILED_OLDER_SDK: {
    title: 'Android version too old',
    message: 'This app needs a newer version of Android than your phone has.',
    hint: 'Look for an older release of the app that supports your Android version.'
  },
  INSTALL_FAILED_NEWER_SDK: {
    title: 'Android version too new',
    message: 'This app was made only for older Android versions.'
  },
  INSTALL_FAILED_DEPRECATED_SDK_VERSION: {
    title: 'App is too old for this phone',
    message: 'This app targets a very old Android version that your phone no longer allows.',
    hint: 'Download a newer version of the app.'
  },
  INSTALL_FAILED_TEST_ONLY: {
    title: 'Developer test build',
    message: 'This file is a developer test build that Android blocks by default.'
  },
  INSTALL_FAILED_INVALID_APK: {
    title: 'Damaged or incomplete file',
    message: 'The app file looks broken or incomplete.',
    hint: 'Download it again from a trusted source.'
  },
  INSTALL_PARSE_FAILED_NOT_APK: {
    title: 'Not an app file',
    message: 'This file isn’t a valid Android app.'
  },
  INSTALL_PARSE_FAILED_NO_CERTIFICATES: {
    title: 'Unsigned app',
    message: 'This app file isn’t signed, so Android refuses to install it.',
    hint: 'Download the app from a trusted source.'
  },
  INSTALL_PARSE_FAILED_UNEXPECTED_EXCEPTION: {
    title: 'Damaged or incomplete file',
    message: 'Android couldn’t read this app file.',
    hint: 'Download it again from a trusted source.'
  },
  INSTALL_PARSE_FAILED_MANIFEST_MALFORMED: {
    title: 'Damaged app file',
    message: 'This app’s internal description is broken.'
  },
  INSTALL_FAILED_MISSING_SPLIT: {
    title: 'Missing app parts',
    message: 'This app is split into several pieces and some are missing.',
    hint: 'Use the complete .xapk / .apks / .apkm bundle instead of a single .apk.'
  },
  INSTALL_FAILED_MISSING_SHARED_LIBRARY: {
    title: 'Needs a missing component',
    message: 'This app depends on a system component your phone doesn’t have.'
  },
  INSTALL_FAILED_USER_RESTRICTED: {
    title: 'Blocked on the phone',
    message: 'Your phone blocked the installation.',
    hint: 'On some phones (Xiaomi, OPPO, vivo) you must enable “Install via USB” in Developer options, and confirm the prompt on the phone screen.'
  },
  INSTALL_FAILED_ABORTED: {
    title: 'Installation cancelled',
    message: 'The installation was cancelled on the phone.',
    hint: 'Watch your phone screen and tap “Install” if it asks.'
  },
  INSTALL_FAILED_VERIFICATION_FAILURE: {
    title: 'Blocked by Play Protect',
    message: 'Google Play Protect or the phone’s security scanner blocked this app.',
    hint: 'Check your phone screen — you may be able to choose “Install anyway”.'
  },
  INSTALL_FAILED_CONFLICTING_PROVIDER: {
    title: 'Conflicts with another app',
    message: 'Another installed app already uses a feature this app needs.'
  },
  INSTALL_FAILED_DUPLICATE_PERMISSION: {
    title: 'Conflicts with another app',
    message: 'Another installed app already defines a permission this app needs.'
  },
  INSTALL_FAILED_SESSION_INVALID: {
    title: 'Installation interrupted',
    message: 'The installation session ended unexpectedly.',
    hint: 'Try again.'
  },
  INSTALL_FAILED_INTERNAL_ERROR: {
    title: 'Phone installer error',
    message: 'Android’s installer hit an internal problem.',
    hint: 'Restart your phone and try again.'
  },
  INSTALL_FAILED_MEDIA_UNAVAILABLE: {
    title: 'Storage unavailable',
    message: 'The storage location for this app isn’t available.'
  },
  INSTALL_FAILED_CPU_ABI_INCOMPATIBLE: {
    title: 'Not made for this phone’s processor',
    message: 'This file was built for a different type of processor.'
  },
  INSTALL_FAILED_PERMISSION_MODEL_DOWNGRADE: {
    title: 'Can’t install over the newer app',
    message: 'The installed version uses a newer permission model than this file.',
    hint: 'Uninstall the existing app first.'
  },
  INSTALL_FAILED_DEXOPT: {
    title: 'Phone couldn’t prepare the app',
    message: 'Android failed while optimising the app.',
    hint: 'Free some space and restart the phone, then try again.'
  },
  INSTALL_FAILED_HYPERVISOR_UNAVAILABLE: {
    title: 'Unsupported feature',
    message: 'This app needs a feature your phone doesn’t support.'
  }
}

/** Translate the raw output of `adb install` into a plain-language error. */
export function translateInstallError(output: string): FriendlyError {
  const codeMatch = /\b(INSTALL_(?:FAILED|PARSE_FAILED)_[A-Z_]+)\b/.exec(output)
  if (codeMatch) {
    const code = codeMatch[1]
    const known = EXPLANATIONS[code]
    if (known) return { ...known, code }
    return {
      title: 'Installation failed',
      message: 'Android refused to install this app.',
      hint: `Technical reason: ${code.replace(/_/g, ' ').toLowerCase()}`,
      code
    }
  }
  if (/Requested internal only, but not enough space/i.test(output) || /No space left/i.test(output)) {
    return { ...EXPLANATIONS.INSTALL_FAILED_INSUFFICIENT_STORAGE, code: 'INSTALL_FAILED_INSUFFICIENT_STORAGE' }
  }
  if (/Unknown option|is not a valid zip|failed to read|Failed to parse/i.test(output)) {
    return { ...EXPLANATIONS.INSTALL_FAILED_INVALID_APK, code: 'INSTALL_FAILED_INVALID_APK' }
  }
  return {
    title: 'Installation failed',
    message: 'The app couldn’t be installed.',
    hint: 'Check your phone screen for a confirmation prompt, then try again.',
    code: 'UNKNOWN'
  }
}

/** True when `adb install` output indicates success. */
export function isInstallSuccess(output: string): boolean {
  return /^\s*Success\s*$/m.test(output) && !/Failure \[/.test(output)
}
