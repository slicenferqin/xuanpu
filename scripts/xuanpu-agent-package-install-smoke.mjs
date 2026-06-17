#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const keepTemp = process.env.XUANPU_AGENT_PACKAGE_SMOKE_KEEP_TEMP === '1'

async function main() {
  const tempRoot = await mkdtemp(join(tmpdir(), 'xuanpu-agent-package-install-'))
  const packDir = join(tempRoot, 'pack')
  const appDir = join(tempRoot, 'app')

  await mkdir(packDir, { recursive: true })
  await mkdir(appDir, { recursive: true })

  try {
    await buildPackage('@xuanpu/oh-my-pi-runtime')
    await buildPackage('@xuanpu/pi-agent-core')
    await buildPackage('@xuanpu/agent-cli')

    await packPackage('@xuanpu/oh-my-pi-runtime', packDir)
    await packPackage('@xuanpu/pi-agent-core', packDir)
    await packPackage('@xuanpu/agent-cli', packDir)

    const tarballs = await findTarballs(packDir)
    const tarballSpecs = {
      runtime: toFileSpec(appDir, tarballs.runtime),
      alias: toFileSpec(appDir, tarballs.alias),
      cli: toFileSpec(appDir, tarballs.cli)
    }
    await writeFile(
      join(appDir, 'package.json'),
      JSON.stringify(
        {
          name: 'xuanpu-agent-package-install-smoke',
          private: true,
          type: 'module',
          dependencies: {
            '@xuanpu/oh-my-pi-runtime': tarballSpecs.runtime,
            '@xuanpu/pi-agent-core': tarballSpecs.alias,
            '@xuanpu/agent-cli': tarballSpecs.cli
          },
          pnpm: {
            overrides: {
              '@xuanpu/oh-my-pi-runtime': tarballSpecs.runtime,
              '@xuanpu/pi-agent-core': tarballSpecs.alias,
              '@xuanpu/agent-cli': tarballSpecs.cli
            }
          }
        },
        null,
        2
      ) + '\n',
      'utf8'
    )

    await run('pnpm', ['install', '--ignore-scripts'], { cwd: appDir })

    const help = await runCapture('pnpm', ['exec', 'xuanpu-agent', '--help'], { cwd: appDir })
    assertIncludes(help.stdout, 'xuanpu-agent run', 'CLI help should expose the run command.')
    assertIncludes(
      help.stdout,
      'CanonicalAgentEvent-compatible NDJSON',
      'CLI help should describe the event stream contract.'
    )

    const dryRun = await runCapture(
      'pnpm',
      ['exec', 'xuanpu-agent', 'run', '--dry-run', 'package install smoke'],
      { cwd: appDir }
    )
    const events = parseNdjson(dryRun.stdout)
    assert(
      events.some((event) => event.type === 'session.materialized'),
      'Dry-run CLI should materialize a session.'
    )
    assert(
      events.some((event) => event.type === 'message.updated'),
      'Dry-run CLI should emit a message update.'
    )
    assert(
      events.some((event) => event.type === 'session.idle'),
      'Dry-run CLI should return to idle.'
    )

    const moduleCheck = await runCapture(
      process.execPath,
      ['--input-type=module', '-e', moduleCheckSource()],
      { cwd: appDir }
    )
    const resolved = JSON.parse(moduleCheck.stdout)

    console.log(
      JSON.stringify(
        {
          ok: true,
          status: 'completed',
          packageManager: 'pnpm',
          tarballs: {
            runtime: tarballs.runtime,
            alias: tarballs.alias,
            cli: tarballs.cli
          },
          cli: {
            help: 'ok',
            dryRunEventTypes: events.map((event) => event.type)
          },
          modules: resolved,
          tempRoot: keepTemp ? tempRoot : undefined
        },
        null,
        2
      )
    )
  } finally {
    if (!keepTemp) await rm(tempRoot, { recursive: true, force: true })
  }
}

async function buildPackage(name) {
  await run('pnpm', ['--filter', name, 'build'], { cwd: repoRoot })
}

