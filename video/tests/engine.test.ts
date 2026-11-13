import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { assFile, assTime, captionChunks, timelineWords, type Word } from "../src/captions.js";
import { frames, makeTestClip, probe, render } from "../src/ffmpeg.js";
import { checkPlan, planDuration, type ClipInfo, type EditPlan } from "../src/plan.js";

const dir = path.join(os.tmpdir(), `triangle-video-test-${process.pid}`);
let wide: ClipInfo;
let tall: ClipInfo;
let music: string;

beforeAll(async () => {
  await makeTestClip(path.join(dir, "raw", "wide.mp4"), { seconds: 6, width: 1280, height: 720, audio: true });
  await makeTestClip(path.join(dir, "raw", "tall.mp4"), { seconds: 5, width: 720, height: 1280, audio: false });
  await makeTestClip(path.join(dir, "raw", "music.mp4"), { seconds: 3, width: 64, height: 64, audio: true, hz: 220 });
  wide = await probe(path.join(dir, "raw", "wide.mp4"));
  tall = await probe(path.join(dir, "raw", "tall.mp4"));
  music = path.join(dir, "raw", "music.mp4");
}, 120_000);

const words: Word[] = [
  { clip: 0, text: "How", start: 0.2, end: 0.4 }, { clip: 0, text: "I", start: 0.45, end: 0.5 }, { clip: 0, text: "flipped", start: 0.55, end: 0.9 },
  { clip: 0, text: "$200", start: 0.95, end: 1.4 }, { clip: 0, text: "into", start: 1.45, end: 1.6 }, { clip: 0, text: "$2,000.", start: 1.65, end: 2.2 },
  { clip: 0, text: "um", start: 2.4, end: 2.7 }, // cut out by the plan below
  { clip: 0, text: "Here's", start: 3.1, end: 3.4 }, { clip: 0, text: "how.", start: 3.45, end: 3.8 },
];
const plan: EditPlan = {
  account: "scales",
  segments: [
    { clip: 0, start: 0, end: 2.3 },
    { clip: 0, start: 3.0, end: 4.0, zoom: 1.3 },
    { clip: 1, start: 1, end: 3, zoom: 1.15 },
  ],
  captions: true,
  overlays: [{ text: "$200 -> $2,000", start: 0, end: 2, position: "top" }],
  music: { track: "music.mp4", volume: 0.15 },
  coverTime: 0.5,
  caption: "How I flipped $200 into $2,000 (TEST)",
  hashtags: ["#reselling"],
};

describe("edit plan checks", () => {
  it("accepts a good plan and explains what's wrong with a bad one", () => {
    expect(checkPlan(plan, [wide, tall], ["music.mp4"])).toEqual([]);
    expect(planDuration(plan)).toBeCloseTo(5.3, 5);
    const bad: EditPlan = { ...plan, segments: [{ clip: 2, start: 0, end: 1 }, { clip: 0, start: 5, end: 9 }], music: { track: "nope.mp3", volume: 2 }, caption: "" };
    expect(checkPlan(bad, [wide, tall], ["music.mp4"])).toEqual([
      "segment 1 uses clip 3, which wasn't uploaded",
      "segment 2 ends at 9s but clip 1 is only 6.00s",
      'music "nope.mp3" isn\'t in the music library',
      "music volume must be 0 to 1",
      "no Instagram caption",
    ]);
  });
});

describe("captions", () => {
  it("re-times kept words onto the finished video and drops cut ones", () => {
    const t = timelineWords(words, plan.segments);
    expect(t.map((w) => w.text)).toEqual(["How", "I", "flipped", "$200", "into", "$2,000.", "Here's", "how."]);
    const heres = t.find((w) => w.text === "Here's")!;
    expect(heres.start).toBeCloseTo(2.3 + 0.1, 5); // segment 2 starts at 2.3s in the finished video
  });

  it("groups words into short bursts and writes the ASS file", () => {
    const chunks = captionChunks(timelineWords(words, plan.segments));
    expect(chunks.map((c) => c.text)).toEqual(["How I flipped", "$200 into", "$2,000.", "Here's how."]); // "$200 into $2,000." is over 16 characters
    expect(assTime(65.237)).toBe("0:01:05.24");
    const ass = assFile({ captions: chunks, overlays: plan.overlays });
    expect(ass).toContain("PlayResX: 1080");
    expect(ass).toContain("Caption,,0,0,0,,HOW I FLIPPED");
    expect(ass).toContain("Top,,0,0,0,,$200 -> $2,000");
  });
});

describe("rendering (real FFmpeg)", () => {
  it("probes phone clips: size, length, sound", () => {
    expect(wide).toMatchObject({ width: 1280, height: 720, hasAudio: true });
    expect(tall).toMatchObject({ width: 720, height: 1280, hasAudio: false });
    expect(wide.duration).toBeCloseTo(6, 0);
  });

  it("pulls frames for Claude to look at", async () => {
    const f = await frames(wide, 3, path.join(dir, "frames"), "clip0");
    expect(f.map((x) => Math.round(x.t))).toEqual([1, 3, 5]);
    expect(f.every((x) => existsSync(x.file) && statSync(x.file).size > 500)).toBe(true);
  });

  it("renders a 1080x1920 Reel with cuts, punch-ins, captions, text, music and a cover", async () => {
    const out = await render({ plan, clips: [wide, tall], words, workDir: path.join(dir, "edit1"), musicFile: music });
    const v = await probe(out.video);
    expect(v).toMatchObject({ width: 1080, height: 1920, hasAudio: true });
    expect(v.duration).toBeGreaterThan(5.1);
    expect(v.duration).toBeLessThan(5.6);
    expect(statSync(out.cover).size).toBeGreaterThan(5000);
    expect(readFileSync(path.join(dir, "edit1", "subs.ass"), "utf8")).toContain("HERE'S HOW.");
  }, 180_000);

  it("renders a plain cut (no captions, text or music)", async () => {
    const out = await render({ plan: { ...plan, captions: false, overlays: [], music: null }, clips: [wide, tall], words: [], workDir: path.join(dir, "edit2") });
    expect(await probe(out.video)).toMatchObject({ width: 1080, height: 1920, hasAudio: true });
    expect(existsSync(path.join(dir, "edit2", "subs.ass"))).toBe(false);
  }, 180_000);
});
