// The F1 controls sheet, and the one guard that can catch it going stale.
//
// TWO DIFFERENT QUESTIONS, and only the second one is about the DOM.
//
//   1. IS THE SHEET STILL TRUE? src/ui/keybinds.ts is a hand-written table —
//      a binding is not a value anywhere in this codebase, so there is no
//      registry to derive it from. What there IS is the set of key codes the
//      game actually reads: every `pressed('…')`, `down('…')` and `keys.has('…')`
//      in src/. Scanned here and compared against the table, so a binding added
//      without a row fails a run rather than quietly never being documented.
//
//      One direction is a HARD failure and the other is not. A code the game
//      reads and the sheet does not name is a hole in the sheet — that is
//      `unlisted`, and it must be empty. The reverse, `listedNotScanned`, is
//      expected to hold exactly the four hotbar digits: main.ts reads them
//      through a loop variable (`input.pressed(code)` over an `as const` array)
//      and no regex over the source will see them. Anything ELSE showing up
//      there is a row describing a key nothing reads.
//
//   2. DOES IT RENDER? F1 opens it, F1 closes it, the world stands still while
//      it is up, both device columns are populated, and the HOLD chips are
//      distinguishable from the PRESS ones — which is the requirement the panel
//      exists to satisfy, so it is asserted on the painted class, not on intent.
//
// Usage: bun tools/test-keybinds.mjs
import fs from "node:fs";
import path from "node:path";
import { launchBrowser, newPage, startNewGame, wait } from "./browser.mjs";
import { BASE as HOST } from "./target.mjs";

/** Walk the poster to the options list, then click one of its buttons. */
const toOptions = async (pg) => {
  await pg.waitForSelector(".bs-menu");
  await wait(600);
  for (let i = 0; i < 4; i++) {
    if (await pg.evaluate(() => !!document.querySelector('.bs-menu [data-act="new"]'))) {
      break;
    }
    await pg.keyboard.press("Enter");
    await wait(500);
  }
};
/** Start a game the way a player does — a real click, so the activation is real. */
const newGame = async (pg) => {
  await startNewGame(pg);
  await pg.waitForFunction(() => window.__dbgBoot?.().playing === true, { timeout: 30000 });
  await wait(800);
  return pg.evaluate(() => window.__dbgFullscreen());
};

/** Shortest arc between two yaws, so a reading across the -pi seam is small. */
const arc = (a, b) => {
  let d = b - a;
  while (d > Math.PI) {
    d -= 2 * Math.PI;
  }
  while (d < -Math.PI) {
    d += 2 * Math.PI;
  }
  return +Math.abs(d).toFixed(4);
};

const URL = `${HOST}/?fps=30&menu=0`;
const SRC = "src";

// ---------- 1. the table vs. the source ------------------------------------
/** Every `.ts` under src/, recursively. */
function sources(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sources(p));
    } else if (entry.name.endsWith(".ts")) {
      out.push(p);
    }
  }
  return out;
}

