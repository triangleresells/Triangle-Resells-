/**
 * The edit plan: everything the renderer needs to turn raw clips into a finished Reel. Claude writes it (planner.ts);
 * checkPlan() makes sure it can actually be rendered before any FFmpeg runs.
 */

export type Account = "resells" | "scales" | "sales";

/** One kept piece of a raw clip, in the order it plays. Times are seconds in that clip. */
export interface Segment {
  clip: number;
  start: number;
  end: number;
  /** Punch-in: 1 = full frame, 1.15 / 1.3 = zoomed in (a "cut" feel without changing the shot). */
  zoom?: number;
}

/** On-screen text (not the captions). Times are seconds in the FINISHED video. */
export interface Overlay {
  text: string;
  start: number;
  end: number;
  position: "top" | "center" | "bottom";
}

export interface EditPlan {
  account: Account;
  segments: Segment[];
  /** Burn word-by-word captions from the transcript. */
  captions: boolean;
  overlays: Overlay[];
  /** Background music: a file name from the royalty-free library, and how loud (0-1) under the voice. */
  music?: { track: string; volume: number } | null;
  /** Second of the FINISHED video to use as the cover. */
  coverTime: number;
  /** Instagram caption and hashtags for the account. */
  caption: string;
  hashtags: string[];
}

export interface ClipInfo {
  path: string;
  width: number;
  height: number;
  duration: number;
  hasAudio: boolean;
}

export const OUT_W = 1080;
export const OUT_H = 1920;
export const MAX_REEL_SECONDS = 90;

/** Length of the finished video. */
export const planDuration = (p: Pick<EditPlan, "segments">) => p.segments.reduce((t, s) => t + (s.end - s.start), 0);

/** Problems that would make the plan unrenderable, in plain words. Empty = OK. */
export function checkPlan(p: EditPlan, clips: ClipInfo[], musicTracks: string[] = []): string[] {
  const problems: string[] = [];
  if (!p.segments?.length) problems.push("the plan keeps no clips");
  p.segments?.forEach((s, i) => {
    const c = clips[s.clip];
    if (!c) return problems.push(`segment ${i + 1} uses clip ${s.clip + 1}, which wasn't uploaded`);
    if (!(s.start >= 0 && s.end > s.start)) problems.push(`segment ${i + 1} has bad times (${s.start}-${s.end})`);
    if (s.end > c.duration + 0.05) problems.push(`segment ${i + 1} ends at ${s.end}s but clip ${s.clip + 1} is only ${c.duration.toFixed(2)}s`);
    if (s.end - s.start < 0.3) problems.push(`segment ${i + 1} is shorter than 0.3s`);
    if (s.zoom !== undefined && !(s.zoom >= 1 && s.zoom <= 1.6)) problems.push(`segment ${i + 1} zoom must be 1 to 1.6`);
  });
  const total = planDuration(p);
  if (total > MAX_REEL_SECONDS) problems.push(`the video would be ${total.toFixed(1)}s; Reels made here stay under ${MAX_REEL_SECONDS}s`);
  p.overlays?.forEach((o, i) => {
    if (!o.text?.trim()) problems.push(`overlay ${i + 1} has no text`);
    if (!(o.start >= 0 && o.end > o.start && o.start < total)) problems.push(`overlay ${i + 1} times don't fit the video`);
  });
  if (p.music && !musicTracks.includes(p.music.track)) problems.push(`music "${p.music.track}" isn't in the music library`);
  if (p.music && !(p.music.volume >= 0 && p.music.volume <= 1)) problems.push("music volume must be 0 to 1");
  if (!(p.coverTime >= 0 && p.coverTime < Math.max(total, 0.01))) problems.push("the cover time is outside the video");
  if (!p.caption?.trim()) problems.push("no Instagram caption");
  return problems;
}
