# Easy ADB — Product Spec & Architecture

> Everyday Android power tools, with zero setup. Easy ADB wraps the useful, safe parts of
> Android Debug Bridge (`adb`) and `scrcpy` in a friendly desktop app for people who have never
> opened a terminal.

---

## 1. Environment audit (build machine)

| Tool | Found | Decision |
|---|---|---|
| OS | Windows 10 Pro 19045 (x64) | Primary target: Windows. macOS and Linux supported in the engine layer (download URLs, archive types and `chmod` handled per-OS). |
| Node.js | v22.21 / npm 10.9 | ✔ |
| Rust / Cargo | **not installed** | Tauri is ruled out. |
| Python | 3.14 | Not needed. |
| Network | dl.google.com ✔, GitHub API ✔, npm ✔ | Auto-provisioning is possible. |

**Chosen stack: Electron + React + TypeScript + Tailwind CSS**, built with `electron-vite`
(separate main / preload / renderer bundles), tested with `vitest`, packaged with
`electron-builder`.

---

## 2. ADB / scrcpy capability audit

### ✅ Include & simplify (casual-user value, safe)

| Capability | Under the hood | Easy ADB surface |
|---|---|---|
| Device detection | `adb track-devices -l` (push-based, no polling) | Live Connection Hub with friendly states |
| Device info | `getprop`, `dumpsys battery`, `/proc/meminfo`, `df`, `/sys/class/power_supply/*` | Dashboard: model, Android version, battery, storage, RAM, health |
| File browse / transfer | ADB **sync protocol** spoken directly over the adb server socket (`LIST`/`STAT`/`SEND`/`RECV`) | Visual file explorer, breadcrumbs, shortcuts, drag & drop, progress + speed + cancel |
| Create folder / rename / delete to trash | `mkdir -p`, `mv` (quoted) | Explorer context actions. Deletion is single-item, confirmed, and limited to user storage (`/sdcard`) |
| App list | `pm list packages -f -U` (+ `-s`, `-3`, `-d`, `-u`) | App Manager with names, icons, badges |
| Debloat (per-user, reversible) | `pm uninstall -k --user 0`, `pm disable-user --user 0` | “Remove” / “Turn off” buttons |
| Restore removed apps | `cmd package install-existing`, `pm enable` | “Removed apps” tab with one-click Restore |
| Install APK / split bundles | `adb install`, `adb install-multiple`, OBB push | Drag-and-drop installer for `.apk` `.xapk` `.apks` `.apkm` |
| Uninstall user apps | `pm uninstall` | App Manager |
| Screen mirroring | `scrcpy` | One big “Mirror my screen” button + simple toggles & presets |
| Screenshot | `adb exec-out screencap -p` | “Screenshot to PC” |
| Screen recording | `screenrecord` + `SIGINT` + pull | “Record screen” (up to 3 min) |
| Animation speed | `settings put global *_animation_scale` | Normal / Snappy / Instant presets |
| Display size | `wm density` / `wm density reset` | Slider with 10-second auto-revert safety timer |
| Reboot | `reboot`, `reboot recovery`, `reboot -p` | Safe Power Menu with plain explanations |
| Wireless debugging | `adb pair`, `adb connect`, mDNS `_adb-tls-pairing._tcp` / `_adb-tls-connect._tcp` | QR-code pairing, manual code fallback, remembered devices |

### 🚫 Exclude or hide (dangerous or developer-only)

| Capability | Why it is excluded |
|---|---|
| `fastboot flash`, `adb reboot bootloader` / `fastboot`, `oem unlock`, `adb sideload` | Can brick the phone or wipe data. Not exposed at all. |
| `adb root`, `adb remount`, `adb disable-verity` | Requires rooted / dev builds; can break boot. |
| Raw `adb shell` / terminal | Unbounded power; not exposed. All commands are fixed templates with escaped arguments. |
| Raw `logcat` streams | Developer noise. The Activity Log shows Easy ADB’s own commands instead. |
| `rm -rf`, recursive deletes, wiping `/data` | Only single-item delete inside `/sdcard`, always confirmed. |
| Uninstalling **Core System** packages | Locked by default (bootloop risk). Can only be unlocked from an “I understand the risk” confirmation, and even then is per-user + restorable. |
| `adb backup` / `restore` | Deprecated since Android 12, unreliable; replaced by “copy my photos/files to PC”. |
| `pm clear` on system apps, `settings put secure` arbitrary values | Data loss / soft-brick risk. |
| Port forwarding / reverse, `jdwp`, `am instrument`, `bugreport` | Developer-only. |

---

## 3. Architecture

