export interface VoiceAudioCapture {
  stop: () => void
}

export interface VoiceAudioCaptureDebugEvent {
  type: 'started' | 'chunk' | 'stopped'
  audioContextState: AudioContextState
  sourceSampleRate: number
  targetSampleRate: number
  chunkCount: number
  byteCount: number
  peak: number
}

export async function startVoiceAudioCapture(
  onChunk: (chunk: ArrayBuffer) => void,
  onDebug?: (event: VoiceAudioCaptureDebugEvent) => void
): Promise<VoiceAudioCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  })

  const AudioContextCtor = window.AudioContext || window.webkitAudioContext
  if (!AudioContextCtor) {
    throw new Error('Audio capture is not supported in this browser context')
  }
  const audioContext = new AudioContextCtor()
  const source = audioContext.createMediaStreamSource(stream)
  const processor = audioContext.createScriptProcessor(4096, 1, 1)
  const silentOutput = audioContext.createGain()
  const sourceRate = audioContext.sampleRate
  const targetRate = 16000
  let chunkCount = 0
  let byteCount = 0
  let peak = 0
  let stopped = false

  silentOutput.gain.value = 0

  processor.onaudioprocess = (event) => {
    if (stopped) return
    const input = event.inputBuffer.getChannelData(0)
    peak = Math.max(peak, calculatePeak(input))
    const pcm = downsampleToInt16(input, sourceRate, targetRate)
    if (pcm.byteLength === 0) return

    const chunk = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength)
    chunkCount += 1
    byteCount += chunk.byteLength
    if (chunkCount <= 5 || chunkCount % 50 === 0) {
      onDebug?.({
        type: 'chunk',
        audioContextState: audioContext.state,
        sourceSampleRate: sourceRate,
        targetSampleRate: targetRate,
        chunkCount,
        byteCount,
        peak
      })
    }
    onChunk(chunk)
  }

  source.connect(processor)
  // ScriptProcessorNode only runs while connected to the audio graph. Route it
  // through a zero-gain node so microphone audio is not played back.
  processor.connect(silentOutput)
  silentOutput.connect(audioContext.destination)

  if (audioContext.state === 'suspended') {
    await audioContext.resume()
  }

  onDebug?.({
    type: 'started',
    audioContextState: audioContext.state,
    sourceSampleRate: sourceRate,
    targetSampleRate: targetRate,
    chunkCount,
    byteCount,
    peak
  })

  return {
    stop: () => {
      if (stopped) return
      stopped = true
      onDebug?.({
        type: 'stopped',
        audioContextState: audioContext.state,
        sourceSampleRate: sourceRate,
        targetSampleRate: targetRate,
        chunkCount,
        byteCount,
        peak
      })
      try {
        processor.disconnect()
      } catch {
        // Audio nodes may already be disconnected during rapid stop/unmount races.
      }
      try {
        source.disconnect()
      } catch {
        // Ignore duplicate disconnects.
      }
      try {
        silentOutput.disconnect()
      } catch {
        // Ignore duplicate disconnects.
      }
      for (const track of stream.getTracks()) {
        track.stop()
      }
      void audioContext.close()
    }
  }
}

function calculatePeak(input: Float32Array): number {
  let peak = 0
  for (let i = 0; i < input.length; i += 1) {
    peak = Math.max(peak, Math.abs(input[i]))
  }
  return Math.round(peak * 10000) / 10000
}

function downsampleToInt16(
  input: Float32Array,
  sourceRate: number,
  targetRate: number
): Int16Array {
  if (sourceRate === targetRate) return floatToInt16(input)

  const ratio = sourceRate / targetRate
  const length = Math.floor(input.length / ratio)
  const output = new Int16Array(length)

  for (let i = 0; i < length; i += 1) {
    const start = Math.floor(i * ratio)
    const end = Math.min(Math.floor((i + 1) * ratio), input.length)
    let sum = 0
    for (let j = start; j < end; j += 1) {
      sum += input[j]
    }
    const sample = sum / Math.max(1, end - start)
    output[i] = clampSample(sample)
  }

  return output
}

function floatToInt16(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length)
  for (let i = 0; i < input.length; i += 1) {
    output[i] = clampSample(input[i])
  }
  return output
}

function clampSample(sample: number): number {
  const value = Math.max(-1, Math.min(1, sample))
  return value < 0 ? value * 0x8000 : value * 0x7fff
}
