// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MARKERS,
  decodeText,
  findBackupViolations,
  findMarkers,
  isAllowedPath,
  isJsonPath,
  main,
  parseCatFileBatch,
  parseLsFilesStage,
} from './check-no-backups.mjs'

const SCRIPT = fileURLToPath(new URL('./check-no-backups.mjs', import.meta.url))
const ROOT = fileURLToPath(new URL('..', import.meta.url))

// Invented data only. The canary must never appear in the guard's output.
const CANARY = 'CANARY-7f3a-kopi-peng'
const v4Backup = JSON.stringify(
  {
    version: '4.0',
    exportDate: '2026-10-19T12:00:00',
    expenses: [
      {
        id: 'e1',
        itemName: CANARY,
        amount: 4.5,
        category: 'Food',
        date: '2026-10-19T12:00:00',
        notes: `${CANARY} notes`,
      },
    ],
    budgets: {},
  },
  null,
  2,
)
const v5Export = JSON.stringify({ spendtrack: 'backup', version: '5.0', x5: { min: 5 } })
const rescueDump = JSON.stringify({
  app: 'SpendTrack',
  kind: 'raw-browser-backup',
  version: 1,
  exportedAt: '2026-10-19T04:00:00.000Z',
  keys: { 'spendtrack:expenses': JSON.stringify([{ id: 'e1', itemName: CANARY }]) },
})
const escapedBackup = JSON.stringify({ note: 'pasted', payload: JSON.stringify({ expenses: [] }) })
const doubleEscapedExport = JSON.stringify({
  outer: JSON.stringify({ inner: JSON.stringify({ spendtrack: 'backup' }) }),
})
const unrelatedJson = JSON.stringify({ name: 'config', expensesTotal: [1], spendtrack: 'export' })

const markerNames = MARKERS.map((marker) => marker.name)

describe('MARKERS', () => {
  it('names the three backup shapes', () => {
    expect(markerNames).toEqual(['expenses-array', 'spendtrack-backup', 'raw-browser-backup'])
  })
})

describe('isJsonPath', () => {
  it('matches .json in any case and nothing else', () => {
    expect(isJsonPath('a/b.json')).toBe(true)
    expect(isJsonPath('EXPORT.JSON')).toBe(true)
    expect(isJsonPath('notes/backup.json.txt')).toBe(false)
    expect(isJsonPath('notes/backup.jsonc')).toBe(false)
    expect(isJsonPath('notes/json')).toBe(false)
  })
})

describe('isAllowedPath', () => {
  it.each([
    'src/demo/seed.json',
    'src/demo/nested/deep/seed.json',
    'e2e/import.json',
    'e2e/fixtures/v4.json',
    '__tests__/backup.json',
    'src/lib/__tests__/backup.json',
    'fixtures/backup.json',
    'src/data/core/fixtures/relay.json',
    './src/demo/seed.json',
    'src//demo/seed.json',
  ])('allows %s', (path) => {
    expect(isAllowedPath(path)).toBe(true)
  })

  it.each([
    'backup.json',
    'notes/my.json',
    'supabase/spendtrack-backup-2026-01-01.json',
    'src/demox/seed.json',
    'src/demo',
    'src/demo.json',
    'demo/seed.json',
    'e2e-old/import.json',
    'tools/e2e/import.json',
    'src/__tests__x/backup.json',
    'src/lib/__tests__',
    'docs/fixtures.json',
    'src/Demo/seed.json',
    'E2E/import.json',
    'src/demo/../notes/my.json',
    '../src/demo/seed.json',
    '/abs/fixtures/backup.json',
  ])('rejects %s', (path) => {
    expect(isAllowedPath(path)).toBe(false)
  })

  it('handles Windows-style separators and spaces', () => {
    expect(isAllowedPath('src\\demo\\Demo Data.json')).toBe(true)
    expect(isAllowedPath('src\\features\\ledger\\__tests__\\sample export.json')).toBe(true)
    expect(isAllowedPath('e2e\\fixtures\\iphone import.json')).toBe(true)
    expect(isAllowedPath('My Notes\\spendtrack backup.json')).toBe(false)
    expect(isAllowedPath('NKB STUFF\\Finance\\Backups\\backup.json')).toBe(false)
    expect(isAllowedPath('C:\\Users\\Shade\\NKB STUFF\\fixtures\\backup.json')).toBe(false)
  })
})

