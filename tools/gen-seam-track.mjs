// Compose src/audio/seam.webm — Act 4's finale music — from oscillators.
//
// COMMITTED WITH ITS OUTPUT, LIKE pack-map-icons.mjs: the .webm ships, this
// file is how it was made, and the same seed makes the same file again. The
// piece is ambient and slow: detuned pads through a moving low-pass, a sub-bass
// heartbeat at 52 BPM (the machine), a bell motif in D dorian that states a
// four-note figure and varies it, glassy overtones, and a hint of the three
// earlier regions — a horn swell (land), a noise tide every 16 bars (sea), a
// high shimmer (sky). Head and tail are quiet so music.ts's own fades meet
// cleanly across the loop.
//
//   bun tools/gen-seam-track.mjs [--keep-wav <path>] [--out src/audio/seam.webm]
//
// Writes PCM into a WAV itself and hands only the Opus encode to ffmpeg.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FFMPEG = "C:/apps/ffmpeg-6.1.1/bin/ffmpeg.exe";
const SR = 48000;
const BPM = 52;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;
const BARS = 29;
const DURATION = BARS * BAR + 2; // ~135.8 s: the last two seconds are ring-out
const N = Math.round(DURATION * SR);
const SEED = 0x5ea4;

const args = process.argv.slice(2);
const argOf = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const OUT = argOf("--out") ?? "src/audio/seam.webm";
const KEEP_WAV = argOf("--keep-wav");

// mulberry32: small, seedable, good enough for envelopes and picks.
const makeRng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const rng = makeRng(SEED);
const pick = (list) => list[Math.floor(rng() * list.length)];

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x) => {
  x = clamp01(x);
  return x * x * (3 - 2 * x);
};
// Raised-cosine attack/release around a hold: never a hard edge on any note.
const noteEnv = (t, dur, atk, rel) => {
  if (t < 0 || t > dur + rel) {
    return 0;
  }
  const a = atk > 0 ? smooth(t / atk) : 1;
  const r = t > dur ? 1 - smooth((t - dur) / rel) : 1;
  return a * r;
};

// Section intensity, bar -> 0..1, linearly interpolated: how open the filter is,
// how loud the heartbeat and how busy the sky are.
const INTENSITY = [
  [0, 0.12],
  [4, 0.45],
  [8, 0.7],
  [12, 0.85],
  [14, 0.92],
  [16, 0.55],
  [20, 0.8],
  [24, 0.72],
  [27, 0.35],
  [29, 0.08],
];
const intensityAt = (t) => {
  const b = t / BAR;
  for (let i = 1; i < INTENSITY.length; i++) {
    const [b0, v0] = INTENSITY[i - 1];
    const [b1, v1] = INTENSITY[i];
    if (b <= b1) {
      return v0 + ((v1 - v0) * (b - b0)) / (b1 - b0);
    }
  }
  return INTENSITY[INTENSITY.length - 1][1];
};

const D_DORIAN = [0, 2, 3, 5, 7, 9, 10];
const D5 = 587.33;
// Scale degree (any integer) -> Hz, octaves wrapping through the mode.
const degHz = (deg, base = D5) => {
  const oct = Math.floor(deg / 7);
  const semi = D_DORIAN[((deg % 7) + 7) % 7] + 12 * oct;
  return base * Math.pow(2, semi / 12);
};

