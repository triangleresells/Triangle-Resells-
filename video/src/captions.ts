/**
 * Captions: the transcript's words (timed in each raw clip) mapped onto the finished video's timeline, grouped into
 * short bursts (2-4 words, the Reels style), and written as an ASS subtitle file that FFmpeg burns in. On-screen text
 * overlays go in the same file with their own style.
 */
import type { Overlay, Segment } from "./plan.js";

/** A word from speech-to-text. start/end are seconds in its raw clip. */
export interface Word {
  clip: number;
  text: string;
  start: number;
  end: number;
}

/** Words that survive the edit, re-timed to the finished video (cut words disappear). */
export function timelineWords(words: Word[], segments: Segment[]): Word[] {
  const out: Word[] = [];
  let offset = 0;
  for (const s of segments) {
    for (const w of words) {
      if (w.clip !== s.clip) continue;
      const mid = (w.start + w.end) / 2;
      if (mid < s.start || mid >= s.end) continue;
      out.push({ clip: w.clip, text: w.text, start: Math.max(0, w.start - s.start) + offset, end: Math.min(s.end, w.end) - s.start + offset });
    }
    offset += s.end - s.start;
  }
  return out;
}

/** Groups words into caption bursts: up to `maxWords` words / ~16 characters, split at pauses and sentence ends. */
export function captionChunks(words: Word[], maxWords = 3, maxChars = 16): { text: string; start: number; end: number }[] {
  const chunks: { text: string; start: number; end: number }[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (!cur.length) return;
    chunks.push({ text: cur.map((w) => w.text).join(" "), start: cur[0].start, end: cur[cur.length - 1].end });
    cur = [];
  };
  for (const w of words) {
    const text = [...cur.map((x) => x.text), w.text].join(" ");
    const pause = cur.length && w.start - cur[cur.length - 1].end > 0.35;
    if (cur.length && (cur.length >= maxWords || text.length > maxChars || pause)) flush();
    cur.push(w);
    if (/[.!?]$/.test(w.text)) flush();
  }
  flush();
  // No gaps that flash: each chunk stays until the next one starts (if that's soon).
  for (let i = 0; i < chunks.length - 1; i++) if (chunks[i + 1].start - chunks[i].end < 0.4) chunks[i].end = chunks[i + 1].start;
  return chunks;
}

/** Seconds -> ASS time "H:MM:SS.cc". */
export function assTime(t: number): string {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

/** Text safe for an ASS line (no override braces, line breaks as \N). */
const assText = (t: string) => t.replace(/[{}]/g, "").replace(/\r?\n/g, "\\N").trim();

/**
 * The ASS file: big bold white captions with a black outline in the lower third, and overlays (top / center / bottom)
 * in a boxed style. Sized for 1080x1920.
 */
export function assFile(opts: { captions: { text: string; start: number; end: number }[]; overlays: Overlay[]; font?: string; upper?: boolean }): string {
  const font = opts.font ?? "Arial";
  const head = [
    "[Script Info]", "ScriptType: v4.00+", "PlayResX: 1080", "PlayResY: 1920", "WrapStyle: 0", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    // Captions: lower third, white, thick black outline.
    `Style: Caption,${font},88,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,7,2,2,80,80,560,1`,
    // Overlays: boxed text (BorderStyle 3 = opaque box), gold-ish on black.
    `Style: Top,${font},68,&H004AB5D9,&H004AB5D9,&H00000000,&HB4000000,-1,0,0,0,100,100,0,0,3,18,0,8,70,70,220,1`,
    `Style: Center,${font},76,&H00FFFFFF,&H00FFFFFF,&H00000000,&HB4000000,-1,0,0,0,100,100,0,0,3,18,0,5,70,70,0,1`,
    `Style: Bottom,${font},64,&H00FFFFFF,&H00FFFFFF,&H00000000,&HB4000000,-1,0,0,0,100,100,0,0,3,16,0,2,70,70,300,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const lines = [
    ...opts.captions.map((c) => `Dialogue: 1,${assTime(c.start)},${assTime(c.end)},Caption,,0,0,0,,${assText(opts.upper === false ? c.text : c.text.toUpperCase())}`),
    ...opts.overlays.map((o) => `Dialogue: 2,${assTime(o.start)},${assTime(o.end)},${o.position === "top" ? "Top" : o.position === "center" ? "Center" : "Bottom"},,0,0,0,,${assText(o.text)}`),
  ];
  return [...head, ...lines, ""].join("\n");
}
