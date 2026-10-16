# Add a voice input button

This guide shows how to build a dictation button like the microphone in AgentLink's chat composer, using `@agentlink/core`. The result behaves the same way:

- Text appears in the draft at each natural pause while the user keeps talking.
- Dictation stops by itself after a short silence, or after a while if nobody speaks.
- A quick tap toggles recording; holding the button (or a shortcut) is push-to-talk.
- A live level meter and timer show that the microphone is hearing the user.
- The text stays in the draft for review unless the host opts into auto-send.

The SDK supplies the audio logic and transcription. The host supplies the microphone, the UI, credentials, and (when the UI runs in a browser) an upload route.

## How it fits together

```text
microphone
  -> 16 kHz mono PCM frames            (host: browser Web Audio or a Node recorder)
  -> VoiceActivitySegmenter.push()     (@agentlink/core/voice, runs anywhere)
       level     -> mic meter
       segment   -> encodeWavPcm16() -> host backend -> transcribeCodexAudio()
                                                       (@agentlink/core/codex, Node only)
                 -> text inserted into the draft, in speaking order
       autoStop  -> finish the dictation
```

| Piece                        | Provided by                                       | Runs in                |
| ---------------------------- | ------------------------------------------------- | ---------------------- |
| Pause detection, levels, WAV | `@agentlink/core/voice`                           | Node, browser, or edge |
| Transcription                | `transcribeCodexAudio` in `@agentlink/core/codex` | Node only              |
| Microphone capture           | Host                                              | Wherever the mic is    |
| Credentials                  | Host `CodexCredentialProvider`                    | Server side only       |
| Button, draft, shortcuts     | Host                                              | UI                     |

`@agentlink/core/voice` imports nothing, so you can segment audio in the same place you record it and only send finished utterances to the backend.

## 1. Decide when to show the button

- Show the button only when the host has a ChatGPT/Codex sign-in (or an OpenAI API key) for the current user. AgentLink hides it entirely without one.
- Show it disabled, with the reason as its tooltip, when the user is signed in but recording cannot work. Examples: a browser page that is not HTTPS or `localhost`, or a platform without a recorder.
- If transcription fails with `CodexTranscriptionError` code `auth_required`, treat the user as signed out and prompt them to sign in.

## 2. Capture audio

The segmenter expects mono 16-bit PCM frames. Use 16 kHz, which is plenty for speech and keeps uploads small. Frames of roughly 20 to 100 ms work well.

### In a browser or webview

```ts
import { resampleToPcm16 } from "@agentlink/core/voice";

export async function startBrowserCapture(
  onFrame: (frame: Int16Array) => void,
): Promise<() => void> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  const context = new AudioContext();
  if (context.state === "suspended") await context.resume();
  const source = context.createMediaStreamSource(stream);
  // ~43 ms at 48 kHz. ScriptProcessor is deprecated but available everywhere,
  // including embedded Chromium, and needs no separate worklet file.
  const processor = context.createScriptProcessor(2048, 1, 1);
  processor.onaudioprocess = (event) => {
    onFrame(
      resampleToPcm16(
        event.inputBuffer.getChannelData(0),
        context.sampleRate,
        16_000,
      ),
    );
  };
  source.connect(processor);
  processor.connect(context.destination); // Required to run; outputs silence.
  return () => {
    processor.onaudioprocess = null;
    source.disconnect();
    processor.disconnect();
    for (const track of stream.getTracks()) track.stop();
    void context.close();
  };
}
```

- `getUserMedia` only works on HTTPS or `localhost`. Map `NotAllowedError` to "allow microphone access" and `NotFoundError` to "no microphone found".
- An `AudioWorklet` works too if your bundler can serve the worklet module.

### In a Node process

On Linux, including a Steam Deck backend, read raw PCM from `arecord` or `pw-record`:

```ts
import { spawn } from "node:child_process";

export async function startNodeCapture(
  onFrame: (frame: Int16Array) => void,
): Promise<() => void> {
  const recorder = spawn(
    "arecord",
    ["-q", "-t", "raw", "-f", "S16_LE", "-r", "16000", "-c", "1"],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  // Alternative: pw-record --rate 16000 --channels 1 --format s16 -
  let carry: Buffer = Buffer.alloc(0);
  recorder.stdout.on("data", (chunk: Buffer) => {
    const bytes = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    const usable = bytes.length - (bytes.length % 2);
    carry = bytes.subarray(usable);
    if (usable === 0) return;
    // Copy so the samples are 2-byte aligned for Int16Array.
    const aligned = new Uint8Array(bytes.subarray(0, usable));
    onFrame(new Int16Array(aligned.buffer));
  });
  return () => recorder.kill("SIGINT");
}
```

