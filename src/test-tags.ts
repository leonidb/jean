import { describe, test } from 'bun:test'

/**
 * Platform tags. A tagged suite skips itself and the runner counts it as a
 * skip, so a local run and a CI run agree about what was checked.
 */

/** Tag: macos-only. Needs a facility that exists only on macOS. */
export const macosOnly = {
  describe: describe.skipIf(process.platform !== 'darwin'),
  test: test.skipIf(process.platform !== 'darwin'),
}
