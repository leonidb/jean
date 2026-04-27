/**
 * Terminal layout — open a multi-pane layout for a dojo's agents.
 *
 * Platform-agnostic at the CLI level. The CLI builds a LayoutSpec from the
 * dojo state; the platform-specific opener turns that spec into actual
 * terminal-app commands (osascript, etc.).
 *
 * Today only iTerm2-on-macOS is implemented. To add a new terminal:
 *   1. Write a function `openWith<Name>(spec): {exitCode, stderr}` that
 *      drives the target app (gnome-terminal via dbus, kitty via @-arg,
 *      Konsole via dbus, alacritty via subcommand args, etc.).
 *   2. Add a clause in `pickTerminalOpener()` that returns it when the
 *      detected environment matches.
 *   3. Optionally: a small env hint (TERM_PROGRAM, $KITTY_WINDOW_ID, etc.)
 *      for narrower disambiguation if multiple are plausible.
 *
 * The LayoutSpec intentionally describes "what to open" not "how to lay it
 * out in pixels" — each impl picks its own split orientation as native to
 * that terminal.
 */

// ── Spec ──────────────────────────────────────────────────────────

export type LayoutSpec = {
  /** Absolute dojo root; each pane will `cd` here before running its command. */
  dojoRoot: string
  /** Infra pane (always first; the calling shell typically becomes this one). */
  infra: { command: string }
  /** Sensei pane (optional — middle column when present). */
  sensei?: { name: string; command: string }
  /** Worker panes (stacked vertically in the right column). */
  workers: Array<{ name: string; command: string }>
}

export type OpenResult = { exitCode: number; stderr: string }
export type TerminalOpener = {
  /** Human-readable name shown in success/error messages ("iTerm2 (macOS)"). */
  name: string
  open: (spec: LayoutSpec) => OpenResult
}

// ── Dispatch ──────────────────────────────────────────────────────

export function pickTerminalOpener(): TerminalOpener | null {
  if (process.platform === 'darwin') {
    return { name: 'iTerm2 (macOS)', open: openWithITerm2 }
  }
  // TODO: linux variants — gnome-terminal, kitty, konsole, alacritty, tmux
  // (last is universal but the user's preference is to stay native).
  return null
}

// ── iTerm2 (macOS) ────────────────────────────────────────────────

function openWithITerm2(spec: LayoutSpec): OpenResult {
  const script = buildITermLayoutScript(spec)
  const result = Bun.spawnSync(['osascript', '-'], {
    stdin: new TextEncoder().encode(script),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { exitCode: result.exitCode ?? -1, stderr: result.stderr.toString() }
}

/**
 * Generate the AppleScript that lays out the *current* iTerm tab.
 *
 * Layout: 3 columns side-by-side, with the right column split horizontally
 * for each worker after the first.
 *
 *   ┌─────────┬─────────┬─────────┐
 *   │         │         │ worker1 │
 *   │  infra  │ sensei  ├─────────┤
 *   │         │         │ worker2 │
 *   │         │         ├─────────┤
 *   │         │         │ worker3 │
 *   └─────────┴─────────┴─────────┘
 *
 * The current session of the current tab becomes `infra` — the calling shell
 * is "consumed" and infra runs there. Splits stack workers off the previous
 * worker pane, which means panes get progressively smaller; for ≤3 workers
 * this is fine, more will need the user to drag dividers.
 */
export function buildITermLayoutScript(spec: LayoutSpec): string {
  const cmd = (sub: string) => `cd '${spec.dojoRoot}' && ${sub}`
  const lines: string[] = []
  lines.push('tell application "iTerm"')
  lines.push('  set s_infra to current session of current tab of current window')
  lines.push(`  tell s_infra to write text ${aplString(cmd(spec.infra.command))}`)

  let workersAnchor: string | null = null
  if (spec.sensei) {
    lines.push('  set s_sensei to (tell s_infra to split vertically with default profile)')
    lines.push(`  tell s_sensei to write text ${aplString(cmd(spec.sensei.command))}`)
    if (spec.workers.length > 0) {
      lines.push('  set w0 to (tell s_sensei to split vertically with default profile)')
      lines.push(`  tell w0 to write text ${aplString(cmd(spec.workers[0]!.command))}`)
      workersAnchor = 'w0'
    }
  } else if (spec.workers.length > 0) {
    lines.push('  set w0 to (tell s_infra to split vertically with default profile)')
    lines.push(`  tell w0 to write text ${aplString(cmd(spec.workers[0]!.command))}`)
    workersAnchor = 'w0'
  }

  if (workersAnchor) {
    let prev = workersAnchor
    for (let i = 1; i < spec.workers.length; i++) {
      lines.push(`  set w${i} to (tell ${prev} to split horizontally with default profile)`)
      lines.push(`  tell w${i} to write text ${aplString(cmd(spec.workers[i]!.command))}`)
      prev = `w${i}`
    }
  }

  lines.push('end tell')
  return lines.join('\n')
}

/** Quote a string for embedding in AppleScript (double-quoted, escape ", \\). */
function aplString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}
