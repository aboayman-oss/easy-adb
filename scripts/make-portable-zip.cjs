// Zips the portable build (dist/portable/win-unpacked) into dist/Easy-ADB-Portable-<version>.zip
// with everything inside an "Easy ADB" folder, so "Extract here" gives one tidy folder.
// Uses Windows' built-in tar.exe (bsdtar), which writes standard zip files.
const { execFileSync } = require('node:child_process')
const { cpSync, existsSync, rmSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const { version } = require(join(root, 'package.json'))
const unpacked = join(root, 'dist', 'portable', 'win-unpacked')
const staging = join(root, 'dist', 'portable', 'staging')
const zip = join(root, 'dist', `Easy-ADB-Portable-${version}.zip`)

if (!existsSync(join(unpacked, 'portable.txt'))) {
  console.error('Portable build not found (or missing portable.txt). Run electron-builder with electron-builder.portable.yml first.')
  process.exit(1)
}

rmSync(staging, { recursive: true, force: true })
rmSync(zip, { force: true })
cpSync(unpacked, join(staging, 'Easy ADB'), { recursive: true })

const tar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
execFileSync(tar, ['-a', '-c', '-f', zip, '-C', staging, 'Easy ADB'], { stdio: 'inherit' })
rmSync(staging, { recursive: true, force: true })
console.log(`Portable zip: ${zip}`)