// `has` is in here for WASD: core/input.ts reads the movement axes straight off
// its own held set rather than through down(), and a sheet that forgot to
// mention how you WALK would otherwise pass. `takePress` is the frame-loop read
// F1 and F2 use — it is a separate word, and leaving it out silently dropped
// both of them out of this scan. Both quote styles: the oxfmt migration turned
// every literal double-quoted, and a single-quote-only scan matched NOTHING
// from then on — the check passed vacuously while the sheet could rot.
// Uppercase first letter: every KeyboardEvent.code starts with one, and it is
// what keeps `mountUnlocks.has("water")` out of a scan keyed on bare words.
const READ = /(?:takePress|pressed|down|has)\(\s*["']([A-Z][A-Za-z0-9]*)["']\s*\)/g;
const scanned = new Set();
for (const file of sources(SRC)) {
  // Skip the table itself: its `codes` arrays are not reads, and matching them
  // would make this check compare the file against itself.
  if (file.endsWith(path.join("ui", "keybinds.ts"))) {
    continue;
  }
  const text = fs.readFileSync(file, "utf8");
  for (const m of text.matchAll(READ)) {
    scanned.add(m[1]);
  }
}

// Read the table's codes out of the source rather than importing it: this is a
// plain ESM tool with no TypeScript loader, and the shape is one flat field.
const table = fs.readFileSync(path.join(SRC, "ui", "keybinds.ts"), "utf8");
const listed = new Set();
for (const m of table.matchAll(/codes:\s*\[([^\]]*)\]/g)) {
  for (const c of m[1].matchAll(/["']([^"']+)["']/g)) {
    listed.add(c[1]);
  }
}

/**
 * Keys a BROWSER does something with, which the game must therefore swallow.
 *
 * This list is the whole point of the `uncaptured` check below. Every one of
 * these has a default action — F1 opens the browser's help in a new tab over
 * the game, F3 opens quick-find, Tab moves focus, Space and the arrows scroll —
 * and `Input.CAPTURED` calling preventDefault is the only thing stopping it.
 *
 * IT HAS BEEN FORGOTTEN ONCE PER FUNCTION KEY, and it is invisible to every
 * other probe in tools/: puppeteer dispatches the key straight at the page, the
 * game reacts correctly, and no help tab opens because a headless run has no
 * browser chrome to open one. It only ever fails on a real player's machine,
 * which is exactly the kind of defect that has to be a run rather than a wish.
 *
 * ESCAPE IS THE NEWEST MEMBER AND THE ODD ONE. Its default — leave fullscreen,
 * drop pointer lock — is not stopped by preventDefault alone; it takes the
 * KEYBOARD LOCK the game holds while fullscreen (ui/fullscreen.ts) to make that
 * call mean anything. It belongs in this list all the same: the lock delivers
 * the key to the page and the preventDefault is what the page then does with
 * it, so dropping either half puts the browser back in the middle of the menu
 * key. `keyboardLock` below is the other half's own check.
 */
const BROWSER_OWNS = /^(F\d+|Arrow|Tab$|Space$|Escape$)/;

const results = {
  table: {
    codesReadInSource: [...scanned].toSorted(),
    codesInSheet: [...listed].toSorted(),
    unlisted: [...scanned].filter((c) => !listed.has(c)).toSorted(),
    listedNotScanned: [...listed].filter((c) => !scanned.has(c)).toSorted(),
  },
};

// ---------- 2. the panel ----------------------------------------------------
const browser = await launchBrowser();
const page = await newPage(browser, { width: 1280, height: 800 });
await page.goto(URL, { waitUntil: "load" });
await page.waitForSelector("canvas");
await wait(3500);

// Every key the game reads that a browser also acts on must be in the capture
// set. Read from the RUNNING game rather than parsed out of the source, so this
// asserts against the set the player's browser is actually using.
{
  const captured = new Set((await page.evaluate(() => window.__dbgInput())).captured);
  const owed = [...scanned].filter((c) => BROWSER_OWNS.test(c));
  results.table.browserOwned = owed.toSorted();
  results.table.captured = [...captured].toSorted();
  results.table.uncaptured = owed.filter((c) => !captured.has(c)).toSorted();
}

// The state of both halves on an ordinary windowed page, for the record: no
// fullscreen, so no lock. `keyboardLock` is FALSE in a headless run and that is
// the browser rather than the code — see section 6, which is the guard.
results.fullscreen = await page.evaluate(() => window.__dbgFullscreen());

const sheet = () =>
  page.evaluate(() => {
    const wrap = document.querySelector(".bs-keyswrap");
    const rows = [...document.querySelectorAll(".bs-keyrow:not(.head)")];
    return {
      open: !!wrap?.classList.contains("open"),
      sections: document.querySelectorAll(".bs-keys-sec").length,
      rows: rows.length,
      hold: rows.filter((r) => r.querySelector(".mode.hold")).length,
      press: rows.filter((r) => r.querySelector(".mode.press")).length,
      // Every row must say something on BOTH sides — a key cap on the keyboard
      // side, and either a controller face or the explicit "no binding" dash.
      rowsMissingKbm: rows.filter((r) => !r.querySelector(".kbm kbd")).length,
      rowsMissingPad: rows.filter(
        (r) => !r.querySelector(".pad kbd.pad") && !r.querySelector(".pad .none"),
      ).length,
      padFaces: document.querySelectorAll(".bs-keys .pad kbd.pad").length,
      noPadBinding: document.querySelectorAll(".bs-keys .pad .none").length,
    };
  });

results.beforeOpen = await sheet();

await page.keyboard.press("F1");
await wait(500);
results.opened = await sheet();

// THE GATE, and the pair that matters: an identical hold of W must travel
// nothing while the sheet is up and the usual distance once it is shut. Same
// shape as the title screen's assertion in test-menu.mjs — a panel that only
// LOOKS modal is the failure being ruled out.
const held = async () => {
  const before = await page.evaluate(() => window.__dbgPlayerPos());
  await page.keyboard.down("w");
  await wait(1200);
  await page.keyboard.up("w");
  await wait(120);
  const after = await page.evaluate(() => window.__dbgPlayerPos());
  return +Math.hypot(after.x - before.x, after.z - before.z).toFixed(2);
};
const movedWhileOpen = await held();

await page.keyboard.press("F1");
await wait(500);
results.closed = await sheet();
const movedWhileClosed = await held();
results.gate = { movedWhileOpen, movedWhileClosed };

// Escape must close it too — that is the path a controller reaches it by, since
// B and Start tap Escape while a modal is up and no pad button opens the sheet.
await page.keyboard.press("F1");
await wait(400);
const openedAgain = (await sheet()).open;
await page.keyboard.press("Escape");
await wait(400);
results.escape = { openedAgain, closedByEscape: !(await sheet()).open };

// A GLANCE MUST COST ONE KEY, NOT A KEY AND A CLICK.
//
// The sheet is READ, not clicked, so unlike the shop it keeps pointer lock. It
// released it at first, and the cost only shows up in the hand: press F1, read a
// line, press F1, and the game is deaf until you click it again — mouse look
// dead, a cursor sitting over the world. Asserted on `pointerLockElement` either
// side of a full open/close, which reproduces at `fps=30` and needs no fast host.
//
// The second half is what keeping the lock bought: the mouse goes on reporting
// movement nobody spends, so the camera must not drift while the panel is up NOR
// flick on the way out. Whipping the pointer around mid-read is the test — see
// Input.clearLook.
{
  await page.mouse.click(640, 400);
  await wait(400);
  const locked = () => page.evaluate(() => document.pointerLockElement !== null);
  const yaw = () => page.evaluate(() => window.__dbgCamYaw());

  const lockedBefore = await locked();
  await page.keyboard.press("F1");
  await wait(400);
  const lockedWhileOpen = await locked();

  const yawBefore = await yaw();
  for (let i = 0; i < 12; i++) {
    await page.mouse.move(200 + i * 60, 300 + (i % 3) * 80);
  }
  await wait(400);
  const yawWhileOpen = await yaw();

  await page.keyboard.press("F1");
  await wait(400);
  const lockedAfterClose = await locked();
  await wait(200);

  results.pointerLock = {
    lockedBefore,
    lockedWhileOpen,
    lockedAfterClose,
    // Both must be 0: no drift with the sheet up, no flick as it closes.
    yawDriftWhileOpen: arc(yawBefore, yawWhileOpen),
    yawFlickOnClose: arc(yawWhileOpen, await yaw()),
    // The whole point, in one boolean. Measured false/false before the fix.
    survivesAGlance: lockedBefore && lockedWhileOpen && lockedAfterClose,
  };
}

await page.close();

// ---------- 3. the sheet follows the device, WHILE IT IS OPEN ---------------
//
// A pad's buttons are read for "the pad is the live device" BEFORE the modal
// branch in core/gamepad.ts, so a player who picks the controller up while
// reading must watch the faces change under them. Synthetic pad, same technique
// as tools/test-gamepad.mjs — a real one cannot be plugged into headless Brave.
{
  const pad = await newPage(browser, { width: 1280, height: 800 });
  await pad.evaluateOnNewDocument(() => {
    const state = {
      id: "DualSense Wireless Controller (Vendor: 054c Product: 0ce6)",
      index: 0,
      connected: true,
      mapping: "standard",
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
    };
    window.__fakePad = state;
    navigator.getGamepads = () => [state];
    window.__connectPad = () => {
      const ev = new Event("gamepadconnected");
      Object.defineProperty(ev, "gamepad", { value: state });
      window.dispatchEvent(ev);
    };
  });
  await pad.goto(URL, { waitUntil: "load" });
  await pad.waitForSelector("canvas");
  await wait(3500);
  await pad.evaluate(() => window.__connectPad());
  await wait(200);

  // Opened on the keyboard, so this is the Xbox fallback the panel prints for
  // nobody in particular.
  await pad.keyboard.press("F1");
  await wait(500);
  const faces = () =>
    pad.evaluate(() =>
      [...document.querySelectorAll(".bs-keys .pad kbd.pad")].map((k) => k.textContent).join(" "),
    );
  const onKeyboard = await faces();

  // A (index 0), pressed with the sheet up. Deliberately NOT Start or B: those
  // two tap Escape while a modal is up and would close the very panel being
  // measured. A reaches nothing at all here — it only stamps the source, which
  // is the whole point.
  await pad.evaluate(() => {
    window.__fakePad.buttons[0] = { pressed: true, touched: true, value: 1 };
  });
  await wait(200);
  await pad.evaluate(() => {
    window.__fakePad.buttons[0] = { pressed: false, touched: false, value: 0 };
  });
  await wait(400);
  const onPad = await faces();

  results.deviceSwitch = {
    onKeyboard,
    onPad,
    // ✕ and □ are PlayStation's; A and X are the Xbox faces they replaced.
    xboxWhileNobodyHadPicked: onKeyboard.includes("A"),
    playstationOncePadUsed: onPad.includes("✕"),
    changed: onKeyboard !== onPad,
  };
  await pad.close();
}

// ---------- 4. ten presses, UNCAPPED ---------------------------------------
//
// THE ASSERTION THIS FILE EXISTS FOR SECOND, and the one every other section
// here is structurally blind to. `?fps=30` against a 60 Hz sim drains two
// slices on every frame, so `endFrame()` runs every frame and a press can never
// be read twice. Uncapped it runs at the display's refresh rate — 165 Hz on the
// machine this was measured on — and two frames in three drain nothing at all.
//
// A frame-loop toggle reading an unconsumed `pressed()` therefore fired two or
// three times per press and landed back where it started: measured before the
// fix, ten presses of F1 gave `0011011101`. NO `fps=` HERE, deliberately, and if
// a future edit adds one this assertion quietly stops testing anything.
{
  const fast = await newPage(browser, { width: 1280, height: 800 });
  await fast.goto(`${HOST}/?menu=0`, { waitUntil: "load" });
  await fast.waitForSelector("canvas");
  await wait(3500);

  const seq = [];
  for (let i = 0; i < 10; i++) {
    await fast.keyboard.press("F1");
    await wait(350);
    seq.push(
      await fast.evaluate(() =>
        document.querySelector(".bs-keyswrap")?.classList.contains("open") ? 1 : 0,
      ),
    );
  }
  const pattern = seq.join("");
  results.uncappedToggle = {
    pattern,
    expected: "1010101010",
    alternates: pattern === "1010101010",
  };
  await fast.close();
}

// ---------- 5. the REAL player path, through the staged boot ---------------
//
// Everything above passes `menu=0`, which is not how anybody plays: it skips the
// title screen, and with it the whole staged boot — no progress indicator, no
// waiting, and `frame()` running from the first moment. The path a player takes
// starts at a poster, and `beginPlay()` DRAINS the key latch on the way through
// (see main.ts: every key pressed at the menu is still sitting in `Input`,
// because `endFrame()` only runs inside `frame()` and `frame()` had not run).
//
// So there are two things to check here that no `menu=0` run can. F1 pressed AT
// the poster must not survive the handover and pop the sheet open on the first
// gameplay frame — the menu itself ignores every `F\d` key by design, so the
// press reaches `Input` and nothing else. And once playing, the toggle must work
// exactly as it does under `menu=0`.
{
  const staged = await newPage(browser, { width: 1280, height: 800 });
  // `fs=0`: New Game takes fullscreen now, and a headless page that goes
  // fullscreen mid-run is measuring a different window than it started in.
  await staged.goto(`${HOST}/?fs=0`, { waitUntil: "load" });
  await staged.waitForSelector(".bs-menu");
  await wait(600);

  await staged.keyboard.press("F1");
  await wait(700);
  const stepAfterF1 = await staged.evaluate(
    () => document.querySelector(".bs-menu")?.dataset.step ?? null,
  );

  // Enter through whatever steps stand between the splash and the options list.
  for (let i = 0; i < 4; i++) {
    if (await staged.evaluate(() => !!document.querySelector('.bs-menu [data-act="new"]'))) {
      break;
    }
    await staged.keyboard.press("Enter");
    await wait(500);
  }
  const clickedAt = await staged.evaluate(() => performance.now());
  await startNewGame(staged);
  await staged.waitForFunction(() => window.__dbgBoot?.().playing === true, { timeout: 30000 });
  const startedAt = await staged.evaluate(() => performance.now());
  await wait(800);

  const boot = await staged.evaluate(() => window.__dbgBoot?.());
  const leaked = await staged.evaluate(
    () => !!document.querySelector(".bs-keyswrap")?.classList.contains("open"),
  );

  // THE POINTER MUST ARRIVE WITH THE GAME. New Game is a click on a BUTTON, so
  // the canvas never sees a mousedown and nothing else would ever take the lock:
  // the player lands in the world with a cursor over it and mouse look dead
  // until they click. Asserted by TURNING THE CAMERA with no click at all —
  // `pointerLockElement` alone would pass on a lock the game is not reading.
  //
  // `handoverMs` is reported because the grant depends on it: a browser only
  // allows this off a recent user activation, so a boot slow enough to outlast
  // the click's activation (~5 s in Chrome) legitimately falls back to clicking.
  const lockedAtHandover = await staged.evaluate(() => document.pointerLockElement !== null);
  const yawBefore = await staged.evaluate(() => window.__dbgCamYaw());
  for (let i = 0; i < 10; i++) {
    await staged.mouse.move(300 + i * 50, 400);
  }
  await wait(400);
  const yawAfter = await staged.evaluate(() => window.__dbgCamYaw());
  let turned = yawAfter - yawBefore;
  while (turned > Math.PI) {
    turned -= 2 * Math.PI;
  }
  while (turned < -Math.PI) {
    turned += 2 * Math.PI;
  }

  const seq = [];
  for (let i = 0; i < 6; i++) {
    await staged.keyboard.press("F1");
    await wait(350);
    seq.push(
      await staged.evaluate(() =>
        document.querySelector(".bs-keyswrap")?.classList.contains("open") ? 1 : 0,
      ),
    );
  }

  results.stagedBoot = {
    // The menu's own rule, cross-checked from here: F-keys stay the browser's,
    // so F1 does not leave the splash the way any other key does.
    stepAfterF1AtPoster: stepAfterF1,
    playing: boot?.playing,
    menuOpen: boot?.menuOpen,
    sheetLeakedFromMenuPress: leaked,
    handoverMs: Math.round(startedAt - clickedAt),
    lockedAtHandover,
    yawTurnedWithoutClicking: +Math.abs(turned).toFixed(4),
    looksWithoutAClick: Math.abs(turned) > 0.01,
    pattern: seq.join(""),
    expected: "101010",
    alternates: seq.join("") === "101010",
  };
  await staged.close();
}

// ---------- 6. ESCAPE IS THE GAME'S KEY --------------------------------------
//
// Escape opens the in-game menu and is ALSO the browser's "leave fullscreen"
// key, so one press used to do both. The fix has two halves and this section is
// the only place either can be seen: `Input.CAPTURED` calling preventDefault
// (asserted on the real key, above and here), and the KEYBOARD LOCK the game
// takes while fullscreen, which is what makes that call mean anything.
//
// IT LIES TO THE BROWSER, like test-viewport.mjs and for the same kind of
// reason. `navigator.keyboard` is NULL in a headless Chromium — the property is
// declared and the object is not there — so the real API cannot be exercised at
// all, and a run that simply asked for it would report "unsupported" forever and
// guard nothing. A stub in its place records what the game ASKS FOR, which is
// the part this repo owns: that entering fullscreen locks exactly `Escape`, that
// leaving unlocks, and that `escapeLocked` follows the browser's answer rather
// than our intent.
//
// WHAT IT STILL CANNOT SEE, stated rather than faked: whether a real lock stops
// a real Escape from dropping fullscreen. That is the browser's behaviour under
// an API this browser does not have, and it needs a headful Chromium, a display
// and a hand. Everything up to the request is here.
{
  const lockPage = await newPage(browser, { width: 1024, height: 768 });
  await lockPage.evaluateOnNewDocument(() => {
    window.__kbCalls = [];
    // `configurable` because the real accessor is on Navigator.prototype and
    // answers null; this shadows it on the instance for the life of the page.
    Object.defineProperty(navigator, "keyboard", {
      configurable: true,
      value: {
        lock: (codes) => {
          window.__kbCalls.push(`lock:${(codes ?? []).join("+")}`);
          return Promise.resolve();
        },
        unlock: () => {
          window.__kbCalls.push("unlock");
        },
      },
    });
  });
  await lockPage.goto(`${HOST}/?fps=30&menu=0`, { waitUntil: "load" });
  await lockPage.waitForSelector("canvas");
  await wait(3000);

  const windowed = await lockPage.evaluate(() => window.__dbgFullscreen());
  // A real click first: `requestFullscreen` is refused without a user
  // activation, exactly as it is for a player pressing New Game.
  await lockPage.mouse.click(512, 384);
  await lockPage.evaluate(() =>
    document.documentElement.requestFullscreen({ navigationUI: "hide" }).catch(() => {}),
  );
  await wait(800);
  const full = await lockPage.evaluate(() => window.__dbgFullscreen());
  const callsWhileFull = await lockPage.evaluate(() => window.__kbCalls.slice());

  // The preventDefault half, read off a REAL Escape rather than off the capture
  // list: `Input`'s own window listener runs first (it was added first), so a
  // listener added here sees what it decided.
  // NOT awaited here: the evaluate resolves with the promise's value, so awaiting
  // it would sit out the whole timeout before the key is ever pressed.
  const prevented = lockPage.evaluate(
    () =>
      new Promise((resolve) => {
        const on = (e) => {
          window.removeEventListener("keydown", on);
          resolve(e.defaultPrevented);
        };
        window.addEventListener("keydown", on);
        setTimeout(() => resolve(null), 2000);
      }),
  );
  await lockPage.keyboard.press("Escape");
  const escapePrevented = await prevented;

  await lockPage.evaluate(() => document.exitFullscreen?.());
  await wait(600);
  const afterExit = await lockPage.evaluate(() => window.__dbgFullscreen());
  const calls = await lockPage.evaluate(() => window.__kbCalls.slice());

  results.escapeLock = {
    lockedWhileWindowed: windowed.escapeLocked,
    enteredFullscreen: full.active,
    lockedWhileFullscreen: full.escapeLocked,
    // The exact request, because "some lock" is not the point — a lock over the
    // wrong code list would take keys the player still needs.
    lockedCodes: callsWhileFull.findLast((c) => c.startsWith("lock:")) ?? null,
    escapePrevented,
    releasedOnExit: afterExit.escapeLocked === false && calls.at(-1) === "unlock",
    calls,
  };
  await lockPage.close();
}

// ---------- 7. NEW GAME ONLY TAKES A FULLSCREEN IT CAN KEEP (issue #83) -----
//
// The other half of section 6, from the player's side. Where the keyboard lock
// is missing, Escape is the browser's — and Escape is how a panel is closed, so
// a fullscreen taken at New Game lasts until the first inventory is shut and
// then quietly goes. `StartMenu.start` therefore reads the preference past
// `fullscreenSurvivesEscape()`, and the settings row is shown off and disabled
// with a note rather than switched on and inert.
//
// BOTH HALVES, on two pages that differ in ONE thing: whether
// `navigator.keyboard` is there. Headless Chromium answers null, so the plain
// page is a real Firefox/Safari for this purpose and the stubbed one is a real
// Chrome. Neither passes `fs=`, because that flag is the override that skips
// the gate — a run with it would assert on nothing.
{
  // --- no keyboard lock: windowed, and the row says why ---------------------
  const plain = await newPage(browser, { width: 1280, height: 800 });
  await plain.goto(`${HOST}/`, { waitUntil: "load" });
  await toOptions(plain);
  await plain.click('.bs-menu [data-act="settings"]');
  await wait(400);
  const row = await plain.evaluate(() => {
    const btn = document.querySelector('.bs-menu [data-toggle="autoFullscreen"]');
    const sec = btn?.closest(".sec");
    return {
      present: !!btn,
      disabled: btn?.hasAttribute("disabled") ?? null,
      pressed: btn?.getAttribute("aria-pressed") ?? null,
      // The note is the row's reason, and it has to be IN the same section: a
      // note rendered into the wrong tab is a disabled control with nothing
      // beside it, which is the thing this is here to prevent.
      notes: [...(sec?.querySelectorAll(".note") ?? [])].map((n) => n.textContent.trim()),
      // A pad cursor must not be able to stand on it — the same clause the
      // disabled language chips rely on. See FOCUSABLE in ui/settings.ts.
      focusable: !!btn?.matches('button:not([disabled]):not([tabindex="-1"]):not(.sec.off *)'),
    };
  });
  await plain.keyboard.press("Escape");
  await wait(400);
  const plainStart = await newGame(plain);

  // --- with the lock: the preference is honoured ---------------------------
  const locked = await newPage(browser, { width: 1280, height: 800 });
  await locked.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "keyboard", {
      configurable: true,
      value: { lock: () => Promise.resolve(), unlock: () => {} },
    });
  });
  await locked.goto(`${HOST}/`, { waitUntil: "load" });
  await toOptions(locked);
  const lockedStart = await newGame(locked);

  results.fullscreenGate = {
    withoutLock: {
      survivesEscape: plainStart.survivesEscape,
      wentFullscreen: plainStart.active,
      row,
    },
    withLock: {
      survivesEscape: lockedStart.survivesEscape,
      wentFullscreen: lockedStart.active,
    },
  };
  await plain.close();
  await locked.close();
}