On macOS and Windows use a native recorder; AgentLink's VS Code extension uses `@picovoice/pvrecorder-node` in a worker thread. The packaged app must declare microphone use (macOS `NSMicrophoneUsageDescription`), or the operating system delivers silence.

## 3. Segment while recording

Create one `VoiceActivitySegmenter` per dictation and push every frame:

```ts
import { VoiceActivitySegmenter } from "@agentlink/core/voice";

const segmenter = new VoiceActivitySegmenter({
  sampleRate: 16_000,
  autoStopMs: 2_000, // silence after speech that ends dictation; 0 = never
  noSpeechTimeoutMs: 10_000, // give up if nobody speaks; 0 = never
});

const { level, segment, autoStop } = segmenter.push(frame);
```

| Option              | Default | Effect                                                      |
| ------------------- | ------- | ----------------------------------------------------------- |
| `pauseMs`           | 700     | Silence that ends one utterance and emits a `segment`.      |
| `autoStopMs`        | 0       | Silence after speech that sets `autoStop`.                  |
| `noSpeechTimeoutMs` | 0       | Sets `autoStop` when no speech is heard this long.          |
| `minSpeechMs`       | 200     | Shorter bursts (clicks, bumps) are not treated as speech.   |
| `maxSegmentMs`      | 25000   | Long monologues are cut here even without a pause.          |
| `prefixPaddingMs`   | 300     | Audio kept before speech starts so first syllables survive. |

- `level` is in `[0, 1]` on a perceptual curve, ready for a meter.
- `autoStop` is reported once. The host decides whether to honour it (ignore it during push-to-talk).
- When dictation ends, `flush()` returns trailing audio that still contains speech, or `null`.
- `segmenter.peak === 0` after a recording means the input was digital silence. That almost always means the app lacks microphone permission, so say so instead of "nothing heard".

The segmenter measures loudness against an adaptive noise floor. It is not a speech model, so loud background noise can count as speech. Echo cancellation and noise suppression help in browsers.

## 4. Transcribe each utterance in order

Transcription needs the host's credentials, so it always runs server side:

```ts
import {
  CodexTranscriptionError,
  transcribeCodexAudio,
} from "@agentlink/core/codex";

export async function transcribeWav(wav: Uint8Array): Promise<string> {
  const { text } = await transcribeCodexAudio({
    credentialProvider, // the same host-owned CodexCredentialProvider
    context: principal, // `undefined` for a single-user host
    audio: { data: wav, mimeType: "audio/wav", filename: "speech.wav" },
  });
  return text;
}
```

If the UI runs in a browser, do not call ChatGPT from the page. It would expose credentials and is blocked by CORS anyway. Upload each WAV segment to your own authenticated route and call `transcribeWav` there. AgentLink posts JSON `{ "audio": "<base64>", "mimeType": "audio/wav" }` and returns `{ "ok": true, "text": "..." }`, which survives proxies that mishandle binary bodies.

Segments can finish transcribing out of order, so chain them. Section 5 shows the pattern.

## 5. Build the dictation controller

This framework-neutral controller is the state machine behind AgentLink's button. Wire its callbacks to your UI.