describe('findMarkers', () => {
  it('finds a v4 backup, minified or pretty', () => {
    expect(findMarkers(v4Backup)).toEqual(['expenses-array'])
    expect(findMarkers('{"version":"4.0","expenses":[]}')).toEqual(['expenses-array'])
    expect(findMarkers('{\n  "expenses" :\n  [\n')).toEqual(['expenses-array'])
  })

  it('finds the v5 export marker, alone or with expenses', () => {
    expect(findMarkers(v5Export)).toEqual(['spendtrack-backup'])
    expect(findMarkers('{"spendtrack" : "backup","expenses":[]}')).toEqual([
      'expenses-array',
      'spendtrack-backup',
    ])
  })

  it('finds the raw browser rescue dump', () => {
    expect(findMarkers(rescueDump)).toEqual(['raw-browser-backup'])
  })

  it('finds escaped and double-escaped variants embedded in JSON strings', () => {
    expect(escapedBackup).toContain('\\"expenses\\":[')
    expect(findMarkers(escapedBackup)).toEqual(['expenses-array'])
    expect(doubleEscapedExport).toContain('\\\\\\"spendtrack\\\\\\"')
    expect(findMarkers(doubleEscapedExport)).toEqual(['spendtrack-backup'])
    expect(findMarkers(JSON.stringify({ s: rescueDump }))).toEqual(['raw-browser-backup'])
  })

  it('ignores unrelated JSON', () => {
    expect(findMarkers(unrelatedJson)).toEqual([])
    expect(findMarkers('{"expenses":5,"myexpenses":[1]}')).toEqual([])
    expect(findMarkers('{"kind":"browser-backup","spendtrack":"export"}')).toEqual([])
    expect(findMarkers('{"name":"spendtrack","private":true}')).toEqual([])
    expect(findMarkers('')).toEqual([])
  })
})

describe('decodeText', () => {
  const sample = '{"expenses":[]}'

  it('passes strings through and decodes UTF-8 bytes', () => {
    expect(decodeText(sample)).toBe(sample)
    expect(decodeText(Buffer.from(sample, 'utf8'))).toBe(sample)
    expect(decodeText(new TextEncoder().encode(sample))).toBe(sample)
    expect(decodeText(Buffer.from(`\ufeff${sample}`, 'utf8'))).toContain(sample)
  })

  it('decodes UTF-16 LE and BE, with or without a BOM (Windows PowerShell output)', () => {
    const le = Buffer.from(sample, 'utf16le')
    const be = Buffer.from(le).swap16()
    expect(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), le]))).toBe(sample)
    expect(decodeText(Buffer.concat([Buffer.from([0xfe, 0xff]), be]))).toBe(sample)
    expect(decodeText(le)).toBe(sample)
    expect(decodeText(be)).toBe(sample)
  })
})

describe('findBackupViolations', () => {
  it('reports each offending JSON path with its marker names', () => {
    const result = findBackupViolations([
      { path: 'notes/my.json', content: v4Backup },
      { path: 'config.json', content: unrelatedJson },
      { path: 'exports/v5.json', content: Buffer.from(v5Export) },
      { path: 'rescue/raw.json', content: new TextEncoder().encode(rescueDump) },
      { path: 'pasted.json', content: escapedBackup },
    ])
    expect(result).toEqual([
      { path: 'notes/my.json', markers: ['expenses-array'] },
      { path: 'exports/v5.json', markers: ['spendtrack-backup'] },
      { path: 'rescue/raw.json', markers: ['raw-browser-backup'] },
      { path: 'pasted.json', markers: ['expenses-array'] },
    ])
  })

  it('skips allowed folders and non-JSON files', () => {
    expect(
      findBackupViolations([
        { path: 'src/demo/seed.json', content: v4Backup },
        { path: 'e2e/import.json', content: v5Export },
        { path: 'src/lib/__tests__/raw.json', content: rescueDump },
        { path: 'x/fixtures/v4.json', content: v4Backup },
        { path: 'notes/backup.txt', content: v4Backup },
        { path: 'notes/backup.json.bak', content: v4Backup },
      ]),
    ).toEqual([])
  })

  it('treats an upper-case .JSON extension and Windows paths with spaces as JSON', () => {
    expect(
      findBackupViolations([
        { path: 'My Notes\\Spend Export.JSON', content: v4Backup },
        { path: 'src\\demo\\Demo Data.json', content: v4Backup },
      ]),
    ).toEqual([{ path: 'My Notes\\Spend Export.JSON', markers: ['expenses-array'] }])
  })

  it('merges repeated entries for one path (conflict stages) in marker order', () => {
    expect(
      findBackupViolations([
        { path: 'notes/a.json', content: v5Export },
        { path: 'notes/a.json', content: v4Backup },
        { path: 'notes/a.json', content: v5Export },
      ]),
    ).toEqual([{ path: 'notes/a.json', markers: ['expenses-array', 'spendtrack-backup'] }])
  })

  it('never returns file contents', () => {
    const result = findBackupViolations([{ path: 'notes/my.json', content: v4Backup }])
    expect(JSON.stringify(result)).not.toContain(CANARY)
  })
})

