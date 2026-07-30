// Timestamped snapshot build, so playable builds accumulate instead of
// overwriting each other.
//
//   bun tools/build-stamped.mjs            -> dist/2026-07-30_1530/
//   bun tools/build-stamped.mjs my-label   -> dist/2026-07-30_1530_my-label/
//
// vite.config.ts sets `base: './'`, so a snapshot is self-contained: serve the
// folder (or the whole dist/) over http and open index.html. `file://` will not
// work — the game loads ES modules, which browsers refuse over that scheme.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const label = process.argv[2]?.replace(/[^a-zA-Z0-9._-]/g, '-') ?? '';

const d = new Date();
const p2 = (n) => String(n).padStart(2, '0');
const stamp =
  `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` +
  `_${p2(d.getHours())}${p2(d.getMinutes())}`;
const dirName = label ? `${stamp}_${label}` : stamp;
const outDir = join('dist', dirName);

// Typecheck first — a snapshot that does not compile is worse than no snapshot.
const tsc = spawnSync('bun', ['x', 'tsc', '--noEmit'], { stdio: 'inherit', shell: true });
if (tsc.status !== 0) {
  console.error('\ntsc failed — refusing to stamp a broken build.');
  process.exit(tsc.status ?? 1);
}

// `--emptyOutDir` is required because outDir sits inside dist/, which vite
// treats as outside root and refuses to clear without being told.
const build = spawnSync(
  'bun',
  ['x', 'vite', 'build', '--outDir', outDir, '--emptyOutDir'],
  { stdio: 'inherit', shell: true },
);
if (build.status !== 0) process.exit(build.status ?? 1);

// Record what this snapshot actually is, for whoever opens it in a week.
const git = (args) =>
  spawnSync('git', args, { encoding: 'utf8', shell: true }).stdout?.trim() ?? '';
writeFileSync(
  join(outDir, 'BUILD.txt'),
  [
    `Cube Pals snapshot ${dirName}`,
    `built:  ${d.toISOString()}`,
    `commit: ${git(['rev-parse', '--short', 'HEAD'])} ${git(['log', '-1', '--format=%s'])}`,
    `branch: ${git(['rev-parse', '--abbrev-ref', 'HEAD'])}`,
    `dirty:  ${git(['status', '--porcelain']) ? 'yes (uncommitted changes)' : 'no'}`,
    '',
    'Serve over http and open index.html (lab.html = isolated model stage):',
    `  bun x vite preview --outDir ${outDir.replace(/\\/g, '/')}`,
    '',
  ].join('\n'),
);

// Index every snapshot so dist/ itself is browsable.
const snaps = readdirSync('dist')
  .filter((n) => /^\d{4}-\d{2}-\d{2}_\d{4}/.test(n) && statSync(join('dist', n)).isDirectory())
  .sort()
  .reverse();
writeFileSync(
  join('dist', 'builds.html'),
  `<!doctype html><meta charset="utf-8"><title>Cube Pals builds</title>
<style>
  body{font:16px/1.6 system-ui,sans-serif;background:#141a1f;color:#e8eef2;margin:0;padding:2.5rem}
  h1{font-size:1.3rem;margin:0 0 1.5rem}
  ul{list-style:none;padding:0;max-width:34rem}
  li{margin:0 0 .5rem}
  a{display:flex;justify-content:space-between;gap:1rem;padding:.7rem 1rem;border-radius:.5rem;
    background:#1e262e;color:#8fd0ff;text-decoration:none}
  a:hover{background:#27333d}
  .latest{outline:2px solid #4c8;color:#bfe8a0}
  span{color:#7d8b96;font-size:.85em}
</style>
<h1>Cube Pals — playable snapshots</h1>
<ul>
${snaps
  .map(
    (n, i) =>
      `  <li><a class="${i === 0 ? 'latest' : ''}" href="./${n}/index.html">${n}` +
      `<span>${i === 0 ? 'latest' : ''}</span></a></li>`,
  )
  .join('\n')}
</ul>
`,
);

console.log(`\nsnapshot ready: ${outDir}`);
console.log(`  index:  dist/builds.html`);
console.log(`  serve:  bun x vite preview --outDir ${outDir.replace(/\\/g, '/')}`);
