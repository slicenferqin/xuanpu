async function main(): Promise<void> {
  try {
    const mod = await import('@oh-my-pi/pi-agent-core')
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
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          note:
            '@oh-my-pi/pi-agent-core@15.2.4 exports TypeScript source; Xuanpu must bundle/transpile it for Electron main instead of externalizing it.'
        },
        null,
        2
      )
    )
    process.exitCode = 1
  }
}

void main()