describe('parseLsFilesStage', () => {
  it('parses NUL-separated stage records, including spaces and tabs in paths', () => {
    const oidA = 'a'.repeat(40)
    const oidB = 'b'.repeat(40)
    const raw = Buffer.from(
      `100644 ${oidA} 0\tMy Notes/spend export.json\0` +
        `100755 ${oidB} 2\tweird\tname.json\0` +
        `160000 ${oidA} 0\tvendor/sub\0`,
    )
    expect(parseLsFilesStage(raw)).toEqual([
      { mode: '100644', oid: oidA, stage: 0, path: 'My Notes/spend export.json' },
      { mode: '100755', oid: oidB, stage: 2, path: 'weird\tname.json' },
      { mode: '160000', oid: oidA, stage: 0, path: 'vendor/sub' },
    ])
  })

  it('returns no records for an empty index and rejects malformed output', () => {
    expect(parseLsFilesStage(Buffer.alloc(0))).toEqual([])
    expect(() => parseLsFilesStage(Buffer.from('garbage\0'))).toThrow(/ls-files/)
  })
})

describe('parseCatFileBatch', () => {
  it('splits blobs by their declared size, binary-safe', () => {
    const oidA = 'a'.repeat(40)
    const oidB = 'b'.repeat(40)
    const blobA = Buffer.from('{"a":1}\n{"b":\n2}')
    const blobB = Buffer.from([0x00, 0x0a, 0xff, 0x0a])
    const raw = Buffer.concat([
      Buffer.from(`${oidA} blob ${blobA.length}\n`),
      blobA,
      Buffer.from('\n'),
      Buffer.from(`${oidB} blob ${blobB.length}\n`),
      blobB,
      Buffer.from('\n'),
    ])
    const parsed = parseCatFileBatch(raw)
    expect(parsed.get(oidA)?.toString()).toBe(blobA.toString())
    expect(Buffer.compare(parsed.get(oidB) ?? Buffer.alloc(0), blobB)).toBe(0)
  })

  it('throws on a missing object or truncated output', () => {
    expect(() => parseCatFileBatch(Buffer.from(`${'c'.repeat(40)} missing\n`))).toThrow(/missing/)
    expect(() => parseCatFileBatch(Buffer.from(`${'c'.repeat(40)} blob 99\n{}`))).toThrow(
      /truncated/,
    )
  })
})

function captureIo(runGit) {
  const out = { stdout: '', stderr: '' }
  return {
    out,
    io: {
      cwd: ROOT,
      runGit,
      stdout: { write: (text) => (out.stdout += text) },
      stderr: { write: (text) => (out.stderr += text) },
    },
  }
}