// TPT state-variable low-pass, stable at any cutoff; coefficients per block.
class Lp {
  ic1 = 0;
  ic2 = 0;
  a1 = 0;
  a2 = 0;
  a3 = 0;
  k = 0;
  set(fc, q) {
    const g = Math.tan((Math.PI * Math.min(fc, SR * 0.45)) / SR);
    this.k = 1 / q;
    this.a1 = 1 / (1 + g * (g + this.k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }
  run(x) {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    return v2;
  }
  // Band-pass output of the same state, for the tide and the shimmer.
  runBand(x) {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    return v1;
  }
}

// One-pole high-pass: `r` near 1 is a DC block, lower thins a noise bed.
const hp = (st, x, r) => {
  const y = r * (st.y + x - st.x);
  st.x = x;
  st.y = y;
  return y;
};

const polyBlep = (t, dt) => {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
};

const L = new Float64Array(N);
const R = new Float64Array(N);
const wetL = new Float64Array(N);
const wetR = new Float64Array(N);

const addStereo = (i, v, pan, gain, wet) => {
  const l = v * gain * (1 - pan) * 0.5 + v * gain * 0.5;
  const r = v * gain * (1 + pan) * 0.5 + v * gain * 0.5;
  L[i] += l;
  R[i] += r;
  wetL[i] += l * wet;
  wetR[i] += r * wet;
};

// ---- Pads: one chord per two bars, three detuned saws + a triangle an octave down.
const CHORDS = [
  [0, 2, 4, 6, 8], // Dm9
  [2, 4, 6, 8], // F maj7
  [3, 5, 7, 9], // G6 (dorian's major IV)
  [4, 6, 8, 10], // Am7
  [0, 2, 4, 6, 8],
  [-1, 1, 3, 5], // C maj7
  [3, 5, 7, 8], // G / B  (B: the dorian sixth)
  [0, 4, 6, 8], // Dm, open
];
const PAD_BASE = D5 / 4; // D3
function renderPads() {
  const atk = 2.2;
  const rel = 2.8;
  for (let c = 0; c * 2 < BARS; c++) {
    const chord = CHORDS[c % CHORDS.length];
    const start = c * 2 * BAR;
    const dur = 2 * BAR;
    for (let n = 0; n < chord.length; n++) {
      const f = degHz(chord[n], PAD_BASE);
      const pan = (n / (chord.length - 1) - 0.5) * 0.9;
      const detune = [-0.006, 0, 0.0065];
      const ph = detune.map(() => rng());
      let phTri = rng();
      const lp = new Lp();
      const lfoPh = rng() * Math.PI * 2;
      let gain = 0;
      const i0 = Math.max(0, Math.floor(start * SR));
      const i1 = Math.min(N, Math.ceil((start + dur + rel) * SR));
      for (let i = i0; i < i1; i++) {
        const t = i / SR;
        if ((i & 63) === 0) {
          const k = intensityAt(t);
          const lfo = 0.5 + 0.5 * Math.sin(lfoPh + t * 2 * Math.PI * 0.045);
          lp.set(240 + 1500 * k * (0.55 + 0.45 * lfo), 0.9);
          gain = 0.058 * (0.5 + 0.5 * k);
        }
        let s = 0;
        for (let v = 0; v < 3; v++) {
          const dt = (f * (1 + detune[v])) / SR;
          ph[v] += dt;
          if (ph[v] >= 1) {
            ph[v] -= 1;
          }
          s += 2 * ph[v] - 1 - polyBlep(ph[v], dt);
        }
        phTri += f / 2 / SR;
        if (phTri >= 1) {
          phTri -= 1;
        }
        s = s * 0.33 + (Math.abs(4 * phTri - 2) - 1) * 0.5;
        const e = noteEnv(t - start, dur, atk, rel);
        addStereo(i, lp.run(s) * e, pan, gain, 0.5);
      }
    }
  }
}

// ---- Heartbeat: two sub pulses a beat, the second softer, tuned around D.
function renderHeartbeat() {
  const pulse = (t0, amp) => {
    const i0 = Math.floor(t0 * SR);
    const i1 = Math.min(N, i0 + Math.floor(0.9 * SR));
    let ph = 0;
    for (let i = i0; i < i1; i++) {
      const t = (i - i0) / SR;
      const f = 38 + 34 * Math.exp(-t / 0.07);
      ph += f / SR;
      const e = smooth(t / 0.006) * Math.exp(-t / 0.2) * (1 - smooth((t - 0.75) / 0.15));
      const s = Math.sin(2 * Math.PI * ph) + 0.22 * Math.sin(4 * Math.PI * ph);
      addStereo(i, s * e, 0, amp, 0.05);
    }
  };
  for (let b = 0; b * BEAT < BARS * BAR; b++) {
    const t0 = b * BEAT;
    const k = intensityAt(t0);
    const amp = 0.27 * (0.35 + 0.65 * k);
    pulse(t0, amp);
    pulse(t0 + 0.31, amp * 0.55);
  }
}

// ---- Bell motif with a ping-pong delay, D dorian, four notes stated then varied.
const MOTIF = [0, 4, 5, 2]; // D A B F
const bellL = new Float64Array(N);
const bellR = new Float64Array(N);
function bell(t0, f, amp, pan) {
  const partials = [
    [1, 1, 2.4],
    [2, 0.32, 1.6],
    [2.76, 0.18, 0.9],
    [4.07, 0.1, 0.6],
    [5.4, 0.05, 0.4],
  ];
  const i0 = Math.floor(t0 * SR);
  const i1 = Math.min(N, i0 + Math.floor(3.2 * SR));
  for (let i = i0; i < i1; i++) {
    const t = (i - i0) / SR;
    let s = 0;
    for (const [ratio, a, tau] of partials) {
      s += a * Math.sin(2 * Math.PI * f * ratio * t) * Math.exp(-t / tau);
    }
    const e = smooth(t / 0.004) * (1 - smooth((t - 3.0) / 0.2));
    const v = s * e * amp;
    bellL[i] += v * (1 - pan) * 0.5 + v * 0.5;
    bellR[i] += v * (1 + pan) * 0.5 + v * 0.5;
  }
}
function renderMotif() {
  let phrase = 0;
  for (let b = 3; b < BARS - 2; b += 2, phrase++) {
    const k = intensityAt(b * BAR);
    let notes = MOTIF.slice();
    let shift = 0;
    if (phrase >= 2) {
      const variant = pick(["plain", "retro", "invert", "up", "down", "extend"]);
      if (variant === "retro") {
        notes.reverse();
      } else if (variant === "invert") {
        notes = notes.map((d) => -d);
      } else if (variant === "up") {
        shift = pick([2, 4]);
      } else if (variant === "down") {
        shift = pick([-3, -7]);
      } else if (variant === "extend") {
        notes = [...notes, pick([7, 4, 0])];
      }
    }
    const step = pick([BEAT / 2, BEAT / 2, BEAT / 2, BEAT]);
    const rest = phrase % 3 === 2 ? BEAT / 2 : 0;
    const t0 = b * BAR + rest;
    for (let n = 0; n < notes.length; n++) {
      const t = t0 + n * step;
      if (t > (BARS - 1) * BAR) {
        break;
      }
      const f = degHz(notes[n] + shift);
      bell(t, f, 0.16 * (0.5 + 0.5 * k), n % 2 === 0 ? -0.35 : 0.35);
    }
  }
  // Ping-pong delay, dotted eighth, low-passed feedback.
  const d = Math.round(BEAT * 0.75 * SR);
  const fb = 0.42;
  const dl = new Float64Array(N);
  const dr = new Float64Array(N);
  let fl = 0;
  let fr = 0;
  for (let i = 0; i < N; i++) {
    const inL = bellL[i] + (i >= d ? dr[i - d] * fb : 0);
    const inR = bellR[i] + (i >= d ? dl[i - d] * fb : 0);
    fl += (inL - fl) * 0.18;
    fr += (inR - fr) * 0.18;
    dl[i] = fl;
    dr[i] = fr;
    const l = bellL[i] + (i >= d ? dl[i - d] * 0.55 : 0);
    const r = bellR[i] + (i >= d ? dr[i - d] * 0.55 : 0);
    L[i] += l;
    R[i] += r;
    wetL[i] += l * 0.6;
    wetR[i] += r * 0.6;
  }
}

// ---- Glass: long high sines on the mode's own overtones, slow vibrato.
function renderGlass() {
  const freqs = [D5 * 2, D5 * 3, D5 * 4, degHz(8) * 2, degHz(11) * 2];
  let t = 22 + rng() * 4;
  while (t < DURATION - 14) {
    const f = pick(freqs);
    const hold = 1.5 + rng() * 2.5;
    const atk = 2.5;
    const rel = 3.5;
    const pan = (rng() - 0.5) * 1.4;
    const vib = 0.15 + rng() * 0.15;
    const i0 = Math.floor(t * SR);
    const i1 = Math.min(N, Math.ceil((t + hold + rel) * SR));
    let ph = 0;
    for (let i = i0; i < i1; i++) {
      const tt = (i - i0) / SR;
      ph += (f * (1 + 0.0025 * Math.sin(2 * Math.PI * vib * tt))) / SR;
      const s = Math.sin(2 * Math.PI * ph) + 0.25 * Math.sin(4 * Math.PI * ph);
      addStereo(i, s * noteEnv(tt, hold, atk, rel), pan, 0.028, 0.8);
    }
    t += 7 + rng() * 6;
  }
}

// ---- Land: a low horn swell, twice, cutoff opening with the breath.
function renderHorn() {
  const swell = (t0, len) => {
    const voices = [
      [D5 / 4, -0.004],
      [D5 / 4, 0.004],
      [(D5 * 3) / 8, 0], // A3
    ];
    const ph = voices.map(() => rng());
    const lp = new Lp();
    const i0 = Math.floor(t0 * SR);
    const i1 = Math.min(N, Math.ceil((t0 + len + 3) * SR));
    for (let i = i0; i < i1; i++) {
      const t = (i - i0) / SR;
      const e = noteEnv(t, len, len * 0.7, 3);
      if ((i & 63) === 0) {
        lp.set(220 + 900 * e, 1.1);
      }
      let s = 0;
      for (let v = 0; v < voices.length; v++) {
        const dt = (voices[v][0] * (1 + voices[v][1])) / SR;
        ph[v] += dt;
        if (ph[v] >= 1) {
          ph[v] -= 1;
        }
        s += 2 * ph[v] - 1 - polyBlep(ph[v], dt);
      }
      addStereo(i, lp.run(s * 0.33) * e, 0, 0.13, 0.5);
    }
  };
  swell(11.5 * BAR, 2.5 * BEAT);
  swell(23 * BAR, 3 * BEAT);
}

// ---- Sea: a filtered-noise tide, one rise and fall every sixteen bars.
function renderTide() {
  const period = 16 * BAR;
  const lpL = new Lp();
  const lpR = new Lp();
  const hpL = { y: 0, x: 0 };
  const hpR = { y: 0, x: 0 };
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const e = 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / period);
    const ee = e * e;
    if ((i & 63) === 0) {
      lpL.set(280 + 2200 * ee, 0.7);
      lpR.set(300 + 2100 * ee, 0.7);
    }
    const nl = hp(hpL, rng() * 2 - 1, 0.985);
    const nr = hp(hpR, rng() * 2 - 1, 0.985);
    const gain = 0.05 * ee;
    const l = lpL.run(nl) * gain;
    const r = lpR.run(nr) * gain;
    L[i] += l;
    R[i] += r;
    wetL[i] += l * 0.5;
    wetR[i] += r * 0.5;
  }
}

