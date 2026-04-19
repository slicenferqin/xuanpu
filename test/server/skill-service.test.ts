import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

// ─── electron/app mock ──────────────────────────────────────────────────────
// The skill service resolves the bundled root from `app.getAppPath()`; we
// point it at a scratch directory so we can drop fake skills in.
const { appMock } = vi.hoisted(() => ({
  appMock: {
    isPackaged: false,
    getAppPath: vi.fn(() => '/tmp'),
    getPath: vi.fn((_name: string) => '/tmp')
  }
}))

vi.mock('electron', () => ({
  app: appMock,
  shell: { showItemInFolder: vi.fn() }
}))

vi.mock('../../src/main/services/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

// Stub the DB module so hub-service never loads better-sqlite3 during tests.
// The tests here never need a real DB — the bundled hub is resolved
// in-memory, and the "unknown hub" case only needs the lookup to return null.
vi.mock('../../src/main/db/database', () => ({
  getDatabase: () => ({
    getDb: () => ({
      prepare: () => ({
        get: () => null,
        all: () => [],
        run: () => ({ changes: 0 })
      })
    })
  })
}))

import {
  installBuiltInSkill,
  installSkill,
  listBuiltInSkills,
  listHubSkills,
  listInstalledSkills,
  parseSkillFrontmatter,
  readSkillContent,
  resolveScopeDir,
  uninstallSkill
} from '../../src/main/services/skill-service'
import { BUNDLED_HUB_ID } from '../../src/main/services/hub-service'

let sandbox: string

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(tmpdir(), 'skill-service-'))
  appMock.isPackaged = false
  appMock.getAppPath.mockReturnValue(sandbox)
  appMock.getPath.mockReturnValue(sandbox)

  // Lay out a fake bundled skill inside `resources/built-in-skills/`.
  const builtIn = path.join(sandbox, 'resources', 'built-in-skills', 'sample')
  await fs.mkdir(builtIn, { recursive: true })
  await fs.writeFile(
    path.join(builtIn, 'SKILL.md'),
    [
      '---',
      'name: sample',
      'description: A tiny sample skill used in tests.',
      'version: 0.1.0',
      'tags:',
      '  - demo',
      '  - test',
      '---',
      '',
      '# Sample',
      'Hello world.'
    ].join('\n')
  )
  await fs.writeFile(path.join(builtIn, 'reference.txt'), 'companion file')
})

afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true })
})

describe('parseSkillFrontmatter', () => {
  test('parses flat scalar fields', () => {
    const fm = parseSkillFrontmatter(
      ['---', 'name: foo', 'description: A foo skill', 'version: 1.2.3', '---', 'body'].join(
        '\n'
      )
    )
    expect(fm).toEqual({
      name: 'foo',
      description: 'A foo skill',
      version: '1.2.3',
      author: undefined,
      tags: undefined,
      icon: undefined
    })
  })

  test('parses block-style tag list', () => {
    const fm = parseSkillFrontmatter(
      ['---', 'name: foo', 'tags:', '  - a', '  - b', '  - c', '---'].join('\n')
    )
    expect(fm.tags).toEqual(['a', 'b', 'c'])
  })

  test('parses inline list', () => {
    const fm = parseSkillFrontmatter(
      ['---', 'name: foo', 'tags: [a, "b", c]', '---'].join('\n')
    )
    expect(fm.tags).toEqual(['a', 'b', 'c'])
  })

  test('parses multi-line block scalar (description: |)', () => {
    const fm = parseSkillFrontmatter(
      [
        '---',
        'name: ctx-offload',
        'description: |',
        '  Context Offloading - long output to file.',
        '',
        '  - saves tokens',
        '  - keeps context lean',
        'version: 1.0.0',
        '---'
      ].join('\n')
    )
    expect(fm.name).toBe('ctx-offload')
    expect(fm.description).toContain('Context Offloading')
    expect(fm.description).toContain('saves tokens')
    expect(fm.version).toBe('1.0.0')
  })

  test('rejects missing name', () => {
    expect(() =>
      parseSkillFrontmatter(['---', 'description: no name', '---'].join('\n'))
    ).toThrow(/required field: name/)
  })

  test('rejects missing frontmatter block', () => {
    expect(() => parseSkillFrontmatter('# just markdown')).toThrow(/frontmatter/)
  })
})

describe('listBuiltInSkills (back-compat) and listHubSkills(BUNDLED)', () => {
  test('back-compat alias enumerates bundled skills', async () => {
    const skills = await listBuiltInSkills()
    expect(skills).toHaveLength(1)
    expect(skills[0].id).toBe('sample')
    expect(skills[0].hubId).toBe(BUNDLED_HUB_ID)
    expect(skills[0].frontmatter.tags).toEqual(['demo', 'test'])
    expect(skills[0].sizeBytes).toBeGreaterThan(0)
  })

  test('listHubSkills(BUNDLED) returns the same data', async () => {
    const skills = await listHubSkills(BUNDLED_HUB_ID)
    expect(skills).toHaveLength(1)
    expect(skills[0].id).toBe('sample')
  })

  test('returns empty when bundled directory missing', async () => {
    await fs.rm(path.join(sandbox, 'resources'), { recursive: true, force: true })
    const skills = await listBuiltInSkills()
    expect(skills).toEqual([])
  })
})

