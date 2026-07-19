import { spawn } from "node:child_process";

export function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}\n${stderr}`));
      }
    });
  });
}

export async function probeDurationSeconds(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe exited with code ${code}\n${stderr}`));
        return;
      }
      const duration = Number.parseFloat(stdout.trim());
      if (!Number.isFinite(duration)) {
        reject(new Error(`Could not parse media duration from ${stdout}`));
        return;
      }
      resolve(duration);
    });
  });
}

export type MediaDurations = {
  format: number;
  audio?: number;
  video?: number;
};

export async function probeMediaDurations(filePath: string): Promise<MediaDurations> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type,duration:format=duration",
      "-of",
      "json",
      filePath,
    ]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe exited with code ${code}\n${stderr}`));
        return;
      }
      try {
        const payload = JSON.parse(stdout) as {
          streams?: { codec_type?: string; duration?: string }[];
          format?: { duration?: string };
        };
        const parseDuration = (value: string | undefined): number | undefined => {
          const duration = Number.parseFloat(value ?? "");
          return Number.isFinite(duration) ? duration : undefined;
        };
        const format = parseDuration(payload.format?.duration);
        if (format === undefined) throw new Error(`Missing format duration in ${stdout}`);
        resolve({
          format,
          audio: parseDuration(payload.streams?.find((stream) => stream.codec_type === "audio")?.duration),
          video: parseDuration(payload.streams?.find((stream) => stream.codec_type === "video")?.duration),
        });
      } catch (error) {
        reject(new Error(`Could not parse ffprobe output for ${filePath}: ${String(error)}`));
      }
    });
  });
}

export function assertMediaDurationsAligned(
  durations: MediaDurations,
  fps: number,
  expectedDuration?: number,
): void {
  if (durations.audio === undefined || durations.video === undefined) {
    throw new Error("Encoded MP4 is missing an audio or video duration");
  }
  const drift = Math.abs(durations.video - durations.audio);
  const tolerance = Math.max(0.1, 1 / Math.max(1, fps) + 0.02);
  if (drift > tolerance) {
    throw new Error(
      `Encoded MP4 audio/video drift is ${drift.toFixed(3)}s ` +
        `(video ${durations.video.toFixed(3)}s, audio ${durations.audio.toFixed(3)}s)`,
    );
  }
  if (expectedDuration !== undefined && Math.abs(durations.format - expectedDuration) > tolerance) {
    throw new Error(
      `Encoded MP4 duration is ${durations.format.toFixed(3)}s; ` +
        `expected ${expectedDuration.toFixed(3)}s`,
    );
  }
}

export async function createSilentAudio(audioPath: string, durationSeconds: number): Promise<void> {
  await runCommand("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=channel_layout=stereo:sample_rate=44100",
    "-t",
    durationSeconds.toFixed(3),
    "-c:a",
    "pcm_s16le",
    audioPath,
  ]);
}