// ---- Sky: a narrow high band of noise, wide, tremolo, only in the open sections.
function renderShimmer() {
  const bpL = new Lp();
  const bpR = new Lp();
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const k = intensityAt(t);
    const gate = smooth((t - 12 * BAR) / (2 * BAR)) * (1 - smooth((t - 26 * BAR) / (2 * BAR)));
    if (gate <= 0) {
      continue;
    }
    if ((i & 63) === 0) {
      const wob = Math.sin(2 * Math.PI * 0.031 * t);
      bpL.set(6200 + 1400 * wob, 6);
      bpR.set(6800 - 1400 * wob, 6);
    }
    const trem = 0.6 + 0.4 * Math.sin(2 * Math.PI * 0.27 * t);
    const gain = 0.02 * gate * k * trem;
    const l = bpL.runBand(rng() * 2 - 1) * gain;
    const r = bpR.runBand(rng() * 2 - 1) * gain;
    L[i] += l;
    R[i] += r;
    wetL[i] += l * 0.7;
    wetR[i] += r * 0.7;
  }
}

// ---- Reverb: Freeverb-shaped, eight combs and four allpasses per side.
function reverb(inp, out, offset) {
  const scale = SR / 44100;
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((n) => ({
    buf: new Float64Array(Math.round(n * scale) + offset),
    i: 0,
    st: 0,
  }));
  const aps = [556, 441, 341, 225].map((n) => ({
    buf: new Float64Array(Math.round(n * scale) + offset),
    i: 0,
  }));
  const fb = 0.86;
  const damp = 0.28;
  for (let n = 0; n < N; n++) {
    const x = inp[n];
    let s = 0;
    for (const c of combs) {
      const y = c.buf[c.i];
      c.st = y * (1 - damp) + c.st * damp;
      c.buf[c.i] = x + c.st * fb;
      if (++c.i >= c.buf.length) {
        c.i = 0;
      }
      s += y;
    }
    for (const a of aps) {
      const y = a.buf[a.i];
      const v = s + y * -0.5;
      a.buf[a.i] = v;
      s = y + v * 0.5;
      if (++a.i >= a.buf.length) {
        a.i = 0;
      }
    }
    out[n] += s * 0.045;
  }
}

