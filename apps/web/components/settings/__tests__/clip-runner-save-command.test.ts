import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SAVE_COMMAND } from '../clip-runner-save-command'

const FAKE_TOKEN = 'ffcr_FAKE-TOKEN-FOR-TESTS-ONLY'
const roots: string[] = []

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'save-command-'))
  roots.push(root)
  const bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'pbpaste'), `#!/bin/sh\nprintf '%s' '${FAKE_TOKEN}'\n`, { mode: 0o755 })
  const home = join(root, 'home')
  mkdirSync(home)
  return { home, config: join(home, '.config', 'freeframe'), bin }
}

function run(home: string, bin: string) {
  return spawnSync('/bin/sh', ['-c', SAVE_COMMAND], {
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` } as unknown as NodeJS.ProcessEnv,
    encoding: 'utf8',
  })
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    spawnSync('chmod', ['-R', 'u+rwx', root])
    rmSync(root, { recursive: true, force: true })
  }
})

describe('clip runner save command', () => {
  it('is one line with no &&', () => {
    expect(SAVE_COMMAND).not.toContain('&&')
    expect(SAVE_COMMAND).not.toContain('\n')
  })

  it('creates the folder and a private file when nothing exists yet', () => {
    const { home, config, bin } = setup()
    const result = run(home, bin)
    expect(result.status).toBe(0)
    const file = join(config, 'clip-runner.token')
    expect(readFileSync(file, 'utf8')).toBe(FAKE_TOKEN)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('replaces an existing world-readable file with a private one', () => {
    const { home, config, bin } = setup()
    mkdirSync(config, { recursive: true })
    const file = join(config, 'clip-runner.token')
    writeFileSync(file, 'old', { mode: 0o644 })
    chmodSync(file, 0o644)
    expect(run(home, bin).status).toBe(0)
    expect(readFileSync(file, 'utf8')).toBe(FAKE_TOKEN)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it.skipIf(process.getuid?.() === 0)('does not overwrite an existing file when it cannot be removed', () => {
    const { home, config, bin } = setup()
    mkdirSync(config, { recursive: true })
    const file = join(config, 'clip-runner.token')
    writeFileSync(file, 'old', { mode: 0o644 })
    chmodSync(file, 0o644)
    chmodSync(config, 0o500) // the folder forbids unlinking, the old file stays writable
    const result = run(home, bin)
    chmodSync(config, 0o700)
    expect(result.status).not.toBe(0)
    expect(readFileSync(file, 'utf8')).toBe('old')
    expect(existsSync(file)).toBe(true)
  })
})