describe('install / uninstall roundtrip', () => {
  test('installs to project scope and lists it back', async () => {
    const project = path.join(sandbox, 'project')
    await fs.mkdir(project, { recursive: true })

    const res = await installSkill(
      { hubId: BUNDLED_HUB_ID, skillId: 'sample' },
      { kind: 'project', path: project }
    )
    expect(res.success).toBe(true)
    expect(res.installPath).toBe(path.join(project, '.claude', 'skills', 'sample'))

    const stat = await fs.stat(path.join(res.installPath!, 'SKILL.md'))
    expect(stat.isFile()).toBe(true)
    const ref = await fs.stat(path.join(res.installPath!, 'reference.txt'))
    expect(ref.isFile()).toBe(true)

    const installed = await listInstalledSkills({ kind: 'project', path: project })
    expect(installed.map((s) => s.id)).toEqual(['sample'])

    const un = await uninstallSkill('sample', { kind: 'project', path: project })
    expect(un.success).toBe(true)

    const after = await listInstalledSkills({ kind: 'project', path: project })
    expect(after).toEqual([])
  })

  test('refuses to overwrite an existing install by default', async () => {
    const project = path.join(sandbox, 'proj2')
    await fs.mkdir(project, { recursive: true })

    await installSkill(
      { hubId: BUNDLED_HUB_ID, skillId: 'sample' },
      { kind: 'project', path: project }
    )
    const second = await installSkill(
      { hubId: BUNDLED_HUB_ID, skillId: 'sample' },
      { kind: 'project', path: project }
    )
    expect(second.success).toBe(false)
    expect(second.error).toBe('already_installed')

    const forced = await installSkill(
      { hubId: BUNDLED_HUB_ID, skillId: 'sample' },
      { kind: 'project', path: project },
      { overwrite: true }
    )
    expect(forced.success).toBe(true)
  })

  test('back-compat installBuiltInSkill still works', async () => {
    const project = path.join(sandbox, 'proj3')
    await fs.mkdir(project, { recursive: true })
    const res = await installBuiltInSkill('sample', { kind: 'project', path: project })
    expect(res.success).toBe(true)
  })

  test('rejects unknown skill id', async () => {
    const res = await installSkill(
      { hubId: BUNDLED_HUB_ID, skillId: 'does-not-exist' },
      { kind: 'user' }
    )
    expect(res.success).toBe(false)
    expect(res.error).toBe('source_not_found')
  })

  test('rejects unknown hub id', async () => {
    const res = await installSkill(
      { hubId: 'no-such-hub-id', skillId: 'sample' },
      { kind: 'user' }
    )
    expect(res.success).toBe(false)
    expect(res.error).toBe('source_not_found')
  })

  test('rejects scoped install without a path', async () => {
    const res = await installSkill(
      { hubId: BUNDLED_HUB_ID, skillId: 'sample' },
      { kind: 'project', path: '' }
    )
    expect(res.success).toBe(false)
    expect(res.error).toBe('invalid_scope')
  })

  test('uninstall reports not_installed when missing', async () => {
    const res = await uninstallSkill('sample', {
      kind: 'project',
      path: path.join(sandbox, 'nowhere')
    })
    expect(res.success).toBe(false)
    expect(res.error).toBe('not_installed')
  })
})

describe('resolveScopeDir', () => {
  test('user scope resolves to ~/.claude/skills', () => {
    const dir = resolveScopeDir({ kind: 'user' })
    expect(dir.endsWith(path.join('.claude', 'skills'))).toBe(true)
  })

  test('project scope joins path with .claude/skills', () => {
    const dir = resolveScopeDir({ kind: 'project', path: '/some/proj' })
    expect(dir).toBe(path.join('/some/proj', '.claude', 'skills'))
  })
})

describe('readSkillContent', () => {
  test('reads SKILL.md content', async () => {
    const target = path.join(sandbox, 'resources', 'built-in-skills', 'sample', 'SKILL.md')
    const res = await readSkillContent(target)
    expect(res.success).toBe(true)
    expect(res.content).toContain('# Sample')
  })

  test('refuses files that are not SKILL.md', async () => {
    const target = path.join(
      sandbox,
      'resources',
      'built-in-skills',
      'sample',
      'reference.txt'
    )
    const res = await readSkillContent(target)
    expect(res.success).toBe(false)
    expect(res.error).toContain('SKILL.md')
  })
})