```ts
import { encodeWavPcm16, VoiceActivitySegmenter } from "@agentlink/core/voice";

export type DictationStatus =
  | "idle"
  | "starting"
  | "recording"
  | "transcribing";
type StopReason = "manual" | "auto" | "release";

const SAMPLE_RATE = 16_000;
/** Presses at least this long are push-to-talk; shorter ones toggle. */
const HOLD_THRESHOLD_MS = 350;
/** Tails shorter than this are breath or clicks, not words. */
const MIN_TAIL_SAMPLES = SAMPLE_RATE * 0.3;

export interface DictationHost {
  /** Opens the microphone and streams 16 kHz frames; resolves with stop(). */
  startCapture(onFrame: (frame: Int16Array) => void): Promise<() => void>;
  /** Transcribes one WAV utterance, usually through your backend. */
  transcribe(wav: Uint8Array): Promise<string>;
  onText(text: string): void;
  onLevel(level: number): void;
  onStatus(status: DictationStatus): void;
  onError(message: string): void;
  /** Called after a hands-free finish when `autoSend` is on. */
  onAutoSend?(): void;
}

export class DictationController {
  status: DictationStatus = "idle";
  /** Bumped per dictation and on cancel so late results are dropped. */
  private generation = 0;
  private stopCapture: (() => void) | undefined;
  private segmenter: VoiceActivitySegmenter | undefined;
  private transcripts: Promise<void> = Promise.resolve();
  private failure: unknown;
  private segments = 0;
  private heldSince: number | null = null;
  private pendingStop: StopReason | null = null;

  constructor(
    private readonly host: DictationHost,
    private readonly options = { autoStopMs: 2_000, autoSend: false },
  ) {}

  /** Click or Enter/Space: start, or stop and keep the draft. */
  toggle(): void {
    if (this.status === "idle") void this.start();
    else void this.stop("manual");
  }

  /** Button or shortcut pressed: a hold becomes push-to-talk. */
  pressStart(): void {
    if (this.heldSince !== null) return;
    if (this.status === "idle") {
      this.heldSince = Date.now();
      void this.start();
    } else {
      void this.stop("manual");
    }
  }

  /** Released: finish a hold, or keep recording after a short tap. */
  pressEnd(): void {
    const since = this.heldSince;
    this.heldSince = null;
    if (since !== null && Date.now() - since >= HOLD_THRESHOLD_MS) {
      void this.stop("release");
    }
  }

  /** Escape: discard everything from this dictation. */
  cancel(): void {
    this.heldSince = null;
    this.pendingStop = null;
    if (this.status === "idle") return;
    this.generation += 1;
    this.stopCapture?.();
    this.stopCapture = undefined;
    this.setStatus("idle");
  }

  private async start(): Promise<void> {
    if (this.status !== "idle") return;
    const generation = ++this.generation;
    const { autoStopMs } = this.options;
    const segmenter = new VoiceActivitySegmenter({
      sampleRate: SAMPLE_RATE,
      autoStopMs,
      noSpeechTimeoutMs: autoStopMs > 0 ? 10_000 : 0,
    });
    this.segmenter = segmenter;
    this.transcripts = Promise.resolve();
    this.failure = undefined;
    this.segments = 0;
    this.pendingStop = null;
    this.setStatus("starting");
    try {
      const stop = await this.host.startCapture((frame) => {
        if (generation !== this.generation || this.status !== "recording") {
          return;
        }
        const result = segmenter.push(frame);
        this.host.onLevel(result.level);
        if (result.segment) this.enqueue(generation, result.segment);
        // Push-to-talk records until release, however long the pause.
        if (result.autoStop && this.heldSince === null) void this.stop("auto");
      });
      if (generation !== this.generation) {
        stop(); // Cancelled while the microphone was opening.
        return;
      }
      this.stopCapture = stop;
      this.setStatus("recording");
      const pending = this.pendingStop;
      this.pendingStop = null;
      if (pending) await this.stop(pending);
    } catch (error) {
      if (generation !== this.generation) return;
      this.setStatus("idle");
      this.host.onError(error instanceof Error ? error.message : String(error));
    }
  }

  private async stop(reason: StopReason): Promise<void> {
    if (this.status === "starting") {
      this.pendingStop = reason; // Finish once the microphone is open.
      return;
    }
    if (this.status !== "recording") return;
    const generation = this.generation;
    this.setStatus("transcribing");
    this.host.onLevel(0);
    this.stopCapture?.();
    this.stopCapture = undefined;
    const segmenter = this.segmenter!;
    const tail = segmenter.flush();
    if (tail && tail.length >= MIN_TAIL_SAMPLES) this.enqueue(generation, tail);
    await this.transcripts;
    if (generation !== this.generation) return;
    this.setStatus("idle");
    if (this.failure) {
      const error = this.failure;
      this.host.onError(error instanceof Error ? error.message : String(error));
    } else if (segmenter.peak === 0 && this.segments === 0) {
      this.host.onError(
        "The microphone recorded only silence. Check microphone permission.",
      );
    } else if (this.options.autoSend && reason !== "manual") {
      this.host.onAutoSend?.();
    }
  }

  private enqueue(generation: number, pcm: Int16Array): void {
    this.segments += 1;
    this.transcripts = this.transcripts.then(async () => {
      if (generation !== this.generation || this.failure) return;
      try {
        const text = await this.host.transcribe(
          encodeWavPcm16(pcm, SAMPLE_RATE),
        );
        if (generation === this.generation && text.trim())
          this.host.onText(text);
      } catch (error) {
        this.failure = error;
      }
    });
  }

  private setStatus(status: DictationStatus): void {
    this.status = status;
    this.host.onStatus(status);
  }
}
```

