// SAVE A .blend, GET A .glb — and a browser that reloads on its own.
//
// Two halves that share one code path:
//
//   * `exportBlend()` runs Blender headless over one .blend and writes the .glb
//     beside it (models/export_glb.py does the Blender side).
//   * `blendGlb()` is a Vite plugin that watches models/ and calls the above,
//     then tells the dev server to reload the page. It runs INSIDE `bun run dev`
//     rather than as a second process to babysit — the dev server already owns a
//     file watcher, and AGENTS.md's "own your dev server" rule is easier to keep
//     when there is one thing to start and one thing to stop.
//
// Run it by hand for a one-off export of everything:  bun tools/blend-glb.mjs
//
// FINDING BLENDER is a per-machine question, the same one BROWSER_EXECUTABLE
// answers for the capture tools: `BLENDER_EXECUTABLE` in .env.local, else
// whatever `blender` resolves to on PATH. If neither works the plugin says so
// ONCE and stands down — a missing modelling tool must never stop the game's
// dev server from starting, because almost nobody running it is editing models.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODELS = join(ROOT, 'models');
const PY = join(MODELS, 'export_glb.py');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * `.env.local`, read by hand.
 *
 * BUN LOADS IT FOR `bun run`, AND THAT IS NOT ENOUGH HERE. This module is
 * imported by vite.config.ts, and the dev server gets started plenty of ways
 * that are not `bun run dev` — `bun x vite`, an IDE run button, a worktree
 * script. Under `bun x` the file is not loaded and the lookup below silently
 * fell back to PATH, which on this machine is a Blender that is not there.
 * Ten lines of parsing makes where Blender lives a property of the repo rather
 * than of how somebody happened to launch the server.
 */
function envFile(key) {
  for (const name of ['.env.local', '.env']) {
    const path = join(ROOT, name);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const at = line.indexOf('=');
      if (at < 0 || line.trimStart().startsWith('#')) continue;
      if (line.slice(0, at).trim() !== key) continue;
      // Values are literal — a Windows path is full of backslashes and quoting
      // it would only add characters to strip back off.
      const value = line.slice(at + 1).trim().replace(/^["']|["']$/g, '');
      if (value) return value;
    }
  }
  return '';
}

/** The Blender to drive, or null. See the note at the top. */
export function blenderExe() {
  const set = (process.env.BLENDER_EXECUTABLE || envFile('BLENDER_EXECUTABLE')).trim();
  if (set) return existsSync(set) ? set : null;
  return 'blender';                     // let PATH answer; a miss shows up as a spawn error
}

/**
 * Wait until a file has stopped being written before reading it.
 *
 * A SAVE IS NOT ONE EVENT. Blender renames the previous file to .blend1 and
 * writes the new one, and a watcher sees the change the moment the first bytes
 * land — export then, and Blender opens a truncated file and exits non-zero on
 * a save that was perfectly fine. Two identical mtimes a beat apart is the
 * cheapest "it has stopped moving" there is.
 */
async function settle(file, quiet = 350, budget = 10000) {
  const t0 = Date.now();
  let last = -1;
  while (Date.now() - t0 < budget) {
    const m = statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? -1;
    if (m > 0 && m === last) return true;
    last = m;
    await sleep(quiet);
  }
  return false;
}

/**
 * Export one .blend. Resolves with `{ ok, ms, output }` and never throws — a
 * failed export is a message in the dev-server log and the next save trying
 * again, not a crashed watcher.
 */
export async function exportBlend(blend, { exe = blenderExe(), log = console } = {}) {
  if (!exe) return { ok: false, ms: 0, output: 'no Blender executable' };
  await settle(blend);
  const started = Date.now();
  return await new Promise((done) => {
    // SHELL ONLY FOR A BARE COMMAND NAME. `blender` off PATH needs one on
    // Windows, where spawn will not find a .exe by name alone — but a full path
    // handed to the shell is split on its spaces, and the stock install is
    // `C:\Program Files\...`, which came back as "'C:\Program' is not
    // recognized". A path goes straight to CreateProcess, which handles it.
    const viaPath = !/[\\/]/.test(exe);
    const child = spawn(exe, ['--background', blend, '--python', PY], {
      cwd: ROOT,
      shell: viaPath,
    });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    child.on('error', (e) => done({ ok: false, ms: Date.now() - started, output: String(e) }));
    child.on('close', (code) => done({ ok: code === 0, ms: Date.now() - started, output }));
  });
}

/** Every .blend in models/ (not .blend1, which is Blender's own backup). */
export function blendFiles() {
  return readdirSync(MODELS).filter((f) => f.endsWith('.blend')).map((f) => join(MODELS, f));
}

/**
 * The Vite plugin.
 *
 * `apply: 'serve'` — a production build has nothing to reload and must not go
 * looking for Blender on a machine that has none.
 *
 * The RELOAD IS A FULL ONE and it has to be: the .glb is not a module in the
 * graph, so there is no HMR boundary to invalidate and nothing for Vite to
 * decide on its own. It is issued only after a successful export, so a page
 * never reloads onto a half-written file.
 */
export function blendGlb() {
  let announced = false;
  return {
    name: 'bs-blend-glb',
    apply: 'serve',
    configureServer(server) {
      const exe = blenderExe();
      const log = server.config.logger;
      // The whole directory, not a glob: chokidar takes a path, and models/ is
      // small enough that watching it whole is free.
      server.watcher.add(MODELS);

      const queue = new Set();
      let running = false;

      const drain = async () => {
        if (running) return;
        running = true;
        try {
          while (queue.size) {
            const blend = [...queue][0];
            queue.delete(blend);
            log.info(`[blend] exporting ${blend.replace(ROOT, '.')}`);
            const r = await exportBlend(blend, { exe, log });
            if (r.ok) {
              log.info(`[blend] wrote ${blend.replace(/\.blend$/, '.glb').replace(ROOT, '.')} in ${r.ms} ms`);
              (server.hot ?? server.ws).send({ type: 'full-reload', path: '*' });
            } else {
              // The tail, not the whole of it: Blender prints a banner and a
              // read-blend-file line on every run, and the reason is at the end.
              log.error(`[blend] export failed\n${r.output.trim().split('\n').slice(-6).join('\n')}`);
              if (!announced) {
                announced = true;
                log.warn('[blend] set BLENDER_EXECUTABLE in .env.local if Blender is not on PATH');
              }
            }
          }
        } finally {
          running = false;
        }
      };

      // A save while an export is running queues ONE more run rather than
      // stacking: the file is a snapshot, and the newest one is the only one
      // anybody wants exported.
      const onChange = (file) => {
        if (!file.endsWith('.blend')) return;   // never .blend1, never the .glb we just wrote
        queue.add(file);
        void drain();
      };
      server.watcher.on('change', onChange);
      server.watcher.on('add', onChange);
      log.info(`[blend] watching models/ — ${exe ? `via ${exe}` : 'Blender not found, exports disabled'}`);
    },
  };
}

// CLI: export every .blend once. Same path the watcher takes, so a green run
// here is a green run there.
if (import.meta.main) {
  const files = blendFiles();
  let bad = 0;
  for (const f of files) {
    const r = await exportBlend(f);
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${f.replace(ROOT, '.')} (${r.ms} ms)`);
    if (!r.ok) { bad++; console.error(r.output.trim().split('\n').slice(-8).join('\n')); }
  }
  process.exit(bad ? 1 : 0);
}
