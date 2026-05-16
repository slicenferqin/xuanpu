# Voice Input

Xuanpu voice input is a local-first speech-to-text path for the session composer. The first
milestone keeps the whole flow inside Xuanpu: click the microphone, let Xuanpu prepare the speech
runtime when needed, record audio, stream partial text, and insert the final transcript at the
current cursor position.

## Composer Interaction

Voice input has two entry modes:

- Click the composer microphone to toggle recording.
- Focus the composer and hold `Ctrl` to start push-to-talk; release `Ctrl` to finish.

Push-to-talk waits briefly before starting so ordinary `Ctrl+...` shortcut chords can cancel the
pending voice start. The shortcut is scoped to the composer context instead of being a global app
shortcut, which avoids accidental recording while the user is working in other panels.

While recording, the whole composer enters a voice capture state with a cyan aura, animated waveform,
and streaming partial transcript. The final transcript is inserted back into the composer at the
current cursor position.

## Runtime Model

The default provider is `managed`: Xuanpu owns a local FunASR sidecar runtime outside the app bundle.
The app installer does not bundle FunASR, Python packages, Docker images, or model weights. These
assets are downloaded on demand into the user's Xuanpu data directory.

Managed runtime files are stored under:

```text
~/.xuanpu/voice/funasr/
  runtime.json
  runtime/
    FunASR/
    venv/
    server.pid
  models/
  logs/
    managed-runtime.log
```

The managed provider defaults to:

```text
provider: managed
websocket: ws://127.0.0.1:10095
host port: 10095
```

This path requires a local Python 3 executable and Git. Xuanpu creates its own virtual environment,
installs the Python dependencies there, starts the FunASR WebSocket server with CPU settings, and
keeps model downloads in the Xuanpu model cache.

## Providers

`Settings -> Voice -> Runtime provider` exposes three providers:

- `Managed local`: default product path. Xuanpu downloads and starts a local Python FunASR sidecar.
- `External WS`: Xuanpu connects to a user-managed FunASR WebSocket endpoint and does not install or
  start anything.
- `Docker preview`: advanced/developer path using the FunASR Docker runtime image. This is no longer
  the default because it requires Docker Desktop and pulls a large image for one input feature.

Docker preview uses:

```text
websocket: ws://127.0.0.1:10096
host port: 10096
container: xuanpu-funasr-runtime
image: registry.cn-hangzhou.aliyuncs.com/funasr_repo/funasr:funasr-runtime-sdk-online-cpu-0.1.13
```

## First-Run Flow

When the user clicks the composer microphone:

1. Xuanpu checks whether the configured FunASR WebSocket endpoint is already ready.
2. If the provider is `external`, Xuanpu stops here and reports the endpoint status.
3. If the provider is `managed`, Xuanpu checks Python 3 and the local runtime directory.
4. If the managed runtime is missing, Xuanpu clones FunASR into the local runtime directory.
5. Xuanpu creates the managed Python virtual environment when needed.
6. Xuanpu installs or updates the FunASR Python dependencies in that virtual environment.
7. Xuanpu starts the local WebSocket server on `127.0.0.1:10095` with CPU settings.
8. Xuanpu waits for the FunASR WebSocket service to become available.
9. Xuanpu requests microphone permission when needed.
10. Audio is captured in the renderer, converted to 16 kHz mono PCM, and streamed to FunASR.
11. Partial transcripts are displayed in the composer voice panel.
12. When recording stops, the final transcript is inserted into the composer. If FunASR only returns
    online partial messages for the utterance, Xuanpu commits the latest partial transcript as a
    fallback so the spoken text is not lost.

## Settings

Open `Settings -> Voice` to inspect or change:

- Whether the composer microphone is shown.
- Runtime provider: managed local, external WebSocket, or Docker preview.
- Whether Xuanpu should automatically prepare the local runtime on microphone click.
- FunASR WebSocket URL.
- Host port.
- Docker image, only when the Docker preview provider is selected.
- Microphone permission status.
- Runtime logs and diagnostic payload.

For `managed`, changing the WebSocket URL or host port updates the sidecar metadata used on the next
prepare/start operation. For `external`, Xuanpu only checks the configured WebSocket endpoint. For
`docker`, changing the image or port causes Xuanpu to recreate the managed container on the next
prepare operation so the container matches the current settings.

## Privacy

The current implementation streams microphone audio only to the configured FunASR WebSocket endpoint.
By default that endpoint is a local sidecar bound to `127.0.0.1`. Xuanpu does not store raw audio.
The managed provider keeps runtime files, logs, and downloaded model files under
`~/.xuanpu/voice/funasr`.

## Known Limits

- The first version targets the Xuanpu composer only; it does not inject text into arbitrary apps or
  IDE cursor locations.
- First-run setup can still be large because FunASR Python dependencies and model weights are
  downloaded after the user opts into voice input.
- The managed provider expects Python 3 and Git to already exist on the machine. Missing prerequisites
  are surfaced in `Settings -> Voice` and runtime progress messages.
- Docker preview remains available for development and compatibility testing, but it is not the
  normal-user default.