Insert each piece of text at the caret, adding a space only where words would otherwise run together:

```ts
export function insertTranscript(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  transcript: string,
): { value: string; caret: number } {
  const text = transcript.trim();
  if (!text) return { value, caret: selectionEnd };
  const before = value.slice(0, selectionStart);
  const after = value.slice(selectionEnd);
  const lead = before && !/\s$/u.test(before) ? " " : "";
  const trail = after && !/^\s/u.test(after) ? " " : "";
  return {
    value: `${before}${lead}${text}${trail}${after}`,
    caret: before.length + lead.length + text.length,
  };
}
```

Read the caret position when each piece arrives, not when recording started, so the user can keep editing while they talk.

## 6. UI details that make it feel natural

- **Button states:** a mic icon when idle, a spinner while starting or transcribing, and a stop square while recording. Set `aria-pressed` while recording and `aria-busy` while starting or transcribing. Disable the button while transcribing.
- **Tap and hold:** call `pressStart` on `pointerdown` and `pressEnd` on `pointerup`/`pointercancel`. Call `preventDefault()` on `pointerdown` so focus and the caret stay in the text box, and capture the pointer so a release outside the button still counts. Handle keyboard activation (a `click` with `event.detail === 0`) with `toggle()`.
- **Shortcut:** AgentLink uses `Alt+M` with `pressStart` on keydown (ignoring `event.repeat`) and `pressEnd` on keyup. Call `preventDefault()` so macOS does not type `µ`. On window `blur`, clear the hold so a release outside the window becomes a toggle.
- **Escape:** cancels while starting or recording and inserts nothing.
- **Level and timer:** drive a ring or glow from `onLevel` (a CSS variable works well) and show elapsed `m:ss` while recording.
- **Auto-send:** keep it off by default. When on, send only after a hands-free finish (`auto` or `release`), never after the user clicks stop.
- **Errors:** show them inline next to the input and clear them on the next attempt.
- **Lifecycle:** cancel when the input unmounts or the conversation changes, so late text never lands in the wrong draft. Cap a single dictation (AgentLink stops at 10 minutes).

## 7. Errors and limits

| `CodexTranscriptionError.code` | Meaning and suggested handling                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| `auth_required`                | No usable sign-in. Hide the button or prompt the user to sign in.                    |
| `audio_empty`                  | Nothing to send. Skip silently.                                                      |
| `audio_too_large`              | Over 25 MiB. Segments are far smaller (25 s of 16 kHz PCM is about 800 KB).          |
| `challenge_blocked`            | ChatGPT's bot protection rejected the request. See the Electron note below.          |
| `usage_limited`                | The ChatGPT plan's limit was reached. Show the message and let the user retry later. |
| `request_failed`               | Network or server error. Show the message; the user can try again.                   |
| `invalid_response`             | Unexpected response shape. Report it.                                                |

- ChatGPT/Codex OAuth uses ChatGPT's dictation endpoint (`CODEX_TRANSCRIBE_URL`). Codex uses it too, but OpenAI does not document it as a public API, so it may change. Usage counts against the user's ChatGPT plan. An OpenAI API key uses the public Audio API instead.
- Cloudflare inspects the TLS handshake. Electron-hosted Node is challenged with its default cipher list. `transcribeCodexAudio` therefore uploads by default through undici with a narrower ECDHE/AEAD cipher list (`CODEX_TRANSCRIPTION_TLS_CIPHERS`) and honours proxy environment variables, so hosts need no extra setup. Do not pass your own `fetch` unless you need to; if you do, give it the same cipher list (`createCodexTranscriptionFetch()` builds one). Always call it from the Node side of your app, never from a browser or CEF page.
- Responses are final text per utterance. Text appears about a second after each pause, not word by word.

## Smoke test

- [ ] The button is hidden when signed out and appears after sign-in.
- [ ] Speaking two sentences with a pause inserts the first one while still recording.
- [ ] Silence after speech stops recording and inserts the rest.
- [ ] Holding the button or shortcut keeps recording through long pauses until release.
- [ ] Escape cancels and inserts nothing.
- [ ] Denying microphone access shows an actionable error, not an empty result.
- [ ] With auto-send on, a hands-free finish sends; clicking stop leaves a draft.