describe('main (injected git)', () => {
  it('prints usage for --help and exits 0', () => {
    const { out, io } = captureIo(() => Buffer.alloc(0))
    expect(main(['--help'], io)).toBe(0)
    expect(out.stdout).toMatch(/Usage: .*check-no-backups\.mjs \[--staged\]/)
  })

  it('exits 2 with usage on an unknown flag', () => {
    const { out, io } = captureIo(() => Buffer.alloc(0))
    expect(main(['--stagd'], io)).toBe(2)
    expect(out.stderr).toMatch(/unknown option --stagd/)
    expect(out.stderr).toMatch(/Usage:/)
  })

  it('exits 2 when git is not installed', () => {
    const { out, io } = captureIo(() => {
      throw Object.assign(new Error('spawnSync git ENOENT'), { code: 'ENOENT' })
    })
    expect(main([], io)).toBe(2)
    expect(out.stderr).toMatch(/git is not installed/)
  })

  it('exits 2 (fail closed) when a blob cannot be read', () => {
    const oid = 'd'.repeat(40)
    const { out, io } = captureIo((args) => {
      if (args.includes('rev-parse')) return Buffer.from(`${ROOT}\n`)
      if (args.includes('ls-files')) return Buffer.from(`100644 ${oid} 0\tnotes/my.json\0`)
      if (args.includes('cat-file')) return Buffer.from(`${oid} missing\n`)
      throw new Error(`unexpected git ${args.join(' ')}`)
    })
    expect(main([], io)).toBe(2)
    expect(out.stderr).toMatch(/could not read/)
  })

  it('escapes control characters in reported paths and still hides contents', () => {
    const oid = 'f'.repeat(40)
    const blob = Buffer.from(v4Backup)
    const { out, io } = captureIo((args) => {
      if (args.includes('rev-parse')) return Buffer.from(`${ROOT}\n`)
      if (args.includes('ls-files'))
        return Buffer.from(`100644 ${oid} 0\tnotes/\u001b[2Jevil.json\0`)
      if (args.includes('cat-file')) {
        return Buffer.concat([Buffer.from(`${oid} blob ${blob.length}\n`), blob, Buffer.from('\n')])
      }
      throw new Error(`unexpected git ${args.join(' ')}`)
    })
    expect(main([], io)).toBe(1)
    expect(out.stderr).toContain('1 tracked JSON file looks like a SpendTrack backup:')
    expect(out.stderr).toContain('  notes/\\u001b[2Jevil.json  (expenses-array)')
    expect(out.stderr).not.toContain('\u001b')
    expect(out.stderr + out.stdout).not.toContain(CANARY)
  })

  it('skips gitlinks and allowed paths without reading them', () => {
    const oid = 'e'.repeat(40)
    const seen = []
    const { out, io } = captureIo((args) => {
      seen.push(args.find((arg) => !arg.startsWith('-')))
      if (args.includes('rev-parse')) return Buffer.from(`${ROOT}\n`)
      if (args.includes('ls-files')) {
        return Buffer.from(
          `160000 ${oid} 0\tvendor/backup.json\0` + `100644 ${oid} 0\tsrc/demo/seed.json\0`,
        )
      }
      throw new Error(`unexpected git ${args.join(' ')}`)
    })
    expect(main([], io)).toBe(0)
    expect(seen).toEqual(['rev-parse', 'ls-files'])
    expect(out.stdout).toMatch(/OK/)
  })
})

// ─── Integration: a real git repo under the OS temp dir ─────────────────────

let tmpRoot = ''
let env = {}

function hermeticEnv(gitconfig, ceiling) {
  const base = {}
  for (const [key, value] of Object.entries(process.env)) {
    // Drop GIT_DIR / GIT_INDEX_FILE etc. so a test run inside a hook never touches the outer repo.
    if (value !== undefined && !key.toUpperCase().startsWith('GIT_')) base[key] = value
  }
  const pathKey = Object.keys(base).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
  base[pathKey] = [dirname(process.execPath), base[pathKey]].filter(Boolean).join(delimiter)
  return {
    ...base,
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: ceiling,
    GIT_TERMINAL_PROMPT: '0',
  }
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout
}

function makeRepo(name) {
  const dir = join(tmpRoot, name)
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q'])
  return dir
}

function put(repo, relativePath, content) {
  const file = join(repo, ...relativePath.split('/'))
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

function guard(cwd, args = []) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
  })
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

function expectNoContents(result) {
  const all = result.stdout + result.stderr
  expect(all).not.toContain(CANARY)
  expect(all).not.toContain('itemName')
  expect(all).not.toContain('4.5')
}

