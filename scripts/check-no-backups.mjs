#!/usr/bin/env node
// Backup guard (F-105). Fails when a JSON file that looks like a SpendTrack backup is staged
// (--staged, used by .githooks/pre-commit) or tracked (default, used by `npm run verify` and CI).
// It reads blobs from the git index, so it checks exactly what a commit would contain.
// Output names offending paths and marker names only, never file contents.
// Exit codes: 0 clean, 1 backup found, 2 could not run (no git, not a repo, unreadable blob).
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { posix } from 'node:path'
import { fileURLToPath } from 'node:url'

// `\\*` before each quote also matches backups pasted inside JSON strings (\"expenses\":[),
// at any escaping depth.
export const MARKERS = [
  { name: 'expenses-array', pattern: /\\*"expenses\\*"\s*:\s*\[/ },
  { name: 'spendtrack-backup', pattern: /\\*"spendtrack\\*"\s*:\s*\\*"backup\\*"/ },
  { name: 'raw-browser-backup', pattern: /\\*"kind\\*"\s*:\s*\\*"raw-browser-backup\\*"/ },
]

const ALLOWED_ROOTS = ['src/demo/', 'e2e/']
const ALLOWED_FOLDERS = ['__tests__', 'fixtures']
const GITLINK_MODE = '160000'
const MAX_GIT_OUTPUT = 512 * 1024 * 1024
const USAGE = 'Usage: node scripts/check-no-backups.mjs [--staged]\n'

export function isJsonPath(path) {
  return /\.json$/i.test(path)
}

/** Repo-relative path → posix form without `./`, `//` or `..` detours. */
function normalizeRepoPath(path) {
  return posix.normalize(path.replace(/\\/g, '/')).replace(/^\.\//, '')
}

/** Test data may live under src/demo/, e2e/, or any __tests__/ or fixtures/ folder. */
export function isAllowedPath(path) {
  const normalized = normalizeRepoPath(path)
  if (normalized.startsWith('../') || normalized.startsWith('/') || /^[a-z]:/i.test(normalized)) {
    return false
  }
  if (ALLOWED_ROOTS.some((root) => normalized.startsWith(root))) return true
  const folders = normalized.split('/').slice(0, -1)
  return folders.some((folder) => ALLOWED_FOLDERS.includes(folder))
}

/** Bytes → text. Handles UTF-8 and UTF-16 (Windows PowerShell 5.1 writes UTF-16 LE). */
export function decodeText(content) {
  if (typeof content === 'string') return content
  const bytes = Buffer.from(content.buffer, content.byteOffset, content.byteLength)
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le')
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return utf16be(bytes.subarray(2))
  // UTF-8 JSON never contains a NUL byte; mostly-ASCII UTF-16 has one in every other byte.
  if (bytes.includes(0)) {
    let evenNuls = 0
    let oddNuls = 0
    for (let i = 0; i < Math.min(bytes.length, 4096); i += 1) {
      if (bytes[i] === 0) {
        if (i % 2 === 0) evenNuls += 1
        else oddNuls += 1
      }
    }
    if (oddNuls > evenNuls) return bytes.toString('utf16le')
    if (evenNuls > oddNuls) return utf16be(bytes)
  }
  return bytes.toString('utf8')
}

function utf16be(bytes) {
  const even = Buffer.from(bytes.subarray(0, bytes.length - (bytes.length % 2)))
  return even.swap16().toString('utf16le')
}

/** Names of the backup markers found in `text`, in MARKERS order. */
export function findMarkers(text) {
  return MARKERS.filter((marker) => marker.pattern.test(text)).map((marker) => marker.name)
}

/**
 * @param {Iterable<{ path: string, content: string | Uint8Array }>} entries
 * @returns {{ path: string, markers: string[] }[]} one entry per offending path, no contents
 */
export function findBackupViolations(entries) {
  const found = new Map()
  for (const { path, content } of entries) {
    if (!isJsonPath(path) || isAllowedPath(path)) continue
    const markers = findMarkers(decodeText(content))
    if (markers.length === 0) continue
    const seen = found.get(path) ?? new Set()
    for (const marker of markers) seen.add(marker)
    found.set(path, seen)
  }
  return [...found].map(([path, seen]) => ({
    path,
    markers: MARKERS.map((marker) => marker.name).filter((name) => seen.has(name)),
  }))
}

/** Parses `git ls-files --stage -z`: `<mode> <oid> <stage>\t<path>\0` per entry. */
export function parseLsFilesStage(output) {
  return splitNul(output).map((record) => {
    const tab = record.indexOf('\t')
    const meta = tab < 0 ? [] : record.slice(0, tab).split(' ')
    const [mode, oid, stage] = meta
    if (meta.length !== 3 || !mode || !oid || !stage || !/^\d$/.test(stage)) {
      throw new Error('unexpected git ls-files output')
    }
    return { mode, oid, stage: Number(stage), path: record.slice(tab + 1) }
  })
}

/** Parses `git cat-file --batch`: `<oid> <type> <size>\n<content>\n` per object. */
export function parseCatFileBatch(output) {
  const blobs = new Map()
  let position = 0
  while (position < output.length) {
    const newline = output.indexOf(0x0a, position)
    if (newline < 0) throw new Error('truncated git cat-file output')
    const header = output.subarray(position, newline).toString('utf8').split(' ')
    const [oid, type, sizeText] = header
    if (type === 'missing') throw new Error(`git object ${String(oid)} is missing`)
    const size = Number(sizeText)
    if (header.length !== 3 || !oid || !Number.isSafeInteger(size) || size < 0) {
      throw new Error('unexpected git cat-file output')
    }
    const start = newline + 1
    const end = start + size
    if (end > output.length) throw new Error('truncated git cat-file output')
    blobs.set(oid, output.subarray(start, end))
    position = end + 1
  }
  return blobs
}

function splitNul(output) {
  return output
    .toString('utf8')
    .split('\0')
    .filter((part) => part.length > 0)
}

function defaultRunGit(args, { cwd, input } = {}) {
  return execFileSync('git', args, {
    cwd,
    input,
    maxBuffer: MAX_GIT_OUTPUT,
    stdio: 'pipe',
    windowsHide: true,
  })
}

function scanRepo(mode, cwd, runGit) {
  // Every later command runs from the top level, so paths are repo-relative whatever the cwd.
  const top = runGit(['rev-parse', '--show-toplevel'], { cwd }).toString('utf8').trim()
  // --no-optional-locks: the pre-commit hook runs while `git commit` holds index.lock.
  const git = (args, input) => runGit(['--no-optional-locks', ...args], { cwd: top, input })
  let entries = parseLsFilesStage(git(['ls-files', '--stage', '-z'])).filter(
    (entry) => entry.mode !== GITLINK_MODE && isJsonPath(entry.path),
  )
  if (mode === 'staged') {
    const staged = new Set(
      splitNul(
        git([
          'diff',
          '--cached',
          '--name-only',
          '-z',
          '--no-renames',
          '--no-color',
          '--diff-filter=ACMRT',
        ]),
      ),
    )
    entries = entries.filter((entry) => entry.stage === 0 && staged.has(entry.path))
  }
  const toRead = entries.filter((entry) => !isAllowedPath(entry.path))
  const oids = [...new Set(toRead.map((entry) => entry.oid))]
  const blobs =
    oids.length === 0
      ? new Map()
      : parseCatFileBatch(git(['cat-file', '--batch'], `${oids.join('\n')}\n`))
  const violations = findBackupViolations(
    toRead.map((entry) => {
      const content = blobs.get(entry.oid)
      if (content === undefined) throw new Error(`git did not return ${entry.oid}`)
      return { path: entry.path, content }
    }),
  )
  return { violations, checked: new Set(entries.map((entry) => entry.path)).size }
}

/** Escapes control characters so a crafted file name cannot drive the terminal. */
function displayPath(path) {
  let shown = ''
  for (const char of path) {
    const code = char.codePointAt(0) ?? 0
    shown +=
      code < 0x20 || (code >= 0x7f && code <= 0x9f)
        ? `\\u${code.toString(16).padStart(4, '0')}`
        : char
  }
  return shown
}

function describeGitError(error) {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
    return 'git is not installed or not on PATH'
  }
  const stderr =
    error && typeof error === 'object' && 'stderr' in error && error.stderr
      ? String(error.stderr).trim().split(/\r?\n/)[0]
      : ''
  const message = error instanceof Error ? error.message.split(/\r?\n/)[0] : String(error)
  return (stderr || message || 'unknown error').replace(/^fatal:\s*/, '').slice(0, 200)
}

function formatViolations(violations, mode) {
  const files =
    violations.length === 1
      ? `1 ${mode} JSON file looks like a SpendTrack backup`
      : `${violations.length} ${mode} JSON files look like SpendTrack backups`
  const lines = [
    `check-no-backups: ${files}:`,
    '',
    ...violations.map(({ path, markers }) => `  ${displayPath(path)}  (${markers.join(', ')})`),
    '',
    'Personal backups must never reach the public repo. Move them outside it,',
    'e.g. OneDrive/NKB STUFF/Finance/Backups/, then run:',
    mode === 'staged' ? '  git restore --staged -- <path>' : '  git rm --cached -- <path>',
  ]
  if (mode !== 'staged') lines.push('If one was ever pushed, treat that data as public.')
  lines.push('Test data is allowed under src/demo/, e2e/, and any __tests__/ or fixtures/ folder.')
  return `${lines.join('\n')}\n`
}

/**
 * @param {string[]} argv
 * @param {{ cwd?: string, stdout?: { write(text: string): unknown }, stderr?: { write(text: string): unknown }, runGit?: (args: string[], options?: { cwd?: string, input?: string }) => Buffer }} [io]
 * @returns {0 | 1 | 2} exit code
 */
export function main(argv, io = {}) {
  const {
    cwd = process.cwd(),
    stdout = process.stdout,
    stderr = process.stderr,
    runGit = defaultRunGit,
  } = io
  let mode = 'tracked'
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      stdout.write(USAGE)
      return 0
    }
    if (arg !== '--staged') {
      stderr.write(`check-no-backups: unknown option ${arg}\n${USAGE}`)
      return 2
    }
    mode = 'staged'
  }

  let result
  try {
    result = scanRepo(mode, cwd, runGit)
  } catch (error) {
    stderr.write(
      `check-no-backups: could not read the repo through git: ${describeGitError(error)}\n`,
    )
    return 2
  }

  if (result.violations.length > 0) {
    stderr.write(formatViolations(result.violations, mode))
    return 1
  }
  if (mode === 'tracked') {
    const count = result.checked
    stdout.write(
      `check-no-backups: OK (${count} tracked JSON file${count === 1 ? '' : 's'}, no backups)\n`,
    )
  }
  return 0
}

function isExecutedDirectly() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    const self = realpathSync(fileURLToPath(import.meta.url))
    const invoked = realpathSync(entry)
    return process.platform === 'win32'
      ? self.toLowerCase() === invoked.toLowerCase()
      : self === invoked
  } catch {
    return false
  }
}

if (isExecutedDirectly()) {
  process.exitCode = main(process.argv.slice(2))
}
