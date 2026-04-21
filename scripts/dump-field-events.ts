#!/usr/bin/env node
/**
 * Dump field events from the local Xuanpu DB as a markdown timeline.
 *
 * Phase 21 acceptance tool. See docs/prd/phase-21-field-events.md §8.
 *
 * Usage:
 *   pnpm tsx scripts/dump-field-events.ts --minutes 30 [--worktree <id>] [--project <id>]
 *
 * Notes:
 *   - Reads the same DB that the running app writes to (~/.xuanpu/xuanpu.db
 *     by default; override via $XUANPU_DB_PATH).
 *   - Stand-alone: does NOT load Electron modules so it can run from a plain
 *     `pnpm tsx` invocation alongside or instead of a running app.
 *   - Uses WAL-mode reads, so it is safe to run while the app is open.
 */
import Database from 'better-sqlite3'
import { homedir } from 'node:os'
import { join } from 'node:path'

interface Args {
  minutes: number
  worktreeId?: string
  projectId?: string
  dbPath: string
}

function parseArgs(argv: string[]): Args {
  let minutes = 30
  let worktreeId: string | undefined
  let projectId: string | undefined
  let dbPath = process.env.XUANPU_DB_PATH ?? join(homedir(), '.xuanpu', 'xuanpu.db')

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--minutes':
      case '-m':
        minutes = Number.parseInt(argv[++i] ?? '', 10)
        if (!Number.isFinite(minutes) || minutes <= 0) {
          throw new Error(`invalid --minutes: ${argv[i]}`)
        }
        break
      case '--worktree':
      case '-w':
        worktreeId = argv[++i]
        break
      case '--project':
      case '-p':
        projectId = argv[++i]
        break
      case '--db':
        dbPath = argv[++i]
        break
      case '--help':
      case '-h':
        printHelp()
        process.exit(0)
        break
      default:
        throw new Error(`unknown argument: ${arg}`)
    }
  }

  return { minutes, worktreeId, projectId, dbPath }
}

function printHelp(): void {
  console.log(`Usage: pnpm tsx scripts/dump-field-events.ts [options]

Options:
  -m, --minutes <n>     Lookback window in minutes (default: 30)
  -w, --worktree <id>   Filter to a single worktree id
  -p, --project <id>    Filter to a single project id
      --db <path>       DB file path (default: $XUANPU_DB_PATH or ~/.xuanpu/xuanpu.db)
  -h, --help            Show this help
`)
}

interface Row {
  seq: number
  id: string
  timestamp: number
  worktree_id: string | null
  project_id: string | null
  session_id: string | null
  type: string
  related_event_id: string | null
  payload_json: string
}

interface WorktreeMeta {
  id: string
  name: string
  branch_name: string
}

function fetchEvents(db: Database.Database, args: Args): Row[] {
  const since = Date.now() - args.minutes * 60_000
  const clauses = ['timestamp >= ?']
  const params: unknown[] = [since]

  if (args.worktreeId !== undefined) {
    clauses.push('worktree_id = ?')
    params.push(args.worktreeId)
  }
  if (args.projectId !== undefined) {
    clauses.push('project_id = ?')
    params.push(args.projectId)
  }

  const sql = `SELECT seq, id, timestamp, worktree_id, project_id, session_id,
                      type, related_event_id, payload_json
               FROM field_events
               WHERE ${clauses.join(' AND ')}
               ORDER BY timestamp ASC, seq ASC`
  return db.prepare(sql).all(...params) as Row[]
}

function fetchWorktreeMeta(db: Database.Database, ids: string[]): Map<string, WorktreeMeta> {
  const meta = new Map<string, WorktreeMeta>()
  if (ids.length === 0) return meta
  const placeholders = ids.map(() => '?').join(', ')
  const rows = db
    .prepare(`SELECT id, name, branch_name FROM worktrees WHERE id IN (${placeholders})`)
    .all(...ids) as WorktreeMeta[]
  for (const row of rows) meta.set(row.id, row)
  return meta
}

function formatTime(ms: number): string {
  const d = new Date(ms)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + '…'
}