const started = Date.now();
renderPads();
renderHeartbeat();
renderMotif();
renderGlass();
renderHorn();
renderTide();
renderShimmer();
reverb(wetL, L, 0);
reverb(wetR, R, 23);

// ---- Master: DC block, soft clip, edge fades, peak-normalise to -1 dBFS.
const CEIL = Math.pow(10, -1 / 20);
const dcL = { y: 0, x: 0 };
const dcR = { y: 0, x: 0 };
let prePeak = 0;
let peak = 0;
for (let i = 0; i < N; i++) {
  prePeak = Math.max(prePeak, Math.abs(L[i]), Math.abs(R[i]));
  const t = i / SR;
  const fade = smooth(t / 1) * (1 - smooth((t - (DURATION - 3)) / 3));
  L[i] = Math.tanh(hp(dcL, L[i], 0.9985) * 1.15) * fade;
  R[i] = Math.tanh(hp(dcR, R[i], 0.9985) * 1.15) * fade;
  peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
}
const norm = CEIL / peak;

// ---- WAV (16-bit PCM, TPDF dither) and stats.
const wav = Buffer.alloc(44 + N * 4);
wav.write("RIFF", 0);
wav.writeUInt32LE(36 + N * 4, 4);
wav.write("WAVE", 8);
wav.write("fmt ", 12);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(2, 22);
wav.writeUInt32LE(SR, 24);
wav.writeUInt32LE(SR * 4, 28);
wav.writeUInt16LE(4, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(N * 4, 40);
const WIN = 10 * SR;
const rmsWindows = [];
let acc = 0;
let clipped = 0;
let outPeak = 0;
let dcSum = 0;
for (let i = 0; i < N; i++) {
  const l = L[i] * norm;
  const r = R[i] * norm;
  acc += l * l + r * r;
  dcSum += l + r;
  outPeak = Math.max(outPeak, Math.abs(l), Math.abs(r));
  if (Math.abs(l) >= 1 || Math.abs(r) >= 1) {
    clipped++;
  }
  if ((i + 1) % WIN === 0 || i === N - 1) {
    const n = (i % WIN) + 1;
    rmsWindows.push(+(20 * Math.log10(Math.sqrt(acc / (2 * n)) + 1e-12)).toFixed(1));
    acc = 0;
  }
  const dl = (rng() + rng() - 1) / 32768;
  const dr = (rng() + rng() - 1) / 32768;
  wav.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((l + dl) * 32767))), 44 + i * 4);
  wav.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((r + dr) * 32767))), 46 + i * 4);
}

