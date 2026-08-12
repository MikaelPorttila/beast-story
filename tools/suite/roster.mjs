// The suite's roster: every probe converted to shared-session sections, in the
// order they run. ONE list, imported by both tools/suite.mjs (which runs it)
// and tools/probe.mjs (which routes converted names through the suite instead
// of spawning them as real-time children) — membership written twice would
// drift, and a name that drifted off one list would quietly run the slow way.
//
// ORDER IS PART OF THE ROSTER. The harness's reset between modules is
// deliberately small (mounts off, keys up — see resetBetween in harness.mjs),
// so a module runs after everything it could poison and before everything
// that would poison it. The constraints, in roster order:
//
//   inventory  FIRST: it asserts the UNTOUCHED starting kit (bag contents,
//              equipped sword, the empty roster a new game has), which even a
//              __dbgRide in an earlier module would break — and it permanently
//              enriches the bag for everything after it.
//   carrier,   the physics pair; nothing focus-gated, nothing kit-sensitive.
//   deepwater
//   gfx        RELOADS the shared page twice: once up front (its draw-count
//              floors are calibrated against a freshly booted world — the
//              aged shared world measured ~250 draws lower at the same spot)
//              and once in its last section (the persistence assertion is a
//              real boot), so everything after it inherits a freshly booted
//              world and nothing before it can poison its numbers.
//   keybinds   inherits any page fine (it teleports to spawn itself); its
//              focus-sensitive halves run on private pages by design.
//   touch      poisons nothing — the shared page is only read; all driving is
//              on private phone-emulated pages it closes.
//   gamepad    LATE: installFakePad is page-wide and cannot be uninstalled,
//              and the first use latches input.lastSource to 'gamepad' for
//              the page's life. Its noPad section also assumes no earlier
//              module installed a pad.
//   safezone   LAST: aggros the wild population and leads a chase into a
//              town; nothing behavioural should follow it.
//
// A probe that is not on this list still runs the old way through probe.mjs;
// nothing is lost by not being here yet.
// NOT ON THE ROSTER, AND ONE OF THEM MAY NEVER BE:
//
//   keybinds  CONVERTED (its sleeps are gone, and `bun tools/test-keybinds.mjs`
//             runs it the fast way) but NOT shared-session, because three of
//             its assertions are about POINTER-LOCK RECOVERY and that feature
//             is gated on `focused && document.hasFocus()` (core/input.ts) —
//             an alt-tabbed window must not fight the browser for the mouse.
//             In a browser running nine modules and their private pages, which
//             target holds OS-level activation is not ours to decide: measured
//             one green run and one run losing all three recovery assertions,
//             with the section already on a freshly created page, already
//             calling bringToFront, already stubbing the focus event. Chrome
//             grants the lock and withholds activation independently.
//
//             That is a REAL constraint, not a flaky test: the thing under
//             test needs a genuinely focused window, and a shared browser
//             cannot promise one. It runs alone, where it is reliable, and
//             probe.mjs spawns it the old way — it still gets the whole
//             sleep-to-simulated-time win, just not the shared boot.
//
//   pause     CONVERTED, and it ran here until issue #4. It is out because of
//             ONE section: `exitTitle` leaves the game to the title screen and
//             starts a second one, and `exitToTitle` in main.ts throws away the
//             whole play session — the bag, the purse, the beasts you have
//             bonded, the cooldowns, the wild population. That is exactly what
//             it is supposed to do, and it is the correct thing to test.
//
//             But a shared session is a session, and a module that ENDS one is
//             not a module the seven after it can share with: everything they
//             set up before it is gone, and the failures land on them rather
//             than here, reading as seven broken features instead of one
//             deliberate restart. It cost a real debugging session to find that
//             the sentence "not bonded" appearing in carrier, deepwater and
//             gamepad was one exit-to-title four modules upstream.
//
//             The same reasoning applies to any probe that drives the game
//             BACK TO THE MENU. If a future one does, it belongs out here with
//             this one rather than on the roster below — a suite is for modules
//             that leave a world behind them, and a title screen is not one.
//
//             It keeps every other conversion win; it just gets its own boot.
export const CONVERTED = [
  "inventory",
  "carrier",
  "deepwater",
  "gfx",
  "touch",
  "gamepad",
  "safezone",
];
