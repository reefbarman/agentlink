import type {
  VoiceRecorderWorkerCommand,
  VoiceRecorderWorkerData,
  VoiceRecorderWorkerReply,
} from "./voiceRecorderProtocol.js";
/**
 * Worker-thread microphone capture. pvrecorder's frame read blocks until audio
 * is available, so it must never run on the extension host thread.
 */
import { parentPort, workerData } from "node:worker_threads";

const FRAME_LENGTH = 512;
const MICROPHONE_ACCESS_HINT =
  "No microphone is available. Check that a microphone is connected and that VS Code is allowed to use it (macOS: System Settings > Privacy & Security > Microphone).";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function run(): Promise<void> {
  const port = parentPort;
  if (!port) return;
  const reply = (message: VoiceRecorderWorkerReply, transfer?: ArrayBuffer[]) =>
    port.postMessage(message, transfer);
  const { maxSamples } = workerData as VoiceRecorderWorkerData;

  let stopRequest: VoiceRecorderWorkerCommand["type"] | null = null;
  port.on("message", (command: VoiceRecorderWorkerCommand) => {
    stopRequest ??= command.type;
  });

  let PvRecorder: typeof import("@picovoice/pvrecorder-node").PvRecorder;
  try {
    ({ PvRecorder } = await import("@picovoice/pvrecorder-node"));
  } catch (error) {
    reply({
      type: "error",
      code: "recorder_unavailable",
      message: `The microphone recorder could not be loaded: ${errorMessage(error)}`,
    });
    return;
  }

  let recorder: InstanceType<typeof PvRecorder>;
  try {
    recorder = new PvRecorder(FRAME_LENGTH, -1);
    recorder.start();
  } catch (error) {
    reply({
      type: "error",
      code: "microphone_unavailable",
      message: `Could not open the microphone: ${errorMessage(error)}`,
    });
    return;
  }

  let device: string | undefined;
  try {
    device = recorder.getSelectedDevice();
  } catch {
    device = undefined;
  }
  // Without microphone permission, pvrecorder silently falls back to a null
  // device that records zeros. Fail clearly instead of transcribing silence.
  if (device && /^null capture device$/iu.test(device.trim())) {
    try {
      recorder.stop();
    } finally {
      recorder.release();
    }
    reply({
      type: "error",
      code: "microphone_unavailable",
      message: MICROPHONE_ACCESS_HINT,
    });
    return;
  }
  reply({ type: "started", sampleRate: recorder.sampleRate, device });

  const frames: Int16Array[] = [];
  let samples = 0;
  let limitReported = false;
  try {
    while (!stopRequest) {
      const frame = await recorder.read();
      if (samples + frame.length <= maxSamples) {
        frames.push(frame);
        samples += frame.length;
      } else if (!limitReported) {
        limitReported = true;
        reply({ type: "limit" });
      }
    }
  } catch (error) {
    reply({
      type: "error",
      code: "read_failed",
      message: `Recording failed: ${errorMessage(error)}`,
    });
    return;
  } finally {
    try {
      recorder.stop();
    } catch {
      // Releasing below is still required.
    }
    recorder.release();
  }

  if (stopRequest === "cancel") {
    reply({ type: "cancelled" });
    return;
  }
  const pcm = new Int16Array(samples);
  let offset = 0;
  for (const frame of frames) {
    pcm.set(frame, offset);
    offset += frame.length;
  }
  reply({ type: "audio", pcm: pcm.buffer, sampleRate: recorder.sampleRate }, [
    pcm.buffer,
  ]);
}

void run();