describe('CLI in a temp git repo', { timeout: 60_000 }, () => {
  beforeAll(() => {
    tmpRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'spendtrack guard ')))
    const gitconfig = join(tmpRoot, 'gitconfig')
    writeFileSync(
      gitconfig,
      '[user]\n\tname = Guard Test\n\temail = guard@example.invalid\n' +
        '[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n',
    )
    env = hermeticEnv(gitconfig, tmpRoot)
  })

  afterAll(() => {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('--staged exits 1 for a staged backup outside the allowed folders, naming only path and marker', () => {
    const repo = makeRepo('staged leak')
    put(repo, 'My Notes/my backup.json', v4Backup)
    git(repo, ['add', '-A'])
    const result = guard(repo, ['--staged'])
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^ {2}My Notes\/my backup\.json {2}\(expenses-array\)$/m)
    expect(result.stderr).toMatch(/OneDrive\/NKB STUFF\/Finance\/Backups\//)
    expectNoContents(result)
  })

  it('--staged catches the v5 marker, escaped variants and the rescue dump', () => {
    const repo = makeRepo('staged markers')
    put(repo, 'exports/v5.json', v5Export)
    put(repo, 'pasted/escaped.json', doubleEscapedExport)
    put(repo, 'rescue/raw.json', rescueDump)
    git(repo, ['add', '-A'])
    const result = guard(repo, ['--staged'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('3 staged JSON files look like SpendTrack backups:')
    expect(result.stderr).toContain('git restore --staged -- <path>')
    expect(result.stderr).toContain('exports/v5.json  (spendtrack-backup)')
    expect(result.stderr).toContain('pasted/escaped.json  (spendtrack-backup)')
    expect(result.stderr).toContain('rescue/raw.json  (raw-browser-backup)')
    expectNoContents(result)
  })

  it('--staged exits 0 for the same backup inside each allowed folder', () => {
    const repo = makeRepo('allowed')
    put(repo, 'src/demo/seed.json', v4Backup)
    put(repo, 'e2e/import.json', v5Export)
    put(repo, 'x/__tests__/raw.json', rescueDump)
    put(repo, 'x/fixtures/v4.json', v4Backup)
    git(repo, ['add', '-A'])
    const result = guard(repo, ['--staged'])
    expect(result.code).toBe(0)
    expectNoContents(result)
  })

  it('--staged exits 0 for unrelated JSON and for nothing staged', () => {
    const repo = makeRepo('unrelated')
    expect(guard(repo, ['--staged']).code).toBe(0)
    put(repo, 'config.json', unrelatedJson)
    put(repo, 'notes/backup.txt', v4Backup)
    git(repo, ['add', '-A'])
    expect(guard(repo, ['--staged']).code).toBe(0)
  })

  it('--staged reads the staged blob, not the working copy', () => {
    const repo = makeRepo('index vs disk')
    put(repo, 'notes/a.json', '{"theme":"dark"}')
    git(repo, ['add', '-A'])
    put(repo, 'notes/a.json', v4Backup)
    expect(guard(repo, ['--staged']).code).toBe(0)

    git(repo, ['add', '-A'])
    put(repo, 'notes/a.json', '{"theme":"dark"}')
    const result = guard(repo, ['--staged'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('notes/a.json  (expenses-array)')
  })

  it('--staged catches a backup moved out of an allowed folder, from any subdirectory', () => {
    const repo = makeRepo('rename out')
    put(repo, 'src/demo/seed.json', v4Backup)
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'seed'])
    mkdirSync(join(repo, 'notes'))
    git(repo, ['mv', 'src/demo/seed.json', 'notes/seed.json'])
    const result = guard(join(repo, 'src'), ['--staged'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('notes/seed.json  (expenses-array)')
  })

  it('tracked mode exits 1 for a committed backup and 0 for a clean tree', () => {
    const repo = makeRepo('tracked')
    put(repo, 'config.json', unrelatedJson)
    put(repo, 'src/demo/seed.json', v4Backup)
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'clean'])
    const clean = guard(repo)
    expect(clean.code).toBe(0)
    expect(clean.stdout).toMatch(/OK \(2 tracked JSON files/)

    put(repo, 'supabase/old export.json', v4Backup)
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'leak'])
    const leak = guard(repo)
    expect(leak.code).toBe(1)
    expect(leak.stderr).toContain('1 tracked JSON file looks like a SpendTrack backup:')
    expect(leak.stderr).toContain('supabase/old export.json  (expenses-array)')
    expect(leak.stderr).toMatch(/git rm --cached/)
    expectNoContents(leak)

    // --staged judges only this commit's changes; the committed file is tracked mode's job.
    put(repo, 'config.json', '{"theme":"light"}')
    git(repo, ['add', '-A'])
    expect(guard(repo, ['--staged']).code).toBe(0)
    expect(guard(repo).code).toBe(1)
  })

  it('exits 2 outside a git repo and on an unknown flag', () => {
    const dir = join(tmpRoot, 'not a repo')
    mkdirSync(dir, { recursive: true })
    put(dir, 'notes/my.json', v4Backup)
    const outside = guard(dir, ['--staged'])
    expect(outside.code).toBe(2)
    expect(outside.stderr).toMatch(/not a git repository/i)
    expectNoContents(outside)

    expect(guard(makeRepo('bad flag'), ['--all']).code).toBe(2)
  })

  it('the opt-in pre-commit hook blocks backup commits (also with -a) and allows clean ones', () => {
    const repo = makeRepo('hooked')
    put(repo, 'scripts/check-no-backups.mjs', readFileSync(SCRIPT))
    put(repo, '.githooks/pre-commit', readFileSync(join(ROOT, '.githooks', 'pre-commit')))
    chmodSync(join(repo, '.githooks', 'pre-commit'), 0o755)
    git(repo, ['config', 'core.hooksPath', '.githooks'])
    put(repo, 'config.json', unrelatedJson)
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'clean'])
    const head = git(repo, ['rev-parse', 'HEAD']).trim()

    put(repo, 'notes/my backup.json', v4Backup)
    git(repo, ['add', '-A'])
    const commit = (args) =>
      spawnSync('git', ['commit', '-q', ...args], { cwd: repo, env, encoding: 'utf8' })
    const blocked = commit(['-m', 'leak'])
    expect(blocked.status).not.toBe(0)
    expect(blocked.stderr).toContain('notes/my backup.json  (expenses-array)')
    expect(blocked.stderr).not.toContain(CANARY)
    expect(git(repo, ['rev-parse', 'HEAD']).trim()).toBe(head)

    git(repo, ['rm', '-q', '--cached', '--', 'notes/my backup.json'])
    put(repo, 'config.json', v5Export)
    const blockedAll = commit(['-a', '-m', 'leak via -a'])
    expect(blockedAll.status).not.toBe(0)
    expect(blockedAll.stderr).toContain('config.json  (spendtrack-backup)')
    expect(git(repo, ['rev-parse', 'HEAD']).trim()).toBe(head)

    put(repo, 'config.json', '{"theme":"light"}')
    expect(commit(['-a', '-m', 'clean edit']).status).toBe(0)
  })

  it('the hook needs no node when no JSON file is staged, and says so when one is', () => {
    const repo = makeRepo('hook without node')
    put(repo, '.githooks/pre-commit', readFileSync(join(ROOT, '.githooks', 'pre-commit')))
    chmodSync(join(repo, '.githooks', 'pre-commit'), 0o755)
    git(repo, ['config', 'core.hooksPath', '.githooks'])
    // A PATH with git and the shell tools but no node (a GUI client, a fresh machine).
    const exe = process.platform === 'win32' ? 'node.exe' : 'node'
    const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
    const withoutNode = String(env[pathKey] ?? '')
      .split(delimiter)
      .filter((dir) => dir !== '' && !existsSync(join(dir, exe)))
      .join(delimiter)
    const commit = (message) =>
      spawnSync('git', ['commit', '-q', '-m', message], {
        cwd: repo,
        env: { ...env, [pathKey]: withoutNode },
        encoding: 'utf8',
        windowsHide: true,
      })

    put(repo, 'notes/todo.md', 'buy kopi')
    put(repo, 'src/app.ts', 'export {}')
    git(repo, ['add', '-A'])
    const plain = commit('no json')
    expect(plain.stderr).toBe('')
    expect(plain.status).toBe(0)

    put(repo, 'Config Files/settings.JSON', unrelatedJson)
    git(repo, ['add', '-A'])
    const json = commit('json staged')
    expect(json.status).not.toBe(0)
    expect(json.stderr).toMatch(/node is not on PATH/)
  })

  it('the hook sees a JSON path whose type changes (a symlink restaged as a backup file)', () => {
    const repo = makeRepo('hook type change')
    // data/export.json is committed as a symlink (mode 120000) before the hook is installed.
    put(repo, 'link.txt', 'export-target.json')
    const link = git(repo, ['hash-object', '-w', 'link.txt']).trim()
    git(repo, ['update-index', '--add', '--cacheinfo', `120000,${link},data/export.json`])
    git(repo, ['commit', '-q', '-m', 'link'])
    put(repo, '.githooks/pre-commit', readFileSync(join(ROOT, '.githooks', 'pre-commit')))
    chmodSync(join(repo, '.githooks', 'pre-commit'), 0o755)
    put(repo, 'scripts/check-no-backups.mjs', readFileSync(SCRIPT))
    git(repo, ['config', 'core.hooksPath', '.githooks'])

    // Restaged as a regular file holding a backup, which git lists as T. Staged explicitly:
    // git on Windows (core.symlinks false) keeps a symlink's mode on `add`.
    put(repo, 'data/export.json', v4Backup)
    const file = git(repo, ['hash-object', '-w', 'data/export.json']).trim()
    git(repo, ['update-index', '--cacheinfo', `100644,${file},data/export.json`])
    expect(git(repo, ['diff', '--cached', '--name-status'])).toMatch(/^T\tdata\/export\.json$/m)

    // The guard's staged scan lists T, so the hook must not skip it: the guard runs and refuses.
    const commit = spawnSync('git', ['commit', '-q', '-m', 'type change'], {
      cwd: repo,
      env,
      encoding: 'utf8',
      windowsHide: true,
    })
    expect(commit.status).not.toBe(0)
    expect(`${commit.stdout}${commit.stderr}`).toContain('data/export.json')
    expect(git(repo, ['log', '--format=%s'])).toBe('link\n')
  })

  it('npm run hooks:install points git at .githooks and makes the hook executable', () => {
    const repo = makeRepo('install hooks')
    const hook = join(repo, '.githooks', 'pre-commit')
    put(repo, '.githooks/pre-commit', readFileSync(join(ROOT, '.githooks', 'pre-commit')))
    // A clone where the exec bit was lost (committed from Windows without --chmod=+x).
    chmodSync(hook, 0o644)
    const { scripts } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    const install = spawnSync(scripts['hooks:install'], {
      cwd: repo,
      env,
      shell: true,
      encoding: 'utf8',
      windowsHide: true,
    })
    expect(install.status).toBe(0)
    expect(git(repo, ['config', '--local', 'core.hooksPath']).trim()).toBe('.githooks')
    // Windows has no exec bit (Git for Windows runs any hook that starts with #!).
    if (process.platform !== 'win32') expect(statSync(hook).mode & 0o111).toBe(0o111)
  })

  it('.gitignore ignores renamed backups without ignoring tracked project files', () => {
    const repo = makeRepo('ignore rules')
    put(repo, '.gitignore', readFileSync(join(ROOT, '.gitignore')))
    const mustIgnore = [
      'backup.json',
      'my-backup-2026.json',
      'spendtrack-export.json',
      'spendtrack-backup-2026-01-01.json',
      'supabase/spendtrack-backup-2026-01-01.json',
      'spendtrack-backup-raw-2026-10-19-1200.json',
      'notes/old-backup.json',
    ]
    const mustKeep = [
      'package.json',
      'package-lock.json',
      'tsconfig.json',
      'tsconfig.node.json',
      'vercel.json',
      '.prettierrc.json',
      'public/manifest.json',
      'src/demo/seed.json',
    ]
    const result = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], {
      cwd: repo,
      env,
      encoding: 'utf8',
      input: `${[...mustIgnore, ...mustKeep].join('\n')}\n`,
    })
    const ignored = new Set(result.stdout.split(/\r?\n/).filter(Boolean))
    expect(mustIgnore.filter((path) => !ignored.has(path))).toEqual([])
    expect(mustKeep.filter((path) => ignored.has(path))).toEqual([])
  })
})
