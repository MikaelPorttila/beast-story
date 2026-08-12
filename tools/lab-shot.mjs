// Fast screenshot of the isolated lab stage (no world streaming).
// Usage: bun tools/lab-shot.mjs <out.png> "<labQuery>" [width] [height]
// The lab's ?t= parameter freezes a deterministic frame, so shots are
// reproducible and need no settle time.
//   bun tools/lab-shot.mjs shots/lab-fox.png "beast=emberfox&t=2&anim=cast"
//   bun tools/lab-shot.mjs shots/lab-all.png "beasts=all&t=1.5" 2000 700
import { launchBrowser, newPage, wait, logPageErrors } from "./browser.mjs";
import { BASE as HOST } from "./target.mjs";

const [out = "lab.png", query = "", w = "1000", h = "800"] = process.argv.slice(2);
const hasFreeze = /(^|&)t=/.test(query);
// Live (non-frozen) lab runs are capped at 30 fps like the game captures.
// A frozen frame renders exactly once, so the cap is irrelevant there.
const q = hasFreeze || /(^|&)fps=/.test(query) ? query : query ? `${query}&fps=30` : "fps=30";
const url = `${HOST}/lab.html${q ? "?" + q : ""}`;

const browser = await launchBrowser();
const page = await newPage(browser, { width: +w, height: +h });
logPageErrors(page);
await page.goto(url, { waitUntil: "load", timeout: 30000 });
await page.waitForSelector("canvas", { timeout: 15000 });
// A frozen frame only needs the single render to land; live mode needs settling.
await wait(hasFreeze ? 1200 : 3000);
await page.screenshot({ path: out });
await browser.close();
console.log("saved", out);
