/**
 * FFmpeg: probing raw clips, pulling frames for Claude to look at, and rendering an edit plan into a 9:16 Reel.
 * Uses the FFmpeg bundled with npm (ffmpeg-static / ffprobe-static), so nothing has to be installed on the server.
 */
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import ffmpegPath from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import { assFile, captionChunks, timelineWords, type Word } from "./captions.js";
import { OUT_H, OUT_W, planDuration, type ClipInfo, type EditPlan } from "./plan.js";

const run = promisify(execFile);
const FFMPEG = ffmpegPath as unknown as string;
const FFPROBE = ffprobe.path;

/** Size (as it plays, rotation applied), length and whether it has sound. */
export async function probe(file: string): Promise<ClipInfo> {
  const { stdout } = await run(FFPROBE, ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file], { maxBuffer: 10 * 1024 * 1024 });
  const j = JSON.parse(stdout) as { streams: any[]; format: { duration?: string } };
  const v = j.streams.find((s) => s.codec_type === "video");
  if (!v) throw new Error(`${path.basename(file)} has no video`);
  const rotation = Number(v.side_data_list?.find((d: any) => d.rotation !== undefined)?.rotation ?? v.tags?.rotate ?? 0);
  const sideways = Math.abs(rotation) % 180 === 90;
  return {
    path: file,
    width: sideways ? v.height : v.width,
    height: sideways ? v.width : v.height,
    duration: Number(j.format.duration ?? v.duration ?? 0),
    hasAudio: j.streams.some((s) => s.codec_type === "audio"),
  };
}

/** `count` still frames spread over the clip (small JPEGs), for Claude to see what's in it. Returns [time, file]. */
export async function frames(clip: ClipInfo, count: number, outDir: string, prefix: string): Promise<{ t: number; file: string }[]> {
  mkdirSync(outDir, { recursive: true });
  const out: { t: number; file: string }[] = [];
  for (let i = 0; i < count; i++) {
    const t = Math.min(clip.duration - 0.05, ((i + 0.5) * clip.duration) / count);
    const file = path.join(outDir, `${prefix}-${i}.jpg`);
    await run(FFMPEG, ["-y", "-v", "error", "-ss", t.toFixed(2), "-i", clip.path, "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "5", file]);
    out.push({ t, file });
  }
  return out;
}

const even = (n: number) => Math.round(n / 2) * 2;
const sec = (n: number) => n.toFixed(3);

/** The FFmpeg filter graph for a plan: cut, punch-in, 9:16 crop, captions / overlays, music. */
export function filterGraph(plan: EditPlan, clips: ClipInfo[], opts: { subs?: string; musicInput?: number }): string {
  const parts: string[] = [];
  plan.segments.forEach((s, i) => {
    const c = clips[s.clip];
    const z = s.zoom ?? 1;
    // Fill the 9:16 frame (crop the sides of a wide shot), zoomed in for a punch-in, centered.
    parts.push(`[${s.clip}:v]trim=start=${sec(s.start)}:end=${sec(s.end)},setpts=PTS-STARTPTS,fps=30,scale=w=${even(OUT_W * z)}:h=${even(OUT_H * z)}:force_original_aspect_ratio=increase,crop=${OUT_W}:${OUT_H},setsar=1[v${i}]`);
    parts.push(
      c.hasAudio
        ? `[${s.clip}:a]atrim=start=${sec(s.start)}:end=${sec(s.end)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo[a${i}]`
        : `anullsrc=r=48000:cl=stereo,atrim=duration=${sec(s.end - s.start)}[a${i}]`,
    );
  });
  parts.push(`${plan.segments.map((_, i) => `[v${i}][a${i}]`).join("")}concat=n=${plan.segments.length}:v=1:a=1[vc][ac]`);
  parts.push(opts.subs ? `[vc]subtitles=${opts.subs}[vout]` : `[vc]null[vout]`);
  if (opts.musicInput !== undefined && plan.music) {
    const total = planDuration(plan);
    parts.push(`[${opts.musicInput}:a]aloop=loop=-1:size=2000000000,atrim=duration=${sec(total)},volume=${plan.music.volume.toFixed(2)},afade=t=out:st=${sec(Math.max(0, total - 1.5))}:d=1.5,aresample=48000,aformat=channel_layouts=stereo[mus]`);
    parts.push(`[ac][mus]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`);
  } else {
    parts.push(`[ac]anull[aout]`);
  }
  return parts.join(";");
}

/**
 * Renders the plan: out.mp4 (1080x1920, 30fps, H.264 + AAC, ready for Reels) and cover.jpg in `workDir`.
 * words: the transcript (for captions). musicFile: the chosen track, if any.
 */
export async function render(opts: { plan: EditPlan; clips: ClipInfo[]; words: Word[]; workDir: string; musicFile?: string }): Promise<{ video: string; cover: string }> {
  const { plan, clips, workDir } = opts;
  mkdirSync(workDir, { recursive: true });
  const captions = plan.captions ? captionChunks(timelineWords(opts.words, plan.segments)) : [];
  let subs: string | undefined;
  if (captions.length || plan.overlays.length) {
    // Written next to the output and referenced by a plain name (FFmpeg runs in workDir), so Windows paths can't break the filter.
    writeFileSync(path.join(workDir, "subs.ass"), assFile({ captions, overlays: plan.overlays }));
    subs = "subs.ass";
  }
  const musicInput = plan.music && opts.musicFile ? clips.length : undefined;
  const args = [
    "-y", "-v", "error",
    ...clips.flatMap((c) => ["-i", path.resolve(c.path)]),
    ...(musicInput !== undefined ? ["-i", path.resolve(opts.musicFile!)] : []),
    "-filter_complex", filterGraph(plan, clips, { subs, musicInput }),
    "-map", "[vout]", "-map", "[aout]",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", "30",
    "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart",
    "out.mp4",
  ];
  await run(FFMPEG, args, { cwd: workDir, maxBuffer: 20 * 1024 * 1024 });
  const total = planDuration(plan);
  await run(FFMPEG, ["-y", "-v", "error", "-ss", sec(Math.min(plan.coverTime, Math.max(0, total - 0.1))), "-i", "out.mp4", "-frames:v", "1", "-q:v", "3", "cover.jpg"], { cwd: workDir });
  return { video: path.join(workDir, "out.mp4"), cover: path.join(workDir, "cover.jpg") };
}

/** Makes a test clip (moving test picture + a tone), for tests. */
export async function makeTestClip(file: string, opts: { seconds: number; width: number; height: number; audio: boolean; hz?: number }) {
  mkdirSync(path.dirname(file), { recursive: true });
  const args = ["-y", "-v", "error", "-f", "lavfi", "-i", `testsrc2=size=${opts.width}x${opts.height}:rate=30:duration=${opts.seconds}`];
  if (opts.audio) args.push("-f", "lavfi", "-i", `sine=frequency=${opts.hz ?? 440}:duration=${opts.seconds}`);
  args.push("-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", ...(opts.audio ? ["-c:a", "aac", "-shortest"] : []), file);
  await run(FFMPEG, args);
}