```
┌──────────────────────────── Renderer (React + Tailwind) ────────────────────────────┐
│  Screens: Setup · Connect hub (USB wizard / Wireless QR) · Dashboard · Files · Apps  │
│           Installer · Mirror & Capture · Tweaks · Settings · Activity Log drawer     │
│  State: zustand stores (devices, engine, transfers, toasts, log)                     │
└──────────────────────▲───────────────────────────────┬───────────────────────────────┘
                       │ typed events                  │ typed invoke()
              ┌────────┴──────── preload (contextBridge, no Node in renderer) ─────────┐
┌─────────────┴───────────────────────── Main process ─────────────────────────────────┐
│ engine/      provisioner (detect → download → extract → chmod → verify, updates)     │
│ adb/         runner (spawn, no shell, timeouts, cancel, activity log)                │
│              tracker (track-devices, auto-restart)    host (adb server socket client) │
│              sync (LIST/STAT/SEND/RECV with progress) files (transfer queue)          │
│              deviceInfo · packages · apkMeta (AXML/ARSC label+icon) · installer       │
│              mirror (scrcpy) · capture · tweaks · power · wireless (QR + mDNS)        │
│ platform/    drivers (Windows USB driver check / install helper)                      │
│ lib/         pure, unit-tested logic: escaping, parsers, QR payload, error translator │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

### Key design decisions

1. **Zero setup.** On first launch the engine provisioner checks `<userData>/engine/`. Missing
   pieces are downloaded from the official sources only:
   - Platform-tools: `https://dl.google.com/android/repository/platform-tools-latest-{windows,darwin,linux}.zip`
   - scrcpy: latest release asset from `github.com/Genymobile/scrcpy` (Windows zip, Linux / macOS tarball)

   Progress is streamed to a friendly setup screen. After extraction the binaries are
   `chmod 0755`’d (POSIX) and verified by executing `adb version` / `scrcpy --version`.
   Settings → *Check for engine updates* compares the installed revision with Google’s
   repository manifest and scrcpy’s latest GitHub release.
2. **No shell on the host.** Every process is spawned with an argument array (`shell: false`),
   so Windows paths with spaces, Arabic or emoji are passed byte-exact.
3. **Escaping on the device.** `adb shell` concatenates its arguments and hands them to the
   device’s `sh`. Every dynamic value is wrapped with a POSIX single-quote escaper
   (`'it'\''s'`) — unit tested with spaces, quotes, `$`, backticks, newlines and Unicode.
4. **File transfers speak the ADB sync protocol directly** over the adb server socket instead
   of parsing `adb push/pull` console output (which hides progress when not on a TTY). This
   gives exact byte progress, speed, real cancellation and no path-escaping at all.
5. **Package names → human names and icons.** A bundled dictionary covers popular apps and
   well-known bloatware (with a safety rating and a one-line description). For everything
   else, Easy ADB reads only the needed byte ranges of the APK on the device (ZIP central
   directory → `AndroidManifest.xml` + `resources.arsc` + best launcher icon), parses the
   binary XML / resource table, and caches label + icon on disk keyed by version.
6. **Safety ratings.** Every package gets one of **Safe to remove**, **Use caution**, or
   **Core system** (locked). Removal is always `--user 0` (the app stays in the system image),
   so every removal is reversible from the *Removed apps* tab.
7. **Resilience.** The device tracker restarts with back-off; every long operation is bound to
   a device serial and fails gracefully on disconnect; child processes (scrcpy, screenrecord,
   tracker) are tracked and killed on quit; temp folders for split-APK extraction are removed in
   `finally` blocks.
8. **Transparency without fear.** The main UI never shows stack traces. A collapsible
   *Activity Log* drawer lists each command, its duration and outcome.

### Wireless QR pairing flow (Android 11+)

1. Easy ADB creates `S = "easyadb-<random>"` and a random `P`, and renders the QR payload
   `WIFI:T:ADB;S:<S>;P:<P>;;` (special characters `\ ; , : "` escaped).
2. The phone scans it in *Developer options → Wireless debugging → Pair device with QR code*
   and starts advertising `<S>._adb-tls-pairing._tcp` on the LAN.
3. Easy ADB discovers it two ways in parallel: its own mDNS browser and `adb mdns services`.
4. It runs `adb pair <ip>:<port> <P>`, then waits for `_adb-tls-connect._tcp` from the same
   host and runs `adb connect <ip>:<port>`. The device is saved to *Remembered Wi-Fi devices*.

---

## 4. Feature breakdown (screens)

| Screen | Contents |
|---|---|
| **Engine setup** | “Preparing Easy ADB engine… 65%” with friendly steps; retry on failure. |
| **Connect hub** | No device → setup cards (USB / Wi-Fi). Unauthorized → illustrated “tap Allow” card. Offline → reconnect tips. Brand-specific USB debugging wizard (Samsung, Xiaomi/Redmi/POCO, OPPO/realme/OnePlus, Pixel, Motorola, other). Windows driver check. |
| **Dashboard** | Model, brand, Android version, battery % + health + temperature + voltage + cycles, storage bar, RAM, quick actions (mirror, screenshot, record, files, install). |
| **Files** | Shortcut sidebar (Camera, Screenshots, Downloads, Documents, WhatsApp media, Internal storage), breadcrumbs, list with icons/sizes/dates, multi-select, drag from desktop to upload, download to PC, new folder, rename, delete (confirmed), transfer tray with progress/speed/cancel. |
| **Apps** | Search, filters (My apps / System / All), safety badges, Remove / Turn off / Uninstall, *Removed apps* tab with Restore. |
| **Install** | Drop zone for `.apk .xapk .apks .apkm`, split detection, OBB copy for XAPK, plain-language errors. |
| **Mirror & capture** | Big mirror button, quality presets (Smooth / Balanced / Data saver), phone screen “Keep on / Turn off” (keep on by default), “Keep awake”, screenshot to PC, record screen. |
| **Tweaks** | Animation speed presets, display size slider with 10 s auto-revert, power menu. |
| **Settings** | Theme (system / light / dark), download folder, engine versions + update check, USB driver helper (Windows), remembered Wi-Fi devices. |

---

## 5. Quality gates

- `npm run typecheck` — zero TypeScript errors (main, preload, renderer).
- `npm test` — vitest suites for escaping, QR payload, track-devices / getprop / dumpsys /
  meminfo / df / package parsers, install-error translation, bundle manifest parsing, binary
  XML / resource table parsing, sync protocol framing.
- `npm run build` — production bundles; `npm run dist` — installers via electron-builder.
