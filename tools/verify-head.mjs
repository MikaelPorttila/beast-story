// Typecheck and build WHAT IS COMMITTED, not what is in the working tree.
//
// This exists because of a real deployment break. Several agents were editing
// the repo at once, so commits were staged file-by-file to keep each one
// coherent — and `main.ts` went in referencing `player.onCanopy` one commit
// before `player/index.ts` declared it. `tsc` passed locally every time, because
// locally BOTH files were present; the commit only carried one. The deploy built
// that commit and failed with TS2339.
//
// The lesson generalises past that one bug: a partial commit verified against a
// full working tree proves nothing about the commit. So this checks out HEAD
// into a throwaway worktree and typechecks THAT.
//
//   bun run verify            # HEAD
//   bun tools/verify-head.mjs HEAD~1
//
// node_modules is LINKED into the worktree rather than installed there. tsc
// resolves modules relative to the tsconfig it is given, not to the directory it
// was invoked from — a first attempt passed `-p <worktree>/tsconfig.json` from
// the main checkout and every file failed with "Cannot find module 'three'",
// which looks exactly like a real breakage and is not. A junction (mklink /J on
// Windows, no admin needed; a symlink elsewhere) costs nothing and keeps the
// check fast enough to run before every push.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ref = process.argv[2] ?? 'HEAD';
const dir = mkdtempSync(join(tmpdir(), 'bs-verify-'));

const run = (cmd, args) =>
  spawnSync(cmd, args, { stdio: 'inherit', shell: true, encoding: 'utf8' });

const cleanup = () => {
  // Drop the junction FIRST. `git worktree remove` walks the tree, trips over the
  // link and fails with "Invalid argument", leaving the worktree registered.
  // rmdir on a junction removes the link and never touches its target.
  const modules = join(dir, 'node_modules');
  if (process.platform === 'win32') run('cmd', ['/c', 'rmdir', JSON.stringify(modules)]);
  else run('rm', ['-f', JSON.stringify(modules)]);
  run('git', ['worktree', 'remove', '--force', JSON.stringify(dir)]);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
};

console.log(`verifying ${ref} in ${dir}`);
if (run('git', ['worktree', 'add', '-f', '--detach', JSON.stringify(dir), ref]).status !== 0) {
  console.error('could not create the verification worktree');
  process.exit(1);
}

const modules = join(dir, 'node_modules');
const linked = process.platform === 'win32'
  ? run('cmd', ['/c', 'mklink', '/J', JSON.stringify(modules), JSON.stringify(join(process.cwd(), 'node_modules'))])
  : run('ln', ['-s', JSON.stringify(join(process.cwd(), 'node_modules')), JSON.stringify(modules)]);
if (linked.status !== 0) {
  cleanup();
  console.error('could not link node_modules into the verification worktree');
  process.exit(1);
}

// Uncommitted work is invisible in there by construction — that is the point.
const tsc = spawnSync('bunx', ['tsc', '--noEmit'], {
  cwd: dir, stdio: 'inherit', shell: true, encoding: 'utf8',
});
cleanup();

if (tsc.status !== 0) {
  console.error(
    `\n${ref} DOES NOT TYPECHECK.\n` +
    'It compiles in your working tree only because the tree holds files the\n' +
    'commit does not. Stage the rest of the change, or amend.',
  );
  process.exit(tsc.status ?? 1);
}
console.log(`\n${ref} typechecks on its own.`);
