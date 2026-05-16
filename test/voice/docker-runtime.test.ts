import {
  DOCKER_DESKTOP_MAC_ARM64_URL,
  DOCKER_DESKTOP_MAC_X64_URL,
  buildFunAsrStartCommand,
  getDockerDesktopMacDownloadUrl
} from '../../src/shared/lib/voice-docker'

describe('buildFunAsrStartCommand', () => {
  it('builds a robust FunASR runtime startup command', () => {
    const command = buildFunAsrStartCommand(10095)

    expect(command).toContain('run_server_2pass.sh')
    expect(command).toContain('find /workspace')
    expect(command).toContain('--download-model-dir /workspace/models')
    expect(command).toContain('--port 10095')
    expect(command).toContain('--certfile 0')
    expect(command).toContain('ps -eo pid,args')
    expect(command).toContain('[f]unasr-wss-server-2pass --download-model-dir')
    expect(command).toContain('while kill -0 "$server_pid"')
    expect(command).not.toContain('exec bash run_server_2pass.sh')
  })
})

describe('getDockerDesktopMacDownloadUrl', () => {
  it('uses the official Apple Silicon Docker Desktop package for arm64', () => {
    expect(getDockerDesktopMacDownloadUrl('arm64')).toBe(DOCKER_DESKTOP_MAC_ARM64_URL)
  })

  it('uses the official Intel Docker Desktop package for other mac architectures', () => {
    expect(getDockerDesktopMacDownloadUrl('x64')).toBe(DOCKER_DESKTOP_MAC_X64_URL)
  })
})