function formatRow(row: Row): string {
  const time = formatTime(row.timestamp)
  let payload: unknown
  try {
    payload = JSON.parse(row.payload_json)
  } catch {
    payload = null
  }

  switch (row.type) {
    case 'worktree.switch': {
      const p = payload as {
        fromWorktreeId: string | null
        trigger: string
      }
      const from = p?.fromWorktreeId ? `\`${p.fromWorktreeId.slice(0, 8)}\`` : 'none'
      return `- ${time} [worktree.switch] from ${from} (${p?.trigger ?? 'unknown'})`
    }
    case 'file.open': {
      const p = payload as { path?: string; name?: string }
      return `- ${time} [file.open] ${p?.name ?? ''} \`${truncate(p?.path ?? '', 120)}\``
    }
    case 'file.focus': {
      const p = payload as { path?: string; name?: string; fromPath?: string | null }
      return `- ${time} [file.focus] ${p?.name ?? ''} \`${truncate(p?.path ?? '', 120)}\``
    }
    case 'file.selection': {
      const p = payload as {
        path?: string
        fromLine?: number
        toLine?: number
        length?: number
      }
      const name = (p?.path ?? '').split('/').pop() ?? ''
      const range =
        p?.fromLine === p?.toLine ? `L${p?.fromLine}` : `L${p?.fromLine}-${p?.toLine}`
      return `- ${time} [file.selection] ${name} ${range} (${p?.length ?? 0} chars)`
    }
    case 'terminal.command': {
      const p = payload as { command?: string; shell?: string; cwd?: string }
      const shell = p?.shell ? ` (${p.shell})` : ''
      return `- ${time} [terminal.command]${shell} \`${truncate(p?.command ?? '', 200)}\``
    }
    case 'terminal.output': {
      const p = payload as {
        commandEventId?: string | null
        head?: string
        tail?: string
        truncated?: boolean
        totalBytes?: number
        exitCode?: number | null
        reason?: string
      }
      const corr = p?.commandEventId ? ` → cmd:${p.commandEventId.slice(0, 8)}` : ''
      const exit = p?.exitCode != null ? ` exit=${p.exitCode}` : ''
      const first = (p?.head ?? '').split('\n').find((l) => l.trim().length > 0) ?? ''
      return `- ${time} [terminal.output]${corr} ${p?.totalBytes ?? 0}B${exit} (${p?.reason ?? ''})\n    > ${truncate(first, 200)}`
    }
    case 'session.message': {
      const p = payload as {
        agentSdk?: string
        text?: string
        attachmentCount?: number
      }
      const sdk = p?.agentSdk ? `(${p.agentSdk})` : ''
      const attach = (p?.attachmentCount ?? 0) > 0 ? ` [+${p?.attachmentCount} attached]` : ''
      return `- ${time} [session.message] ${sdk} "${truncate(p?.text ?? '', 200)}"${attach}`
    }
    default:
      return `- ${time} [${row.type}] ${truncate(row.payload_json, 200)}`
  }
}

function main(): void {
  let args: Args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
    printHelp()
    process.exit(2)
  }

  let db: Database.Database
  try {
    db = new Database(args.dbPath, { readonly: true, fileMustExist: true })
  } catch (err) {
    console.error(
      `error: cannot open DB at ${args.dbPath}: ${err instanceof Error ? err.message : String(err)}`
    )
    process.exit(1)
  }
  db.pragma('journal_mode = WAL')

  const events = fetchEvents(db, args)
  if (events.length === 0) {
    console.log(`# Field Event Timeline\n\n_No events in the last ${args.minutes} minutes._`)
    db.close()
    return
  }

  const worktreeIds = Array.from(
    new Set(events.map((e) => e.worktree_id).filter((id): id is string => id !== null))
  )
  const meta = fetchWorktreeMeta(db, worktreeIds)

  // Group by worktree (null bucket goes last)
  const groups = new Map<string | null, Row[]>()
  for (const row of events) {
    const key = row.worktree_id
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(row)
  }

  const since = new Date(Date.now() - args.minutes * 60_000).toISOString()
  const lines: string[] = [
    `# Field Event Timeline`,
    ``,
    `_Window: last ${args.minutes} minutes (since ${since}); ${events.length} events across ${groups.size} worktree(s)._`,
    ``
  ]

  for (const [worktreeId, rows] of groups) {
    const m = worktreeId ? meta.get(worktreeId) : null
    const heading = m
      ? `${m.name} (\`${m.branch_name}\`)`
      : worktreeId
        ? `Unknown worktree \`${worktreeId.slice(0, 8)}\``
        : `(no worktree)`
    lines.push(`## Worktree: ${heading}`)
    lines.push('')
    for (const row of rows) lines.push(formatRow(row))
    lines.push('')
  }

  console.log(lines.join('\n'))
  db.close()
}

main()
