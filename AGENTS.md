# Agent guidelines — Cube Pals

## Use Bun, not Node/npm

Bun (`bun >= 1.3.14`) is the runtime and package manager for this project. Prefer
it for **every** JavaScript/TypeScript command. Reach for `node`/`npm` only when
Bun genuinely cannot do the job, and say so when you do.

| Instead of | Use |
| --- | --- |
| `npm install` | `bun install` |
| `npm install <pkg>` | `bun add <pkg>` (`bun add -d <pkg>` for dev deps) |
| `npm uninstall <pkg>` | `bun remove <pkg>` |
| `npm run dev` / `build` / `preview` | `bun run dev` / `build` / `preview` |
| `npx <tool>` | `bunx <tool>` |
| `node tools/foo.mjs …` | `bun tools/foo.mjs …` |

`bun.lock` is the lockfile of record. `package-lock.json` is a leftover — do not
update it, and never mix `npm install` into a Bun-managed tree.

### The capture / lab tools

The scripts in `tools/` are plain ESM and run under Bun:

```bash
bun tools/screenshot.mjs shots/overview.png "photo=1" 1920 1080 3500
```

```bash
bun tools/lab-shot.mjs shots/lab-fox.png "pal=emberfox&t=2"
```

They need the dev server up (`bun run dev`) and `BROWSER_EXECUTABLE` set in
`.env.local`, which Bun loads automatically — see [.env.example](.env.example).

### Browser automation: puppeteer-core, not Playwright

**Playwright cannot be used in this project.** It does not work on the Bun
runtime at all — neither of its transports comes up:

- `chromium.launch()` hangs on the `--remote-debugging-pipe` handshake (the
  browser starts, but nothing ever answers on fd 4);
- `connectOverCDP()` times out even though a raw `WebSocket` to the same
  endpoint replies instantly.

There is no Node on this machine to fall back to, so the tools use
**`puppeteer-core`**, which works under Bun. `puppeteer-core` deliberately
ships no browser of its own — it drives a browser already installed on the
machine, named by `BROWSER_EXECUTABLE`.

Everything browser-related lives in [tools/browser.mjs](tools/browser.mjs) —
launch flags, viewport/phone emulation, and small helpers that replace the
Playwright APIs puppeteer lacks (`wait` for the removed `page.waitForTimeout`,
`count`, `isVisible`, `glRenderer`). Import from there; don't call
`puppeteer.launch()` in a tool.

### Tests use hardware acceleration when it is available

Captures and tests render through whatever GPU the host has. Headless Brave
finds it on its own, so **pass no GL flags** — `glRenderer()` reports which path
a run actually got.

Do not reintroduce `--use-angle=swiftshader` / `--enable-unsafe-swiftshader` as a
default. Those force every pixel through the CPU rasteriser, which is
dramatically slower per frame and is where the CPU spikes during test runs came
from. A host without a usable GPU can opt into that fallback with
`SOFTWARE_GL=1`, and still get correct — just slow — renders.

Frame-rate-sensitive assertions must therefore hold across a wide range of frame
rates, from a software-rendered host to an accelerated one. Tools cap captures at
`fps=30` for deterministic stills, and anything measuring motion has to survive a
much faster host — e.g. `test-touch.mjs` sums shortest-arc yaw deltas because
`__dbgCamYaw()` is an `atan2` that wraps past half a circle within one stick hold
once frames come quickly.

## Everything else

- Dev server: `bun run dev` → http://localhost:5187 (`index.html` = game,
  `lab.html` = isolated stage, see [LAB.md](LAB.md)).
- Typecheck + build: `bun run build` (runs `tsc --noEmit` first — keep it clean).
- Read [LAB.md](LAB.md) before iterating on models, animations or skill VFX;
  in particular, lab shots never count as sign-off — re-verify in `index.html`.
