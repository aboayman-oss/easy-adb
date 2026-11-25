import { describe, expect, it } from 'vitest'
import { bundleKindFromName, planBundle, selectSplits, splitAbi, splitDensity } from '../src/main/lib/bundle'

const device = { abis: ['arm64-v8a', 'armeabi-v7a', 'armeabi'], densityDpi: 480 }
const entries = (names: string[]) => names.map((name) => ({ name, size: 1 }))

describe('bundle detection', () => {
  it('maps extensions', () => {
    expect(bundleKindFromName('App.APK')).toBe('apk')
    expect(bundleKindFromName('game.xapk')).toBe('xapk')
    expect(bundleKindFromName('x.apks')).toBe('apks')
    expect(bundleKindFromName('x.apkm')).toBe('apkm')
    expect(bundleKindFromName('x.zip')).toBeNull()
  })

  it('recognises split config names', () => {
    expect(splitAbi('split_config.arm64_v8a.apk')).toBe('arm64-v8a')
    expect(splitAbi('config.armeabi_v7a.apk')).toBe('armeabi-v7a')
    expect(splitAbi('base-x86_64.apk')).toBe('x86_64')
    expect(splitAbi('base.apk')).toBeNull()
    expect(splitDensity('split_config.xxhdpi.apk')).toBe(480)
    expect(splitDensity('base-xhdpi.apk')).toBe(320)
    expect(splitDensity('split_config.en.apk')).toBeNull()
  })
})

describe('selectSplits', () => {
  const all = [
    'base.apk',
    'split_config.arm64_v8a.apk',
    'split_config.armeabi_v7a.apk',
    'split_config.x86.apk',
    'split_config.xhdpi.apk',
    'split_config.xxhdpi.apk',
    'split_config.xxxhdpi.apk',
    'split_config.en.apk',
    'split_config.ar.apk',
    'split_feature_camera.apk'
  ]

  it('keeps base, features, languages and only the best ABI + density', () => {
    const chosen = selectSplits(all, device)
    expect(chosen[0]).toBe('base.apk')
    expect(chosen).toContain('split_config.arm64_v8a.apk')
    expect(chosen).not.toContain('split_config.armeabi_v7a.apk')
    expect(chosen).not.toContain('split_config.x86.apk')
    expect(chosen).toContain('split_config.xxhdpi.apk')
    expect(chosen).not.toContain('split_config.xhdpi.apk')
    expect(chosen).toContain('split_config.en.apk')
    expect(chosen).toContain('split_config.ar.apk')
    expect(chosen).toContain('split_feature_camera.apk')
  })

  it('falls back to the next supported ABI', () => {
    const chosen = selectSplits(['base.apk', 'split_config.armeabi_v7a.apk', 'split_config.x86.apk'], device)
    expect(chosen).toEqual(['base.apk', 'split_config.armeabi_v7a.apk'])
  })

  it('keeps everything without device info', () => {
    expect(selectSplits(all)).toHaveLength(all.length)
  })
})

describe('planBundle', () => {
  it('uses the XAPK manifest and maps OBB files', () => {
    const manifest = JSON.stringify({
      package_name: 'com.game.example',
      name: 'Example Game',
      version_name: '2.1',
      split_apks: [
        { file: 'com.game.example.apk', id: 'base' },
        { file: 'config.arm64_v8a.apk', id: 'config.arm64_v8a' }
      ],
      expansions: [{ file: 'Android/obb/com.game.example/main.21.com.game.example.obb', install_location: 'EXTERNAL_STORAGE', install_path: 'Android/obb/com.game.example/main.21.com.game.example.obb' }]
    })
    const plan = planBundle(
      'xapk',
      entries(['manifest.json', 'icon.png', 'com.game.example.apk', 'config.arm64_v8a.apk', 'Android/obb/com.game.example/main.21.com.game.example.obb']),
      manifest,
      device
    )
    expect(plan.packageName).toBe('com.game.example')
    expect(plan.appName).toBe('Example Game')
    expect(plan.apks).toEqual(['com.game.example.apk', 'config.arm64_v8a.apk'])
    expect(plan.obbs).toEqual([
      { entry: 'Android/obb/com.game.example/main.21.com.game.example.obb', devicePath: '/sdcard/Android/obb/com.game.example/main.21.com.game.example.obb' }
    ])
  })

  it('handles SAI-style .apks bundles', () => {
    const plan = planBundle('apks', entries(['base.apk', 'split_config.arm64_v8a.apk', 'split_config.x86_64.apk', 'meta.sai_v2.json']), undefined, device)
    expect(plan.apks).toEqual(['base.apk', 'split_config.arm64_v8a.apk'])
  })

  it('prefers bundletool splits/ over standalones/', () => {
    const plan = planBundle(
      'apks',
      entries(['toc.pb', 'splits/base-master.apk', 'splits/base-arm64_v8a.apk', 'splits/base-xxhdpi.apk', 'standalones/standalone-arm64_v8a.apk']),
      undefined,
      device
    )
    expect(plan.apks).toEqual(['splits/base-master.apk', 'splits/base-arm64_v8a.apk', 'splits/base-xxhdpi.apk'])
  })

  it('reads APKM info.json', () => {
    const plan = planBundle('apkm', entries(['info.json', 'icon.png', 'base.apk', 'split_config.en.apk']), JSON.stringify({ pname: 'com.x', app_name: 'X App', release_version: '9.0' }))
    expect(plan).toMatchObject({ packageName: 'com.x', appName: 'X App', versionName: '9.0', apks: ['base.apk', 'split_config.en.apk'] })
  })

  it('returns no APKs for empty/encrypted bundles', () => {
    expect(planBundle('apkm', entries(['info.json', 'data.bin'])).apks).toEqual([])
  })
})
