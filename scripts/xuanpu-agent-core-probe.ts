async function main(): Promise<void> {
  try {
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (
      specifier: string
    ) => Promise<Record<string, unknown>>
    const mod = await dynamicImport('@oh-my-pi/pi-agent-core')
    console.log(
      JSON.stringify(
        {
          ok: true,
          exportedKeys: Object.keys(mod).sort()
        },
        null,
        2
      )
    )
  } catch (error) {
    const strict = process.env.XUANPU_AGENT_CORE_PROBE_STRICT === '1'
    const payload = {
      ok: !strict,
      status: strict ? 'failed' : 'expected-direct-node-import-failure',
      error: error instanceof Error ? error.message : String(error),
      note:
        '@oh-my-pi/pi-agent-core@15.2.4 exports TypeScript source; Xuanpu must bundle/transpile it for Electron main instead of externalizing it.'
    }

    const print = strict ? console.error : console.log
    print(
      JSON.stringify(
        payload,
        null,
        2
      )
    )
    process.exitCode = strict ? 1 : 0
  }
}

void main()
