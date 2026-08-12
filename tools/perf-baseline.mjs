// Frame-cost baseline, PER MACHINE.
//
//   bun tools/perf-baseline.mjs record     write this machine's baseline
//   bun tools/perf-baseline.mjs            compare the working tree against it
//   bun tools/perf-baseline.mjs --json     the same, as JSON
//
// (dev server must be up)
//
// WHY A BASELINE AT ALL, AND WHY IT IS NOT IN THE REPO. Frame cost is a property
// of the machine as much as of the code: a number that means "slow" on a laptop
// is a good result on a workstation, and a committed baseline would fail for
// everyone whose hardware is not the hardware it was recorded on. So this writes
// `.perf-baseline.json` in the project root, gitignored, and every developer
// records their own. It stores the GPU string and the viewport alongside the
// numbers and refuses to compare across a change in either, because those move
// the result far more than any commit does.
//
// VSYNC IS LEFT ON, DELIBERATELY, and this is the correction that produced this
// tool. An earlier run passed --disable-gpu-vsync to "measure properly", got
// 186-368 fps, and concluded from it that making the frame cheaper does not
// reduce CPU — because with no cap the loop simply ran more often and ate every
// saving. A real player is locked to their monitor, so the FRAME COUNT IS FIXED
// and a cheaper frame is straightforwardly less CPU. Measuring without vsync
// answers a question nobody has.
//
// The number that matters is therefore `cpu` — milliseconds of main thread per
// frame — and `coreLoad`, which is cpu/wall: the fraction of a core the game
// burns at this machine's refresh rate. fps is reported but is NOT a regression
// signal here; pinned to the display, it barely moves until things are dire.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { launchBrowser, newPage, wait, glRenderer } from "./browser.mjs";
import { BASE as HOST } from "./target.mjs";

const FILE = new URL("../.perf-baseline.json", import.meta.url);
const W = 1280;
const H = 800;
/** Frames of steady-state walking to average over, after the warm-up. */
const SAMPLE_MS = 12000;

const args = new Set(process.argv.slice(2));
const recording = args.has("record");
const asJson = args.has("--json");

/**
 * One scripted run: boot, let the streamer settle, then walk in a straight line
 * for SAMPLE_MS with the profiler on.
 *
 * Walking rather than standing on purpose — a standing frame never builds a
 * chunk, and chunk building is the one gameplay cost in this engine big enough
 * to see. The route is a held W from the spawn, which is the same ground every
 * time because terrain is a pure function of the seed.
 */
async function measure() {
  // No GL flags: hardware path if the host has one, and VSYNC LEFT ALONE — see
  // the header. AGENTS.md says the same thing about captures for the same reason.
  const browser = await launchBrowser();
  const page = await newPage(browser, { width: W, height: H });
  page.on("pageerror", (e) => console.error("[page]", e.message));
  await page.goto(`${HOST}/?menu=0&fs=0&perf=1&debug=1`, { waitUntil: "load" });
  await page.waitForSelector("canvas");
  await wait(8000);
  await page.focus("canvas").catch(() => {});

  const gl = await glRenderer(page);

  await page.keyboard.down("KeyW");
  // Discard the first seconds: the streamer is still catching up and the first
  // draw of each material is still linking programs.
  await wait(4000);
  const from = (await page.evaluate(() => window.__dbgPerf())).rows.length;
  await wait(SAMPLE_MS);
  const dump = await page.evaluate(() => window.__dbgPerf());
  const overlay = await page.evaluate(() => {
    const el = [...document.body.children].find(
      (c) => c instanceof HTMLDivElement && (c.textContent || "").startsWith("FPS"),
    );
    return el ? el.textContent : "";
  });
  await page.keyboard.up("KeyW");
  await browser.close();

  const rows = dump.rows.slice(from);
  if (rows.length < 60) {
    throw new Error(`only ${rows.length} frames sampled — is the game running?`);
  }
  const idx = Object.fromEntries(dump.sections.map((s, i) => [s, i]));
  const mean = (c) => rows.reduce((a, r) => a + r[c], 0) / rows.length;
  const p99 = (c) => {
    const v = rows.map((r) => r[c]).sort((a, b) => a - b);
    return v[Math.floor(v.length * 0.99)];
  };

  const sections = {};
  for (const s of dump.sections) {
    sections[s] = +mean(idx[s]).toFixed(3);
  }
  const draws = /draws\s+(\d+)/.exec(overlay);
  const scene = /scene\s+(\d+)\s+\+(\d+) post/.exec(overlay);

  return {
    gl,
    viewport: `${W}x${H}`,
    frames: rows.length,
    sections,
    cpuP99: +p99(idx.cpu).toFixed(3),
    wallP99: +p99(idx.wall).toFixed(3),
    fps: +(1000 / mean(idx.wall)).toFixed(1),
    coreLoad: +(mean(idx.cpu) / mean(idx.wall)).toFixed(3),
    draws: draws ? +draws[1] : null,
    sceneDraws: scene ? +scene[1] : null,
    postDraws: scene ? +scene[2] : null,
  };
}