// ---------- 8. THE MENU KEY IS F10, AND THE POINTER COMES BACK -------------
//
// Two halves of the same move. The in-game menu was on Escape, which the browser
// spends on its own business — leaving fullscreen, dropping pointer lock —
// before the page has any say, so half the presses that mattered never arrived
// as a key at all. It is F10 now, an ordinary key nothing else claims.
//
// What Escape still does is release the pointer, on every browser and in every
// window: the keyboard lock only covers a FULLSCREEN document. So a player who
// closes a panel with it is left standing in the world with mouse look dead, and
// `Input.armRelock` is what puts it back the moment they move again — asserted
// here on the CAMERA, not on `pointerLockElement`, because a lock the game is
// not reading is not a recovery.
{
  const p = await newPage(browser, { width: 1280, height: 800 });
  await p.goto(`${HOST}/?fps=30&menu=0`, { waitUntil: "load" });
  await p.waitForSelector("canvas");
  await wait(3000);

  // The in-game menu, read off the DOM: `__dbgBoot().menuOpen` is the TITLE
  // screen, which is a different menu with a different question behind it.
  const menuUp = () => p.evaluate(() => !!document.querySelector(".bs-pause"));

  // Escape MUST NOT open it. This is the whole report, restated as an assertion.
  await p.keyboard.press("Escape");
  await wait(400);
  const afterEscape = await menuUp();

  // F10 does, and F10 closes it again — the toggle a menu key has to be.
  await p.keyboard.press("F10");
  await wait(400);
  const afterF10 = await menuUp();
  const buttonPresent = await p.evaluate(() => {
    const b = document.querySelector(".bs-menubtn");
    return b ? { cap: b.querySelector(".cap")?.textContent?.trim() ?? null } : null;
  });
  await p.keyboard.press("F10");
  await wait(400);
  const afterSecondF10 = await menuUp();

  // ---- the pointer ---------------------------------------------------------
  // A real click takes the lock the way a player's does. Then the lock is
  // dropped the way Escape drops it — `exitPointerLock` is the same event the
  // browser raises for the key, and it is used here because a headless Escape
  // reaches the page as a key rather than as the user-agent action being
  // simulated.
  await p.mouse.click(640, 400);
  await wait(500);
  const lockedAfterClick = await p.evaluate(() => document.pointerLockElement !== null);
  await p.evaluate(() => document.exitPointerLock());
  await wait(400);
  const lostIt = await p.evaluate(() => document.pointerLockElement === null);
  const pendingAfterLoss = await p.evaluate(() => window.__dbgInput().relockPending);

  // Chrome refuses a re-lock for ~1.25 s after one is given up, which is why
  // `RELOCK_WAIT_MS` exists — so the movement key comes AFTER that window, the
  // way a player pressing on with the game does.
  await wait(1500);
  const yawBefore = await p.evaluate(() => window.__dbgCamYaw());
  await p.keyboard.down("KeyW");
  await wait(600);
  await p.keyboard.up("KeyW");
  const relocked = await p.evaluate(() => document.pointerLockElement !== null);
  // THE CAMERA IS THE MEASUREMENT. `pointerLockElement` says the browser handed
  // it over; only a yaw change says the game is reading it again.
  for (let i = 0; i < 10; i++) {
    await p.mouse.move(400 + i * 40, 400);
  }
  await wait(400);
  let turned = (await p.evaluate(() => window.__dbgCamYaw())) - yawBefore;
  while (turned > Math.PI) {
    turned -= 2 * Math.PI;
  }
  while (turned < -Math.PI) {
    turned += 2 * Math.PI;
  }

  results.menuKey = {
    escapeOpenedTheMenu: afterEscape,
    f10OpenedIt: afterF10,
    f10ClosedIt: afterSecondF10,
    hudButton: buttonPresent,
    pointer: {
      lockedAfterClick,
      lostIt,
      pendingAfterLoss,
      relocked,
      turnedAfterRelock: +Math.abs(turned).toFixed(4),
    },
  };
  await p.close();
}

