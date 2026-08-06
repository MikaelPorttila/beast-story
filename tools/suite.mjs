// Run converted probes as sections against ONE booted world.
//
//   bun tools/suite.mjs                    # every converted probe
//   bun tools/suite.mjs carrier safezone   # a subset
//   bun tools/suite.mjs --json             # machine-readable summary
//
// This is the boot-amortising half of the probe speedup (`__dbgAdvance` in
// main.ts is the sleep-killing half — see tools/suite/harness.mjs for the
// contract). The old roster paid ~17 s of world build per probe and ran them
// strictly serially; here the world is built once and the probes' sections run
// against it back to back, teleporting between sites.
//
// CONVERTED is the roster, and it is explicit for the same reason probe.mjs's
// SOLO list is: membership is a claim ("this probe's sections leave nothing
// behind that the standard reset does not cover") and a claim should be a
// line in a file, made on purpose. A probe that is not on it still runs the
// old way through probe.mjs; nothing is lost by not being here yet.
//
// ORDER MATTERS and is part of the roster: `safezone` runs LAST because its
// sections aggro the wild population and lead a chase into a town — the
// standard reset dismounts and releases keys, it does not calm animals. Add a
// new probe before anything it could poison and after anything that poisons it.
// gfx sits before safezone: its last section RELOADS the shared page (the
// persistence assertion is a real boot, there is no cheaper honest form), so
// whatever follows it inherits a freshly booted world — which safezone's
// teleport-everywhere sections do not mind, and a motion-sensitive module
// would.
const CONVERTED = ['carrier', 'deepwater', 'gfx', 'safezone'];

import { launchBrowser } from './browser.mjs';
import { bootGamePage, runModules } from './suite/harness.mjs';

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const names = argv.filter((a) => !a.startsWith('--'));
const picked = names.length ? names : CONVERTED;

const unknown = picked.filter((n) => !CONVERTED.includes(n));
if (unknown.length) {
  console.error(`not converted: ${unknown.join(', ')}\n  converted: ${CONVERTED.join(' ')}`);
  process.exit(2);
}
// Whatever subset was asked for runs in roster order — see the ORDER note above.
const run = CONVERTED.filter((n) => picked.includes(n));

const modules = [];
for (const n of run) {
  const mod = await import(`./test-${n}.mjs`);
  if (!mod.sections) {
    console.error(`tools/test-${n}.mjs exports no sections — is it converted?`);
    process.exit(2);
  }
  modules.push({ name: mod.name ?? n, sections: mod.sections });
}

const t0 = Date.now();
const browser = await launchBrowser();
try {
  const boot0 = Date.now();
  const page = await bootGamePage(browser);
  const bootMs = Date.now() - boot0;

  const out = await runModules(modules, page);

  const totalMs = Date.now() - t0;
  const summary = {
    probes: run.length,
    sections: out.sections,
    bootMs,
    totalMs,
    sectionMs: out.ms,
    modules: out.modules,
    fails: out.fails,
    pass: out.fails.length === 0,
  };
  if (json) console.log(JSON.stringify(summary));
  else {
    console.log(JSON.stringify(summary, null, 2));
    console.log(`\n${run.length} probes, ${out.sections} sections in `
      + `${(totalMs / 1000).toFixed(1)}s (boot ${(bootMs / 1000).toFixed(1)}s)`);
  }
  if (out.fails.length) {
    console.error(`\n${out.fails.length} failure(s):\n  ${out.fails.join('\n  ')}`);
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