async function packPackage(name, packDir) {
  await run('pnpm', ['--filter', name, 'pack', '--pack-destination', packDir], { cwd: repoRoot })
}

async function findTarballs(packDir) {
  const files = await readdir(packDir)
  return {
    runtime: findTarball(files, packDir, /^xuanpu-oh-my-pi-runtime-\d+\.\d+\.\d+.*\.tgz$/),
    alias: findTarball(files, packDir, /^xuanpu-pi-agent-core-\d+\.\d+\.\d+.*\.tgz$/),
    cli: findTarball(files, packDir, /^xuanpu-agent-cli-\d+\.\d+\.\d+.*\.tgz$/)
  }
}

function findTarball(files, packDir, pattern) {
  const match = files.find((file) => pattern.test(file))
  if (!match) {
    throw new Error(`Expected tarball matching ${pattern} in ${packDir}; got ${files.join(', ')}`)
  }
  return join(packDir, match)
}

function toFileSpec(fromDir, targetPath) {
  const rel = relative(fromDir, targetPath)
  return `file:${rel.startsWith('.') ? rel : `./${rel}`}`
}

function parseNdjson(stdout) {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function moduleCheckSource() {
  return `
    import { readFile } from 'node:fs/promises'

    const specs = [
      '@xuanpu/agent-cli',
      '@xuanpu/agent-cli/runner',
      '@xuanpu/agent-cli/rpc-bridge',
      '@xuanpu/oh-my-pi-runtime',
      '@xuanpu/oh-my-pi-runtime/agent-loop',
      '@xuanpu/oh-my-pi-runtime/upstream.json',
      '@xuanpu/pi-agent-core',
      '@xuanpu/pi-agent-core/agent-loop'
    ]
    const resolved = {}
    for (const spec of specs) {
      resolved[spec] = await import.meta.resolve(spec)
    }

    const runner = await import('@xuanpu/agent-cli/runner')
    const rpcBridge = await import('@xuanpu/agent-cli/rpc-bridge')
    if (typeof runner.createDryRunRunner !== 'function') {
      throw new Error('createDryRunRunner export is missing')
    }
    if (typeof rpcBridge.runJsonRpcBridge !== 'function') {
      throw new Error('runJsonRpcBridge export is missing')
    }

    const upstreamJsonUrl = await import.meta.resolve('@xuanpu/oh-my-pi-runtime/upstream.json')
    const upstream = JSON.parse(await readFile(new URL(upstreamJsonUrl), 'utf8'))
    if (
      upstream.upstreamTag !== 'v15.2.4' ||
      upstream.upstreamPackages?.['@oh-my-pi/pi-agent-core'] !== '15.2.4'
    ) {
      throw new Error('Unexpected upstream metadata: ' + JSON.stringify(upstream))
    }

    console.log(JSON.stringify({
      resolved,
      runnerExport: 'createDryRunRunner',
      rpcBridgeExport: 'runJsonRpcBridge',
      upstream
    }))
  `
}

function assertIncludes(value, expected, message) {
  assert(value.includes(expected), `${message} Missing: ${expected}`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function run(command, args, options) {
  await runProcess(command, args, { ...options, stdio: 'inherit' })
}

async function runCapture(command, args, options) {
  return runProcess(command, args, { ...options, stdio: 'pipe' })
}

function runProcess(command, args, options) {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        npm_config_fund: 'false',
        npm_config_audit: 'false'
      },
      stdio: options.stdio
    })
    let stdout = ''
    let stderr = ''

    if (child.stdout) child.stdout.on('data', (chunk) => (stdout += String(chunk)))
    if (child.stderr) child.stderr.on('data', (chunk) => (stderr += String(chunk)))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolveProcess({ stdout, stderr })
        return
      }

      const error = new Error(
        [
          `Command failed (${code}): ${command} ${args.join(' ')}`,
          stdout ? `stdout:\n${stdout}` : '',
          stderr ? `stderr:\n${stderr}` : ''
        ]
          .filter(Boolean)
          .join('\n')
      )
      reject(error)
    })
  })
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
