// Brand-specific steps to enable Developer options and USB debugging.

export interface BrandGuide {
  id: string
  name: string
  skin: string
  devOptions: string[]
  usbDebugging: string[]
  extra?: { title: string; steps: string[] }[]
  wireless: string[]
}

export const BRANDS: BrandGuide[] = [
  {
    id: 'samsung',
    name: 'Samsung',
    skin: 'One UI',
    devOptions: ['Open Settings → About phone → Software information', 'Tap “Build number” 7 times', 'Enter your PIN if asked — you’ll see “Developer mode has been turned on”'],
    usbDebugging: ['Go back to Settings → Developer options (at the very bottom)', 'Turn on “USB debugging”', 'Tap OK on the warning'],
    extra: [
      {
        title: 'If nothing happens when you plug in',
        steps: ['Pull down the notification shade and tap the USB notification', 'Choose “Transferring files / Android Auto”', 'On Windows, install the Samsung USB Driver from Settings → USB drivers']
      }
    ],
    wireless: ['Settings → Developer options → Wireless debugging', 'Turn it on and tap “Pair device with QR code”']
  },
  {
    id: 'xiaomi',
    name: 'Xiaomi / Redmi / POCO',
    skin: 'HyperOS / MIUI',
    devOptions: ['Open Settings → About phone', 'Tap “OS version” (HyperOS) or “MIUI version” 7 times', 'Confirm with your lock-screen PIN'],
    usbDebugging: ['Go to Settings → Additional settings → Developer options', 'Turn on “USB debugging”', 'Accept the warning (you may need to wait 10 seconds)'],
    extra: [
      {
        title: 'Required on Xiaomi to install apps and tap the screen',
        steps: [
          'In Developer options, turn on “Install via USB”',
          'Also turn on “USB debugging (Security settings)”',
          'These need a Mi account and a SIM card inserted — this is a Xiaomi requirement'
        ]
      }
    ],
    wireless: ['Settings → Additional settings → Developer options → Wireless debugging', 'Turn it on and tap “Pair device with QR code”']
  },
  {
    id: 'oppo',
    name: 'OPPO / realme / OnePlus',
    skin: 'ColorOS / realme UI / OxygenOS',
    devOptions: ['Open Settings → About device (or About phone) → Version', 'Tap “Build number” 7 times', 'Enter your PIN if asked'],
    usbDebugging: ['Go to Settings → Additional settings (System settings on OnePlus) → Developer options', 'Turn on “USB debugging”'],
    extra: [
      {
        title: 'To install apps over USB',
        steps: ['In Developer options, also turn on “Disable permission monitoring” if installs fail', 'Keep your phone unlocked while installing']
      }
    ],
    wireless: ['Developer options → Wireless debugging', 'Turn it on and tap “Pair device with QR code”']
  },
  {
    id: 'pixel',
    name: 'Google Pixel',
    skin: 'Pixel / stock Android',
    devOptions: ['Open Settings → About phone', 'Scroll down and tap “Build number” 7 times', 'Enter your PIN — “You are now a developer!”'],
    usbDebugging: ['Go to Settings → System → Developer options', 'Turn on “USB debugging”'],
    wireless: ['Settings → System → Developer options → Wireless debugging', 'Turn it on and tap “Pair device with QR code”']
  },
  {
    id: 'motorola',
    name: 'Motorola',
    skin: 'My UX',
    devOptions: ['Open Settings → About phone', 'Tap “Build number” 7 times', 'Enter your PIN if asked'],
    usbDebugging: ['Go to Settings → System → Developer options', 'Turn on “USB debugging”'],
    wireless: ['Settings → System → Developer options → Wireless debugging', 'Turn it on and tap “Pair device with QR code”']
  },
  {
    id: 'other',
    name: 'Other Android',
    skin: 'Any brand',
    devOptions: ['Open Settings → About phone (sometimes under “Software information”)', 'Find “Build number” and tap it 7 times', 'Enter your PIN if asked'],
    usbDebugging: ['Find “Developer options” (often under System or Additional settings)', 'Turn on “USB debugging”'],
    wireless: ['Developer options → Wireless debugging (Android 11 or newer)', 'Turn it on and tap “Pair device with QR code”']
  }
]
