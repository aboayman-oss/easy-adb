// How adb commands are shown in the Activity Log.

/** Human-readable command line, with secrets (Wi-Fi pairing codes) hidden. */
export function describeCommand(args: string[]): string {
  const pair = args.indexOf('pair')
  // adb pair <host:port> <code>: the code is a one-time secret, keep it out of the log.
  const shown = pair >= 0 ? args.map((a, i) => (i === pair + 2 ? '••••••' : a)) : args
  return 'adb ' + shown.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' ')
}
