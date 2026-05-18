export const DOCKER_DESKTOP_MAC_ARM64_URL =
  'https://desktop.docker.com/mac/main/arm64/Docker.dmg'
export const DOCKER_DESKTOP_MAC_X64_URL = 'https://desktop.docker.com/mac/main/amd64/Docker.dmg'

export function getDockerDesktopMacDownloadUrl(cpuArch: string): string {
  return cpuArch === 'arm64' ? DOCKER_DESKTOP_MAC_ARM64_URL : DOCKER_DESKTOP_MAC_X64_URL
}

export function buildFunAsrStartCommand(containerPort: number): string {
  const serverArgs = [
    `--download-model-dir /workspace/models`,
    `--vad-dir damo/speech_fsmn_vad_zh-cn-16k-common-onnx`,
    `--model-dir damo/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-online-onnx`,
    `--online-model-dir damo/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-online-onnx`,
    `--punc-dir damo/punc_ct-transformer_zh-cn-common-vocab272727-onnx`,
    `--itn-dir thuduj12/fst_itn_zh`,
    `--lm-dir damo/speech_ngram_lm_zh-cn-ai-wesp-fst`,
    `--port ${containerPort}`,
    `--certfile 0`
  ].join(' ')

  return [
    `set -e`,
    `script=""`,
    `for dir in /workspace/FunASR/runtime /workspace/FunASR/funasr/runtime /workspace/funasr/runtime /workspace/runtime FunASR/runtime; do`,
    `  if [ -f "$dir/run_server_2pass.sh" ]; then script="$dir/run_server_2pass.sh"; break; fi`,
    `done`,
    `if [ -z "$script" ]; then script="$(find /workspace -path '*/runtime/run_server_2pass.sh' -print -quit 2>/dev/null || true)"; fi`,
    `if [ -z "$script" ]; then echo "run_server_2pass.sh not found in FunASR image" >&2; exit 127; fi`,
    `cd "$(dirname "$script")"`,
    `bash run_server_2pass.sh ${serverArgs}`,
    `server_pid=""`,
    `for _ in $(seq 1 30); do`,
    `  server_pid="$(ps -eo pid,args | awk '/[f]unasr-wss-server-2pass --download-model-dir/ { print $1; exit }')"`,
    `  if [ -n "$server_pid" ]; then break; fi`,
    `  sleep 1`,
    `done`,
    `if [ -z "$server_pid" ]; then echo "FunASR server process did not start" >&2; exit 1; fi`,
    `while kill -0 "$server_pid" 2>/dev/null; do sleep 5; done`,
    `echo "FunASR server process exited" >&2`,
    `exit 1`
  ].join('\n')
}
