// Day/night regression: automatic motion, F3/debug precedence, quest-derived
// locks, coherent celestial directions, and the budgeted shadow-light cadence.
// Usage: bun tools/test-daynight.mjs (dev server must be running).
import { launchBrowser, newContextPage, wait } from "./browser.mjs";
import { BASE as HOST } from "./target.mjs";

const browser = await launchBrowser();
const { ctx, page } = await newContextPage(browser, { width: 1280, height: 800 });
page.setDefaultTimeout(90000);
const failures = [];
const check = (ok, message) => {
  if (!ok) {
    failures.push(message);
  }
};
const circular = (a, b) => Math.abs(((((a - b) % 1) + 1.5) % 1) - 0.5);

try {
  await page.goto(`${HOST}/?fps=30&menu=0&vol=0&debug=1`, { waitUntil: "load", timeout: 90000 });
  await page.waitForFunction(() => window.__dbgBoot?.().playing && window.__dbgTime, {
    timeout: 60000,
  });

  const initial = await page.evaluate(() => window.__dbgTime());
  await wait(450);
  const running = await page.evaluate(() => window.__dbgTime());
  check(initial.source === "auto", "a fresh game did not start on the automatic clock");
  check(running.phase > initial.phase, "the automatic clock did not advance");
  check(circular(initial.phase, 0.5) < 0.01, "a fresh game did not start at designed daylight");

  await page.evaluate(() => window.__dbgTime("midnight"));
  await wait(1250);
  const midnight = await page.evaluate(() => window.__dbgTime());
  check(midnight.source === "debug", "debug override did not take precedence");
  check(circular(midnight.phase, 0) < 0.01, "midnight preset did not reach phase 0");
  check(midnight.stars > 0.9 && midnight.moon > 0.9, "night sky did not expose moon and stars");
  check(midnight.exposure < initial.exposure, "night exposure was not darker than daylight");
  check(
    midnight.shadow.bounceIntensity >= 0.35,
    "midnight anti-moon fill is too weak to keep the hero face readable",
  );
  check(
    midnight.lighting["hero-highlight"] === initial.lighting["hero-highlight"] &&
      midnight.lighting["hero-highlight"] > 0,
    "actor highlight changed with the day/night cycle",
  );
  check(midnight.lighting["town-windows"] > 1.2, "ground buildings did not light at night");
  check(midnight.lighting["skyhaven-lights"] > 1.5, "Skyhaven lanterns did not light at night");
  check(
    midnight.lighting["skyhaven-local-light"] >= 79,
    "Skyhaven fixtures emitted no local illumination at night",
  );
  check(
    midnight.lighting["cloud-moon-fill"] > initial.lighting["cloud-moon-fill"],
    "clouds did not gain moon-scattered fill at night",
  );
  const dot = midnight.sunDirection.reduce((sum, v, i) => sum + v * midnight.moonDirection[i], 0);
  check(dot < -0.999, "sun and moon directions are not opposite");

  const cadence0 = midnight.shadow.celestialUpdates;
  await wait(1250);
  const cadence1 = (await page.evaluate(() => window.__dbgTime())).shadow.celestialUpdates;
  check(
    cadence1 - cadence0 >= 1 && cadence1 - cadence0 <= 3,
    `light cadence rebuilt ${cadence1 - cadence0} times in 1.25 s (expected 1..3)`,
  );

  await page.evaluate(() => window.__dbgTime("clear"));
  await wait(350);
  const cleared = await page.evaluate(() => window.__dbgTime());
  check(cleared.source === "auto", "Clear did not resume the automatic clock");
  check(cleared.phase > 0 && cleared.phase < 0.01, "Clear did not resume from the pinned phase");

  await page.evaluate(async () => {
    const { content } = await import("/src/content/index.ts");
    await content.load("example-quest", "quest");
    content.state.setQuestStatus("quest:encampment/first-steps", "active");
  });
  await wait(1250);
  const quest = await page.evaluate(() => window.__dbgTime());
  check(
    quest.source === "quest" && quest.quest === "quest:encampment/first-steps",
    "active quest did not derive its time lock",
  );
  check(circular(quest.phase, 0) < 0.01, "quest timeOfDay did not pin midnight");

  await page.evaluate(() => window.__dbgTime("noon"));
  await wait(1250);
  const debugOverQuest = await page.evaluate(() => window.__dbgTime());
  check(
    debugOverQuest.source === "debug" && circular(debugOverQuest.phase, 0.5) < 0.01,
    "debug preset did not override the quest lock",
  );
  check(
    debugOverQuest.lighting["town-windows"] < 0.01 &&
      debugOverQuest.lighting["skyhaven-lights"] < 0.01 &&
      debugOverQuest.lighting["skyhaven-local-light"] < 0.01,
    "night-only emissive details remained lit at noon",
  );
  await page.evaluate(() => window.__dbgTime("clear"));
  await wait(1250);
  const questRestored = await page.evaluate(() => window.__dbgTime());
  check(
    questRestored.source === "quest" && circular(questRestored.phase, 0) < 0.01,
    "clearing debug did not restore the quest lock",
  );

  await page.evaluate(async () => {
    const { content } = await import("/src/content/index.ts");
    content.state.setQuestStatus("quest:encampment/first-steps", "completed");
    content.release("example-quest", "quest");
  });
  await wait(350);
  const released = await page.evaluate(() => window.__dbgTime());
  check(released.source === "auto", "completing/releasing the quest did not resume time");

  await page.keyboard.press("F3");
  await wait(120);
  const f3 = await page.evaluate(() => ({
    open: getComputedStyle(document.querySelector(".bs-perf")).display !== "none",
    timeRow: document.querySelector('[data-time="day"]')?.textContent ?? "",
  }));
  check(f3.open && f3.timeRow.includes("Time of day"), "F3 has no time-of-day control");

  console.log(
    JSON.stringify(
      {
        initial,
        midnight,
        cadenceUpdates: cadence1 - cadence0,
        quest: questRestored,
        released,
        f3,
        failures,
      },
      null,
      2,
    ),
  );
} finally {
  await ctx.close();
  await browser.close();
}

if (failures.length) {
  for (const failure of failures) {
    console.error(`FAIL: ${failure}`);
  }
  process.exit(1);
}