// ---------- 9. F3 IS THE DEVELOPER'S KEY, BEHIND `debug=1` -----------------
//
// Both halves. On a player's page the sheet does not list F3, the press opens
// nothing and `§` opens no console; on a `debug=1` page all three work. The row stays
// in the table either way — section 1's static scan is about what the CODE
// reads, and the code still reads F3 (behind the flag).
{
  const probe = async (query) => {
    const p = await newPage(browser, { width: 1280, height: 800 });
    await p.goto(`${HOST}/?fps=30&menu=0${query}`, { waitUntil: "load" });
    await p.waitForSelector("canvas");
    await p.waitForFunction(() => window.__dbgBoot?.().playing, { timeout: 60000 });
    await wait(300);
    await p.keyboard.press("F1");
    await wait(400);
    const listsF3 = await p.evaluate(() =>
      [...document.querySelectorAll(".bs-keys .bs-keyrow kbd")].some(
        (k) => k.textContent.trim() === "F3",
      ),
    );
    await p.keyboard.press("Escape");
    await wait(300);
    await p.keyboard.press("F3");
    await wait(400);
    const panelOpen = await p.evaluate(() => {
      const el = document.querySelector(".bs-perf");
      return !!el && getComputedStyle(el).display !== "none";
    });
    // The `§` console is behind the same flag: on a player's page it is not built at all.
    await p.keyboard.press("Backquote");
    await wait(300);
    const consoleOpen = await p.evaluate(() => {
      const el = document.querySelector(".bs-console-input");
      return !!el && el.offsetParent !== null;
    });
    await p.close();
    return { listsF3, panelOpen, consoleOpen };
  };
  results.debugGate = { player: await probe(""), developer: await probe("&debug=1") };
}