const now = await measure();

if (recording) {
  const rec = { ...now, recorded: new Date().toISOString() };
  writeFileSync(FILE, `${JSON.stringify(rec, null, 2)}\n`);
  console.log(`baseline written to .perf-baseline.json (gitignored)\n`);
  console.log(`  gpu        ${rec.gl}`);
  console.log(`  cpu/frame  ${rec.sections.cpu} ms   (p99 ${rec.cpuP99})`);
  console.log(`  core load  ${(rec.coreLoad * 100).toFixed(1)}%  at ${rec.fps} fps`);
  console.log(`  draws      ${rec.draws}  (${rec.sceneDraws} scene + ${rec.postDraws} post)`);
  process.exit(0);
}

if (!existsSync(FILE)) {
  console.error("No .perf-baseline.json on this machine.\n");
  console.error("Record one first, on a quiet machine and on a commit you trust:\n");
  console.error("  bun tools/perf-baseline.mjs record\n");
  console.error("It is per-machine and gitignored — never commit it.");
  process.exit(2);
}

const base = JSON.parse(readFileSync(FILE, "utf8"));

if (asJson) {
  console.log(JSON.stringify({ baseline: base, now }, null, 2));
} else {
  const warn = [];
  if (base.gl !== now.gl) {
    warn.push(`GPU changed: "${base.gl}" -> "${now.gl}"`);
  }
  if (base.viewport !== now.viewport) {
    warn.push(`viewport changed: ${base.viewport} -> ${now.viewport}`);
  }

  const pct = (a, b) => (a === 0 ? 0 : ((b - a) / a) * 100);
  const row = (name, a, b, unit = "ms") => {
    const d = pct(a, b);
    const mark = Math.abs(d) < 3 ? "  " : d > 0 ? "↑↑" : "↓↓";
    return (
      `${name.padEnd(10)}${String(a).padStart(8)} ${String(b).padStart(8)} ${unit.padEnd(3)}` +
      `${(d >= 0 ? "+" : "") + d.toFixed(1)}%`.padStart(9) +
      `  ${mark}`
    );
  };

  console.log(`baseline recorded ${base.recorded}`);
  console.log(`gpu ${now.gl}\n`);
  console.log(`${"".padEnd(10)}${"base".padStart(8)} ${"now".padStart(8)}`);
  console.log(row("cpu", base.sections.cpu, now.sections.cpu));
  console.log(row("  render", base.sections.render, now.sections.render));
  console.log(row("  world", base.sections.world, now.sections.world));
  console.log(row("  beasts", base.sections.beasts, now.sections.beasts));
  console.log(row("  combat", base.sections.combat, now.sections.combat));
  console.log(row("  hud", base.sections.hud, now.sections.hud));
  console.log(row("  player", base.sections.player, now.sections.player));
  console.log(row("cpu p99", base.cpuP99, now.cpuP99));
  console.log(row("wall", base.sections.wall, now.sections.wall));
  console.log(row("coreLoad", base.coreLoad, now.coreLoad, ""));
  console.log(row("draws", base.draws, now.draws, ""));
  console.log(`\nfps ${base.fps} -> ${now.fps}  (pinned to the display; not a regression signal)`);
  for (const w of warn) {
    console.log(`\nWARNING: ${w} — the comparison is not meaningful.`);
  }
}

// `cpu` is the signal: it is the main-thread cost of one frame, and with the
// frame count pinned by vsync it is directly proportional to CPU burned. 8% is
// wide enough to survive run-to-run noise on a busy desktop (measured spread
// over four back-to-back runs was under 4%) and tight enough to catch a real
// regression.
const drift = ((now.sections.cpu - base.sections.cpu) / base.sections.cpu) * 100;
if (drift > 8) {
  console.error(`\ncpu/frame is ${drift.toFixed(1)}% over baseline.`);
  process.exit(1);
}