const dir = KEEP_WAV ? null : mkdtempSync(join(tmpdir(), "seam-"));
const wavPath = KEEP_WAV ?? join(dir, "seam.wav");
writeFileSync(wavPath, wav);
const enc = spawnSync(
  FFMPEG,
  // bitexact (an OUTPUT option): the Matroska muxer otherwise stamps a random
  // SegmentUID and a regenerated file would differ byte-for-byte.
  ["-y", "-loglevel", "error", "-i", wavPath, "-fflags", "+bitexact", "-c:a", "libopus", "-b:a", "64k", OUT],
  { stdio: "inherit" },
);
if (dir) {rmSync(dir, { recursive: true, force: true });}
if (enc.error || enc.status !== 0) {
  console.error(enc.error?.message ?? `ffmpeg exited ${enc.status}`);
  process.exit(1);
}
console.log(
  JSON.stringify({
    out: OUT,
    bytes: statSync(OUT).size,
    seconds: +DURATION.toFixed(2),
    peakDb: +(20 * Math.log10(outPeak)).toFixed(2),
    prePeak: +prePeak.toFixed(3),
    dcOffset: +(dcSum / (2 * N)).toExponential(2),
    clipped,
    rmsDb10s: rmsWindows,
    renderMs: Date.now() - started,
  }),
);