console.log(JSON.stringify(results, null, 2));
await browser.close();

// ---------------------------------------------------------------------------
// What has to be true
// ---------------------------------------------------------------------------
// This file USED TO ONLY PRINT. AGENTS.md described `unlisted` as "a run rather
// than a wish" and it was still a wish — nothing read the output, so a binding
// added without a row, or a function key added without a preventDefault, sailed
// through a green suite. Both have now happened. It exits non-zero.
const fail = [];
const check = (ok, what) => {
  if (!ok) {
    fail.push(what);
  }
};

check(
  results.table.unlisted.length === 0,
  `the sheet does not name ${results.table.unlisted.join(", ")} — add a row to ui/keybinds.ts`,
);
check(
  results.table.uncaptured.length === 0,
  `${results.table.uncaptured.join(", ")} reach the BROWSER — add them to Input.CAPTURED`,
);
// Read through a LOOP VARIABLE, which no regex over the source can see: the
// hotbar digits (`input.pressed(code)` over an `as const` array in main.ts) and
// the panel-navigation keys (the same shape, driving ui/perf-panel.ts). Anything
// else appearing here is a row describing a key nothing reads.
const expectUnscanned = new Set([
  "Digit1",
  "Digit2",
  "Digit3",
  "Digit4",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Enter",
  "KeyR",
]);
const strayRows = results.table.listedNotScanned.filter((c) => !expectUnscanned.has(c));
check(strayRows.length === 0, `the sheet names ${strayRows.join(", ")}, which nothing reads`);
check(results.sheet?.afterOpen?.open !== false, "F1 did not open the sheet");
// Escape: both halves. See section 6 for what the stub can and cannot prove.
check(
  results.escapeLock?.enteredFullscreen === true,
  "the page never went fullscreen — the lock assertions below prove nothing",
);
check(
  results.escapeLock?.lockedCodes === "lock:Escape",
  `fullscreen asked for ${results.escapeLock?.lockedCodes} — it must lock exactly Escape`,
);
check(
  results.escapeLock?.lockedWhileFullscreen === true,
  "the keyboard lock was not held in fullscreen — Escape would leave it",
);
check(
  results.escapeLock?.releasedOnExit === true,
  "the keyboard lock outlived fullscreen — leaving must give every key back",
);
check(
  results.escapeLock?.escapePrevented === true,
  "Escape reaches the BROWSER — it must be in Input.CAPTURED",
);
check(
  results.stagedBoot?.alternates !== false,
  `F1 does not alternate uncapped (${results.stagedBoot?.pattern})`,
);
// The gate, both halves — issue #83. The second is what stops "never go
// fullscreen" from passing this section.
check(
  results.fullscreenGate?.withoutLock?.wentFullscreen === false,
  "New Game took fullscreen with no keyboard lock — Escape would take it straight back",
);
check(
  results.fullscreenGate?.withLock?.wentFullscreen === true,
  "New Game stayed windowed WITH the lock — the preference is no longer honoured anywhere",
);
check(
  results.fullscreenGate?.withoutLock?.row?.disabled === true,
  'the "Fullscreen on start" row answers in a browser that cannot keep fullscreen',
);
check(
  results.fullscreenGate?.withoutLock?.row?.focusable === false,
  "a pad cursor can still land on the disabled fullscreen row",
);
check(
  results.fullscreenGate?.withoutLock?.row?.pressed === "false",
  "the disabled fullscreen row shows ON while the game starts in a window",
);
check(
  (results.fullscreenGate?.withoutLock?.row?.notes ?? []).some((n) => /Escape/.test(n)),
  "the disabled fullscreen row has no note saying why",
);
// The menu key, both halves — the move off Escape is only a fix if Escape has
// actually stopped opening it.
check(
  results.menuKey?.escapeOpenedTheMenu === false,
  "Escape still opens the in-game menu — the browser spends that key on fullscreen and pointer lock",
);
check(results.menuKey?.f10OpenedIt === true, "F10 did not open the in-game menu");
check(
  results.menuKey?.f10ClosedIt === false,
  "F10 did not close the menu it opened — it must toggle",
);
check(results.menuKey?.hudButton !== null, "the HUD has no menu button (.bs-menubtn)");
check(
  results.menuKey?.hudButton?.cap === "F10",
  `the HUD menu button prints "${results.menuKey?.hudButton?.cap}" — it must name the binding`,
);
// Pointer-lock recovery. `lockedAfterClick` first, or the rest proves nothing.
check(
  results.menuKey?.pointer?.lockedAfterClick === true,
  "a click never took pointer lock — the recovery assertions below prove nothing",
);
check(
  results.menuKey?.pointer?.pendingAfterLoss === true,
  "a pointer taken while the game wanted it did not arm a recovery",
);
check(
  results.menuKey?.pointer?.relocked === true,
  "moving did not take the pointer back after the browser dropped it",
);
check(
  results.menuKey?.pointer?.turnedAfterRelock > 0.01,
  "the pointer came back but the camera did not turn — the game is not reading it",
);

check(
  JSON.stringify(results.debugGate?.player) ===
    JSON.stringify({ listsF3: false, panelOpen: false, consoleOpen: false }),
  `a player's page: ${JSON.stringify(results.debugGate?.player)} — want no F3 row, no panel, no console`,
);
check(
  JSON.stringify(results.debugGate?.developer) ===
    JSON.stringify({ listsF3: true, panelOpen: true, consoleOpen: true }),
  `a debug=1 page: ${JSON.stringify(results.debugGate?.developer)} — want the F3 row, the panel and the console`,
);

if (fail.length) {
  console.error(`\n${fail.length} failure(s):\n  ${fail.join("\n  ")}`);
  process.exit(1);
}
