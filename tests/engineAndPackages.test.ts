import { describe, expect, it } from 'vitest'
import { classifyPackage, lookupPackage, prettifyPackageName } from '../src/main/data/packageDb'
import { marketingName } from '../src/main/lib/deviceNames'
import { parsePlatformToolsManifest, parseSha256Sums, pickScrcpyAsset, platformToolsLatestUrl } from '../src/main/lib/engineManifest'

const XML = `<?xml version="1.0"?>
<sdk:sdk-repository>
  <remotePackage path="platform-tools">
    <revision><major>38</major><minor>0</minor><micro>0</micro></revision>
    <channelRef ref="channel-3"/>
    <archives>
      <archive><complete><size>1</size><checksum type="sha1">${'a'.repeat(40)}</checksum><url>platform-tools_r38.0.0-rc1-win.zip</url></complete><host-os>windows</host-os></archive>
    </archives>
  </remotePackage>
  <remotePackage path="platform-tools">
    <revision><major>37</major><minor>0</minor><micro>3</micro></revision>
    <channelRef ref="channel-0"/>
    <archives>
      <archive><complete><size>9571024</size><checksum type="sha1">e1579b288a7ae4e9bc28dedec6a154d78b3c04ed</checksum><url>platform-tools_r37.0.3-linux.zip</url></complete><host-os>linux</host-os></archive>
      <archive><complete><size>8188601</size><checksum type="sha1">7fea85bc18d0480bc81d3603952d666f49496e5a</checksum><url>platform-tools_r37.0.3-win.zip</url></complete><host-os>windows</host-os></archive>
    </archives>
  </remotePackage>
  <remotePackage path="emulator"><revision><major>1</major></revision></remotePackage>
</sdk:sdk-repository>`

describe('engine manifest', () => {
  it('picks the stable platform-tools archive for the OS', () => {
    expect(parsePlatformToolsManifest(XML, 'windows')).toEqual({
      version: '37.0.3',
      url: 'https://dl.google.com/android/repository/platform-tools_r37.0.3-win.zip',
      sha1: '7fea85bc18d0480bc81d3603952d666f49496e5a',
      size: 8188601
    })
    expect(parsePlatformToolsManifest(XML, 'linux')?.url).toMatch(/linux\.zip$/)
    expect(parsePlatformToolsManifest('<x/>', 'windows')).toBeNull()
  })

  it('has a latest fallback URL', () => {
    expect(platformToolsLatestUrl('win32')).toBe('https://dl.google.com/android/repository/platform-tools-latest-windows.zip')
    expect(platformToolsLatestUrl('darwin')).toMatch(/darwin\.zip$/)
  })

  it('picks the right scrcpy asset', () => {
    const assets = [
      'scrcpy-linux-x86_64-v5.0.1.tar.gz',
      'scrcpy-macos-aarch64-v5.0.1.tar.gz',
      'scrcpy-macos-x86_64-v5.0.1.tar.gz',
      'scrcpy-server-v5.0.1',
      'scrcpy-win32-v5.0.1.zip',
      'scrcpy-win64-v5.0.1.zip',
      'scrcpy-winarm64-v5.0.1.zip',
      'SHA256SUMS.txt'
    ].map((name) => ({ name, browser_download_url: `https://example.invalid/${name}` }))
    expect(pickScrcpyAsset(assets, 'win32', 'x64')?.name).toBe('scrcpy-win64-v5.0.1.zip')
    expect(pickScrcpyAsset(assets, 'win32', 'arm64')?.name).toBe('scrcpy-winarm64-v5.0.1.zip')
    expect(pickScrcpyAsset(assets, 'darwin', 'arm64')?.name).toBe('scrcpy-macos-aarch64-v5.0.1.tar.gz')
    expect(pickScrcpyAsset(assets, 'linux', 'x64')?.name).toBe('scrcpy-linux-x86_64-v5.0.1.tar.gz')
  })

  it('parses SHA256SUMS.txt', () => {
    const h = 'f'.repeat(64)
    expect(parseSha256Sums(`${h}  scrcpy-win64-v5.0.1.zip\n${'0'.repeat(64)} *other.tar.gz\n`)).toEqual({
      'scrcpy-win64-v5.0.1.zip': h,
      'other.tar.gz': '0'.repeat(64)
    })
  })
})

describe('package safety dictionary', () => {
  it('knows common bloatware and core packages', () => {
    expect(lookupPackage('com.miui.msa.global')).toMatchObject({ name: 'MIUI System Ads', safety: 'safe' })
    expect(lookupPackage('com.facebook.appmanager')?.safety).toBe('safe')
    expect(lookupPackage('com.android.systemui')?.safety).toBe('core')
    expect(lookupPackage('com.google.android.gms')?.safety).toBe('core')
  })

  it('classifies unknown packages sensibly', () => {
    expect(classifyPackage('com.android.providers.media.module', true).safety).toBe('core')
    expect(classifyPackage('com.samsung.android.overlay.something', true).safety).toBe('core')
    expect(classifyPackage('com.vendor.random.tool', true).safety).toBe('caution')
    expect(classifyPackage('com.vendor.random.tool', false).safety).toBe('safe')
  })

  it('makes readable fallback names', () => {
    expect(prettifyPackageName('com.example.photo_editor')).toBe('Photo Editor')
    expect(prettifyPackageName('com.samsung.android.app.tips')).toBe('Tips')
    expect(prettifyPackageName('com.foo.myCoolApp')).toBe('My Cool App')
  })
})

describe('marketing names', () => {
  it('prefers ROM market-name properties', () => {
    expect(marketingName({ 'ro.product.marketname': 'Redmi Note 13 Pro', 'ro.product.model': '23117RA68G' })).toBe('Redmi Note 13 Pro')
  })
  it('maps Samsung model codes', () => {
    expect(marketingName({ 'ro.product.model': 'SM-S928B' })).toBe('Galaxy S24 Ultra')
    expect(marketingName({ 'ro.product.model': 'SM-A556E' })).toBe('Galaxy A55')
    expect(marketingName({ 'ro.product.model': 'Pixel 8' })).toBeUndefined()
  })
})
