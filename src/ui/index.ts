import type { ElementType, EventBus, Locomotion, SkillDef } from "../core/types";
import { ELEMENT_COLORS } from "../core/types";
import { CURRENCY, itemName, type BagEntry } from "../core/items";
import { t, type StringKey } from "../i18n";
import { PAD_GLYPHS, type PadGlyphs } from "../core/gamepad";
import { CONTROL_SECTIONS } from "./keybinds";
import { injectStyles } from "./styles";
import {
  elementIcon,
  locomotionIcon,
  tameOrbIcon,
  SHARD_ICON,
  CHECK_ICON,
  CLOSE_ICON,
  BURGER_ICON,
} from "./icons";

export interface BeastHudInfo {
  name: string;
  element: ElementType;
  /** Independent of `element` — a water beast can also be amphibious. */
  locomotion: Locomotion;
  level: number;
  xp: number;
  xpToNext: number;
  hp: number;
  maxHp: number;
}

export interface SkillSlot {
  def: SkillDef;
  cooldownRemaining: number;
  ready: boolean;
}

/** Compass chip. `id` is identity: re-adding moves it, never duplicates. */
export interface CompassMarker {
  id: string;
  /** World position; only the horizontal plane is read. */
  x: number;
  z: number;
  color: number;
  /** Short tag inside the chip (~4 chars); omit for a plain square. */
  label?: string;
}

/** One HUD tracker row (issue #98). Strings arrive already resolved. */
export interface QuestTrackRow {
  id: string;
  name: string;
  category: "main" | "side";
  steps: readonly { text: string; have: number; need: number }[];
}

/** What a den sells. A skill offer is per beast; an item offer is not. */
export type ShopOffer = SkillOffer | ItemOffer;

export interface SkillOffer {
  kind: "skill";
  skill: SkillDef;
  price: number;
  owned: boolean;
  /** Identity — matching on the display name broke under a translation. */
  beastId: string;
  beastName: string;
  affordable: boolean;
}

/** A consumable on the shelf. Strings arrive already resolved. */
export interface ItemOffer {
  kind: "item";
  itemId: string;
  name: string;
  description: string;
  price: number;
  affordable: boolean;
  color: number;
  orbTier?: number;
  held: number;
}

function hexColor(c: number): string {
  return "#" + c.toString(16).padStart(6, "0");
}
function rgba(c: number, a: number): string {
  return `rgba(${(c >> 16) & 255},${(c >> 8) & 255},${c & 255},${a})`;
}
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function div(className: string, html = ""): HTMLDivElement {
  const el = document.createElement("div");
  el.className = className;
  if (html) {
    el.innerHTML = html;
  }
  return el;
}
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** The version plate is a dev affordance: opt in with `?debug=1`. */
function isDebugMode(): boolean {
  try {
    return new URLSearchParams(window.location.search).get("debug") === "1";
  } catch {
    return false;
  }
}

const LOCK_ICON =
  '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
  '<path fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" ' +
  'd="M8.2 10.4V7.6a3.8 3.8 0 0 1 7.6 0v2.8"/>' +
  '<rect fill="currentColor" x="5.4" y="10.2" width="13.2" height="9.6" rx="2.2"/>' +
  "</svg>";

function lockedSlotHtml(index: number, p: Prompts): string {
  return `<span class="key">${p.slot(index)}</span><span class="lock">${LOCK_ICON}</span>`;
}

interface BeastCardRefs {
  card: HTMLDivElement;
  inner: HTMLDivElement;
  hpBar: HTMLElement;
  xpBar: HTMLElement;
  /** Hidden while a fresh beast has nothing to show. */
  xpTrack: HTMLElement;
  sig: string;
}

interface SlotRefs {
  el: HTMLDivElement;
  cd: HTMLElement;
  cdNum: HTMLElement;
  skillId: string;
  prevReady: boolean;
  lastSweepDeg: number;
  lastCdText: string;
}

/** Compass scale: 3.4 px/deg puts ~123° across the 420px window at 1280 wide. */
const BS_PX_PER_DEG = 3.4;
/** Tick every 15°, label every 45°. */
const BS_TICK_STEP = 15;
/** Three copies of the circle end to end, so sliding never hits a seam. */
const BS_TAPE_DEG = 1080;
/** Clamped markers park this far in, clear of the 16px mask fade. */
const BS_EDGE_PAD = 24;
const BS_RAD2DEG = 180 / Math.PI;

interface MarkerRefs {
  m: CompassMarker;
  el: HTMLDivElement;
  /** Last written px offset from centre; NaN forces the next write. */
  lastPx: number;
  /** -1 clamped left, 0 on strip, 1 clamped right; 2 = never written. */
  lastEdge: number;
  rel: number;
}

interface ToastEntry {
  el: HTMLDivElement;
  t: number;
  hiding: boolean;
}

/** `<kbd>` cap. Exported: the markup travels inside a placeholder VALUE. */
export function kbd(key: string): string {
  return `<kbd>${key}</kbd>`;
}

/** Pad face. Over two chars gets a pill: `Start` clips the circle, `RT` fits. */
export function padKey(key: string): string {
  return `<kbd class="pad${key.length > 2 ? " wide" : ""}">${key}</kbd>`;
}

/** What the pair are DOING, not which species is under the saddle. */
export type RideMode = "ground" | "flying" | "swimming";

/** Caps for one device. No touch entry: the touch build hides those rows. */
interface Prompts {
  move: string;
  jump: string;
  attack: string;
  skills: string;
  swap: string;
  interact: string;
  altitude: string;
  mount: string;
  dismount: string;
  menu: string;
  slot(i: number): string;
}

const KBM_PROMPTS: Prompts = {
  move: kbd("WASD"),
  jump: kbd("Space"),
  attack: kbd("LMB"),
  skills: `${kbd("1")}–${kbd("4")}`,
  swap: kbd("Tab"),
  interact: kbd("E"),
  altitude: `${kbd("Space")}/${kbd("C")}`,
  mount: kbd("F"),
  dismount: kbd("F"),
  menu: kbd("F10"),
  slot: (i) => String(i + 1),
};

function padPrompts(set: PadGlyphs): Prompts {
  const g = PAD_GLYPHS[set];
  return {
    move: padKey(g.move),
    jump: padKey(g.jump),
    attack: padKey(g.attack),
    skills: `${padKey(g.skill1)}${padKey(g.skill2)}${padKey(g.skill3)}${padKey(g.skill4)}`,
    swap: padKey(g.swap),
    interact: padKey(g.interact),
    altitude: `${padKey(g.altUp)}/${padKey(g.altDown)}`,
    mount: padKey(g.mount),
    dismount: padKey(g.dismount),
    menu: padKey(g.menu),
    slot: (i) => [g.skill1, g.skill2, g.skill3, g.skill4][i] ?? String(i + 1),
  };
}

/** A function, not a constant: a pad may connect mid-session. */
function shopFootHints(p: Prompts): string {
  return (
    `<span>${t("shop.foot.move", { key: p.move })}</span>` +
    `<span>${t("shop.foot.jump", { key: p.jump })}</span>` +
    `<span>${t("shop.foot.attack", { key: p.attack })}</span>` +
    `<span>${t("shop.foot.skills", { key: p.skills })}</span>` +
    `<span>${t("shop.foot.swap", { key: p.swap })}</span>` +
    `<span>${t("shop.foot.interact", { key: p.interact })}</span>`
  );
}

/** Rows come from ui/keybinds.ts; null `glyphs` falls back to Xbox faces. */
function controlsHtml(glyphs: PadGlyphs | null): string {
  const faces = PAD_GLYPHS[glyphs ?? "xbox"];
  let html = "";
  for (const section of CONTROL_SECTIONS) {
    // Section heading doubles as the column header row.
    html +=
      '<div class="bs-keys-sec">' +
      `<div class="bs-keyrow head"><span class="nm">${escapeHtml(t(section.title))}</span>` +
      `<span class="kbm">${escapeHtml(t("keys.col.kbm"))}</span>` +
      `<span class="pad">${escapeHtml(t("keys.col.pad"))}</span><span class="mode"></span></div>`;
    for (const b of section.rows) {
      const caps = b.caps.map(kbd).join(b.join ?? " ");
      const pad = b.pad
        ? b.pad.map((a) => padKey(faces[a])).join("")
        : `<span class="none">${escapeHtml(t("keys.none"))}</span>`;
      const hold = b.mode === "hold";
      html +=
        '<div class="bs-keyrow">' +
        `<span class="nm">${escapeHtml(t(b.label))}` +
        (b.note ? `<em>${escapeHtml(t(b.note))}</em>` : "") +
        `</span><span class="kbm">${caps}</span><span class="pad">${pad}</span>` +
        `<span class="mode ${hold ? "hold" : "press"}">` +
        `${escapeHtml(t(hold ? "keys.mode.hold" : "keys.mode.press"))}</span></div>`;
    }
    html += "</div>";
  }
  return html;
}

export class HUD {
  private root: HTMLDivElement;

  private hpFillEl: HTMLElement;
  private hpGhostEl: HTMLElement;
  private hpValEl: HTMLElement;
  private hpFrac = 1;
  private ghostFrac = 1;
  private ghostDelay = 0;
  private lastFillPct = -1;
  private lastGhostPct = -1;
  private lastHpText = "";

  private beastRefs: [BeastCardRefs, BeastCardRefs];
  private prevBeastNames: [string | null, string | null] = [null, null];

  private slotRefs: SlotRefs[] = [];

  // currency: the 'shard' item, displayed as "Cubloons" (see src/i18n)
  private shardNumEl: HTMLElement;
  private shardLblEl: HTMLElement;
  private shardPillEl: HTMLElement;
  private shopBalEl: HTMLElement | null = null;
  private shardsShown = 0;
  private shardsTarget = 0;
  private shardsDisplayed = -1;
  private shardsInit = false;

  private bagEl: HTMLDivElement;
  private bagSig = "";
  private orbEl: HTMLDivElement;
  private orbSig = "";

  // tracked quests (issue #98) — filled from the journal; see setQuests
  private questsEl: HTMLDivElement;
  private questSig = "";

  private compassWinEl: HTMLDivElement;
  private compassTapeEl: HTMLDivElement;
  private compassMarksEl: HTMLDivElement;
  private markers: MarkerRefs[] = [];
  private markerIdx = new Map<string, MarkerRefs>();
  /** Measured window width; the visible span is this / BS_PX_PER_DEG degrees. */
  private compassW = 0;
  private lastTapeX = NaN;
  private compassHeading = 0;

  private bannerEl: HTMLDivElement;
  private bannerTimer = 0;

  private toastWrap: HTMLDivElement;
  private toasts: ToastEntry[] = [];

  private hintEl: HTMLDivElement;
  private hintText = "";

  private dialogueEl: HTMLDivElement;
  private dialogueWhoEl: HTMLElement;
  private dialogueLineEl: HTMLElement;
  private dialogueFootEl: HTMLElement;
  private dialogueWho = "";
  private dialogueLine = "";
  private dialogueFoot = "";

  /** Which device's caps every prompt prints; swapped only on device change. */
  private prompts: Prompts = KBM_PROMPTS;
  private padGlyphSet: PadGlyphs | null = null;

  private mountHoldEl: HTMLDivElement;
  private mountRingEl: HTMLElement;
  private ridingEl: HTMLDivElement;
  private mountDeg = -1;
  private ridingText = "";
  private ridingBeast: string | null = null;
  private ridingMode: RideMode = "ground";

  private menuBtnEl: HTMLButtonElement;
  private menuBtnCapEl: HTMLElement;
  onMenu: (() => void) | null = null;

  private keysWrap: HTMLDivElement;
  private controlsOpen = false;

  private shopWrap: HTMLDivElement;
  private shopOpen = false;
  private shopOnClose: (() => void) | null = null;

  constructor(bus: EventBus) {
    injectStyles();

    this.root = div("bs-root");

    if (isDebugMode()) {
      this.root.appendChild(div("bs-title bs-glass", "<b>BEAST STORY</b><span>v1.0</span>"));
    }

    // Empty until a quest is tracked in the journal; placement is a :has() rule.
    this.questsEl = div("bs-quests");
    this.root.appendChild(this.questsEl);

    // `onMenu` TAPS F10 rather than opening the menu, so every device arrives at
    // the one reader in main.ts.
    this.menuBtnEl = document.createElement("button");
    this.menuBtnEl.type = "button";
    this.menuBtnEl.className = "bs-menubtn bs-glass";
    this.menuBtnEl.innerHTML = `${BURGER_ICON}<span class="cap"></span>`;
    this.menuBtnCapEl = this.menuBtnEl.querySelector(".cap") as HTMLElement;
    this.menuBtnCapEl.innerHTML = this.prompts.menu;
    this.menuBtnEl.setAttribute("aria-label", t("hud.menu"));
    this.menuBtnEl.title = t("hud.menu");
    this.menuBtnEl.addEventListener("click", () => this.onMenu?.());
    this.root.appendChild(this.menuBtnEl);

    // Label shares update()'s guard with the number, so plurals cannot diverge.
    this.shardPillEl = div(
      "bs-shards bs-glass",
      `<span class="ic">${SHARD_ICON}</span><span class="num">0</span><span class="lbl"></span>`,
    );
    this.shardNumEl = this.shardPillEl.querySelector(".num") as HTMLElement;
    this.shardLblEl = this.shardPillEl.querySelector(".lbl") as HTMLElement;
    // Seeded plural, matching what `shardsDisplayed = -1` claims is on screen.
    this.shardLblEl.textContent = itemName(CURRENCY, 0);
    this.root.appendChild(this.shardPillEl);

    this.bagEl = div("bs-bag");
    this.root.appendChild(this.bagEl);

    this.orbEl = div("bs-orb");
    this.root.appendChild(this.orbEl);

    const compass = div("bs-compass");
    this.compassWinEl = div("win");
    this.compassTapeEl = this.buildCompassTape();
    this.compassMarksEl = div("marks");
    this.compassWinEl.appendChild(this.compassTapeEl);
    this.compassWinEl.appendChild(this.compassMarksEl);
    compass.appendChild(this.compassWinEl);
    compass.appendChild(div("ptr"));
    this.root.appendChild(compass);

    this.root.appendChild(div("bs-cross"));

    // Hold-to-mount ring wraps the crosshair, where the player is looking.
    this.mountHoldEl = div(
      "bs-mounthold",
      `<div class="ring"></div><div class="lbl">${t("hud.mountHold", { key: this.prompts.mount })}</div>`,
    );
    this.mountRingEl = this.mountHoldEl.querySelector(".ring") as HTMLElement;
    this.root.appendChild(this.mountHoldEl);

    this.ridingEl = div("bs-riding bs-glass");
    this.root.appendChild(this.ridingEl);

    const left = div("bs-left");
    const beasts = div("bs-beasts");
    this.beastRefs = [this.makeBeastCard(true), this.makeBeastCard(false)];
    beasts.appendChild(this.beastRefs[0].card);
    beasts.appendChild(this.beastRefs[1].card);
    left.appendChild(beasts);

    const hp = div(
      "bs-hp",
      `<div class="row"><span class="lbl">${escapeHtml(t("hud.hp"))}</span><span class="val"></span></div>` +
        '<div class="track"><div class="ghost"></div><div class="fill"></div></div>',
    );
    this.hpFillEl = hp.querySelector(".fill") as HTMLElement;
    this.hpGhostEl = hp.querySelector(".ghost") as HTMLElement;
    this.hpValEl = hp.querySelector(".val") as HTMLElement;
    left.appendChild(hp);
    this.root.appendChild(left);

    const hotbar = div("bs-hotbar");
    for (let i = 0; i < 4; i++) {
      const slot = div("bs-slot empty", lockedSlotHtml(i, this.prompts));
      hotbar.appendChild(slot);
      this.slotRefs.push({
        el: slot,
        cd: slot, // placeholder until filled
        cdNum: slot, // placeholder until filled
        skillId: "",
        prevReady: false,
        lastSweepDeg: -1,
        lastCdText: "",
      });
    }
    this.root.appendChild(hotbar);

    this.hintEl = div("bs-hint bs-glass");
    this.root.appendChild(this.hintEl);

    this.dialogueEl = div(
      "bs-dialogue bs-glass",
      '<div class="who"></div><div class="line"></div><div class="foot"></div>',
    );
    this.dialogueWhoEl = this.dialogueEl.querySelector(".who") as HTMLElement;
    this.dialogueLineEl = this.dialogueEl.querySelector(".line") as HTMLElement;
    this.dialogueFootEl = this.dialogueEl.querySelector(".foot") as HTMLElement;
    this.root.appendChild(this.dialogueEl);

    this.bannerEl = div(
      "bs-banner bs-glass",
      `<div class="eyebrow">${escapeHtml(t("hud.levelUp"))}</div><div class="txt"></div>`,
    );
    this.root.appendChild(this.bannerEl);

    this.toastWrap = div("bs-toasts");
    this.root.appendChild(this.toastWrap);

    this.shopWrap = div("bs-shopwrap");
    this.root.appendChild(this.shopWrap);

    // Last child of the root, so the sheet draws over an open shop.
    this.keysWrap = div("bs-keyswrap");
    this.keysWrap.setAttribute("data-cursor", "help");
    this.root.appendChild(this.keysWrap);

    document.body.appendChild(this.root);
    // The visible span is measured, not constant: width is min(420px,44vw).
    this.measureCompass();
    window.addEventListener("resize", () => this.measureCompass());

    // No Escape listener here: a local one closed the panel synchronously and
    // the host's slice then read the same press as "open the menu". Escape
    // belongs to main.ts's cancel branch; the X and scrim stay, being clicks.

    this.setPlayerHp(100, 100);

    bus.on((e) => {
      if (e.type === "toast") {
        this.addToast(e.text);
      } else if (e.type === "shardsChanged") {
        this.setShards(e.total);
      } else if (e.type === "beastLevelUp") {
        this.showLevelUp(e.nameKey, e.level, e.learned);
      }
    });
  }

  setPlayerHp(hp: number, maxHp: number): void {
    const frac = maxHp > 0 ? clamp01(hp / maxHp) : 0;
    if (frac < this.hpFrac) {
      this.ghostDelay = 0.35;
    } // took damage: ghost lingers
    if (frac > this.ghostFrac) {
      this.ghostFrac = frac;
    } // healed: ghost snaps up
    this.hpFrac = frac;

    const pct = Math.round(frac * 1000) / 10;
    if (pct !== this.lastFillPct) {
      this.lastFillPct = pct;
      const hue = 8 + frac * 112; // red -> green
      this.hpFillEl.style.width = `${pct}%`;
      this.hpFillEl.style.background = `linear-gradient(90deg, hsl(${hue.toFixed(0)},82%,48%), hsl(${hue.toFixed(0)},85%,60%))`;
    }
    const text = `${Math.max(0, Math.ceil(hp))} / ${Math.ceil(maxHp)}`;
    if (text !== this.lastHpText) {
      this.lastHpText = text;
      this.hpValEl.textContent = text;
    }
  }

  private makeBeastCard(primary: boolean): BeastCardRefs {
    const card = div(`bs-beast hidden ${primary ? "primary" : "support"}`);
    const inner = div("bs-beast-in");
    card.appendChild(inner);
    return { card, inner, hpBar: inner, xpBar: inner, xpTrack: inner, sig: "" };
  }

  setBeasts(primary: BeastHudInfo | null, support: BeastHudInfo | null): void {
    const swapped =
      primary !== null &&
      support !== null &&
      this.prevBeastNames[0] === support.name &&
      this.prevBeastNames[1] === primary.name;
    this.renderBeast(this.beastRefs[0], primary, swapped);
    this.renderBeast(this.beastRefs[1], support, swapped);
    this.prevBeastNames[0] = primary?.name ?? null;
    this.prevBeastNames[1] = support?.name ?? null;
  }

  private renderBeast(refs: BeastCardRefs, info: BeastHudInfo | null, animateSwap: boolean): void {
    if (!info) {
      refs.card.classList.add("hidden");
      refs.sig = "";
      return;
    }
    refs.card.classList.remove("hidden");
    const sig = `${info.name}|${info.element}|${info.locomotion}|${info.level}`;
    if (sig !== refs.sig) {
      refs.sig = sig;
      const el = ELEMENT_COLORS[info.element];
      refs.card.style.setProperty("--el", hexColor(el));
      refs.inner.innerHTML =
        `<div class="badge">${elementIcon(info.element)}` +
        `<span class="loco">${locomotionIcon(info.locomotion)}</span></div>` +
        `<div class="meta">` +
        `<div class="row"><span class="nm">${escapeHtml(info.name)}</span>` +
        `<span class="lv">${escapeHtml(t("hud.level", { n: info.level }))}</span></div>` +
        `<div class="bs-micro hp"><i></i></div>` +
        `<div class="bs-micro xp"><i></i></div>` +
        `</div>`;
      refs.hpBar = refs.inner.querySelector(".bs-micro.hp > i") as HTMLElement;
      refs.xpBar = refs.inner.querySelector(".bs-micro.xp > i") as HTMLElement;
      refs.xpTrack = refs.inner.querySelector(".bs-micro.xp") as HTMLElement;
      if (animateSwap) {
        refs.inner.classList.remove("bs-swap");
        void refs.inner.offsetWidth; // restart animation
        refs.inner.classList.add("bs-swap");
      }
    }
    const hpPct = Math.round(clamp01(info.maxHp > 0 ? info.hp / info.maxHp : 0) * 1000) / 10;
    const xpPct = Math.round(clamp01(info.xpToNext > 0 ? info.xp / info.xpToNext : 0) * 1000) / 10;
    refs.hpBar.style.width = `${hpPct}%`;
    refs.xpBar.style.width = `${xpPct}%`;
    // An empty track under a Lv 1 beast reads as broken; past Lv 1 it means something.
    const showXp = info.xpToNext > 0 && (info.xp > 0 || info.level > 1);
    refs.xpTrack.style.display = showXp ? "" : "none";
  }

  setSkills(slots: SkillSlot[]): void {
    for (let i = 0; i < this.slotRefs.length; i++) {
      const refs = this.slotRefs[i];
      const slot = i < slots.length ? slots[i] : undefined;
      if (!slot) {
        if (refs.skillId !== "") {
          refs.skillId = "";
          refs.el.className = "bs-slot empty";
          refs.el.innerHTML = lockedSlotHtml(i, this.prompts);
          refs.el.removeAttribute("style");
          refs.prevReady = false;
          refs.lastSweepDeg = -1;
          refs.lastCdText = "";
        }
        continue;
      }

      const def = slot.def;
      if (refs.skillId !== def.id) {
        refs.skillId = def.id;
        const el = ELEMENT_COLORS[def.element];
        refs.el.className = "bs-slot filled";
        refs.el.style.setProperty("--el", hexColor(el));
        refs.el.style.setProperty("--el2", rgba(el, 0.55));
        refs.el.style.background =
          `linear-gradient(165deg, ${rgba(el, 0.26)}, ${rgba(el, 0.08)}), ` +
          `linear-gradient(165deg, rgba(30,38,54,.72), rgba(14,18,28,.82))`;
        refs.el.innerHTML =
          `<span class="key">${this.prompts.slot(i)}</span>` +
          `<span class="ic">${elementIcon(def.element)}</span>` +
          `<span class="cd"></span><span class="cdnum"></span>` +
          `<span class="nm">${escapeHtml(t(def.nameKey))}</span>`;
        refs.cd = refs.el.querySelector(".cd") as HTMLElement;
        refs.cdNum = refs.el.querySelector(".cdnum") as HTMLElement;
        refs.prevReady = slot.ready;
        refs.lastSweepDeg = -1;
        refs.lastCdText = "";
      }

      const frac = def.cooldown > 0 ? clamp01(slot.cooldownRemaining / def.cooldown) : 0;
      const deg = Math.round(frac * 360);
      if (deg !== refs.lastSweepDeg) {
        refs.lastSweepDeg = deg;
        refs.cd.style.background =
          deg > 0 ? `conic-gradient(rgba(8,11,18,.78) ${deg}deg, transparent ${deg}deg)` : "none";
      }
      const cdText =
        slot.cooldownRemaining > 0.05
          ? slot.cooldownRemaining >= 10
            ? String(Math.ceil(slot.cooldownRemaining))
            : slot.cooldownRemaining.toFixed(1)
          : "";
      if (cdText !== refs.lastCdText) {
        refs.lastCdText = cdText;
        refs.cdNum.textContent = cdText;
      }

      refs.el.classList.toggle("ready", slot.ready);
      refs.el.classList.toggle("cooling", !slot.ready);
      if (slot.ready && !refs.prevReady) {
        refs.el.classList.remove("bs-flash");
        void refs.el.offsetWidth;
        refs.el.classList.add("bs-flash");
      }
      refs.prevReady = slot.ready;
    }
  }

  setShards(n: number): void {
    this.shardsTarget = n;
    if (!this.shardsInit) {
      // first value: no count-up from zero on load
      this.shardsInit = true;
      this.shardsShown = n;
    } else if (n !== this.shardsDisplayed) {
      this.shardPillEl.classList.remove("bs-pop");
      void this.shardPillEl.offsetWidth;
      this.shardPillEl.classList.add("bs-pop");
    }
  }

  /** Call on CHANGE only. A chip present is the support beast's fetch condition. */
  setBag(entries: BagEntry[]): void {
    const sig = entries.map((e) => `${e.def.id}:${e.count}`).join("|");
    if (sig === this.bagSig) {
      return;
    }
    this.bagSig = sig;
    this.bagEl.innerHTML = entries
      .map(
        (e) =>
          `<div class="chip bs-glass"><i class="sw" style="background:${hexColor(e.def.color)};` +
          `color:${hexColor(e.def.color)}"></i>` +
          `<span class="nm">${escapeHtml(itemName(e.def, e.count))}</span>` +
          `<span class="n">${e.count}</span></div>`,
      )
      .join("");
    if (entries.length) {
      this.bagEl.classList.remove("bs-pop");
      void this.bagEl.offsetWidth;
      this.bagEl.classList.add("bs-pop");
    }
  }

  /**
   * The orb `Q` would throw, or null for none readied. On the HUD, not the
   * panel: the decision is made mid-fight. Call on CHANGE only.
   */
  setOrb(orb: { name: string; count: number; color: number; tier: number } | null): void {
    const sig = orb ? `${orb.name}:${orb.count}:${orb.color}:${orb.tier}` : "";
    if (sig === this.orbSig) {
      return;
    }
    this.orbSig = sig;
    if (!orb) {
      this.orbEl.innerHTML = "";
      return;
    }
    this.orbEl.innerHTML =
      `<div class="chip bs-glass" style="--el:${hexColor(orb.color)}">` +
      `<i class="oi">${tameOrbIcon(orb.tier)}</i>` +
      `<span class="nm">${escapeHtml(orb.name)}</span>` +
      `<span class="n">${orb.count}</span>` +
      // `kbd` builds the element itself, so it goes in raw.
      `<span class="k">${kbd("Q")}</span></div>`;
    this.orbEl.classList.remove("bs-pop");
    void this.orbEl.offsetWidth;
    this.orbEl.classList.add("bs-pop");
  }

  /**
   * Quests tracked in the journal (issue #98). Call on CHANGE only. Rows arrive
   * resolved, so `relabel` only invalidates the guard and the host re-pushes.
   */
  setQuests(rows: readonly QuestTrackRow[]): void {
    const sig = rows
      .map(
        (q) =>
          `${q.id}:${q.category}:${q.name}:${q.steps.map((s) => `${s.text}|${s.have}/${s.need}`).join(";")}`,
      )
      .join("~");
    if (sig === this.questSig) {
      return;
    }
    this.questSig = sig;
    this.questsEl.innerHTML = rows
      .map(
        (q) =>
          `<div class="q c-${q.category}">` +
          `<div class="qt-n"><i></i>${escapeHtml(q.name)}</div>` +
          (q.steps.length
            ? `<div class="qt-s">${q.steps
                .map((s) => {
                  const done = s.have >= s.need;
                  return (
                    `<span class="${done ? "ok" : ""}">${escapeHtml(s.text)}` +
                    (s.need > 1 ? ` <b>${s.have}/${s.need}</b>` : "") +
                    "</span>"
                  );
                })
                .join("")}</div>`
            : "") +
          "</div>",
      )
      .join("");
  }

  /** Built once; after boot the only per-frame write is one parent transform. */
  private buildCompassTape(): HTMLDivElement {
    const tape = div("tape");
    const NAMES = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    let html = "";
    for (let d = 0; d <= BS_TAPE_DEG; d += BS_TICK_STEP) {
      const x = (d * BS_PX_PER_DEG).toFixed(1);
      const a = d % 360;
      if (a % 45 === 0) {
        const name = NAMES[(a / 45) | 0];
        const card = a % 90 === 0;
        html +=
          `<i class="t maj" style="left:${x}px"></i>` +
          `<span class="lb ${card ? "card" : "ord"}" style="left:${x}px">${name}</span>`;
      } else {
        html += `<i class="t" style="left:${x}px"></i>`;
      }
    }
    tape.innerHTML = html;
    tape.style.width = `${BS_TAPE_DEG * BS_PX_PER_DEG}px`;
    return tape;
  }

  private measureCompass(): void {
    this.compassW = this.compassWinEl.clientWidth;
    // Force the next setCompass through the change guards at the new width.
    this.lastTapeX = NaN;
    for (const r of this.markers) {
      r.lastPx = NaN;
      r.lastEdge = 2;
    }
  }

  /** Replace the whole marker set — a zone change, not a per-frame call. */
  setCompassMarkers(list: CompassMarker[]): void {
    this.compassMarksEl.innerHTML = "";
    this.markers.length = 0;
    this.markerIdx.clear();
    for (const m of list) {
      this.addCompassMarker(m);
    }
  }

  addCompassMarker(m: CompassMarker): void {
    let refs = this.markerIdx.get(m.id);
    if (!refs) {
      refs = { m, el: div("mk"), lastPx: NaN, lastEdge: 2, rel: 0 };
      this.compassMarksEl.appendChild(refs.el);
      this.markers.push(refs);
      this.markerIdx.set(m.id, refs);
    }
    refs.m = m;
    refs.lastPx = NaN;
    refs.el.style.setProperty("--mc", hexColor(m.color));
    refs.el.textContent = m.label ?? "";
  }

  removeCompassMarker(id: string): void {
    const refs = this.markerIdx.get(id);
    if (!refs) {
      return;
    }
    refs.el.remove();
    this.markerIdx.delete(id);
    this.markers.splice(this.markers.indexOf(refs), 1);
  }

  /**
   * `headingDeg` is compass bearing (0 = north = -Z, 90 = +X) from the CAMERA's
   * forward; `originX/originZ` is the HERO, since the camera trails him and a
   * nearby marker would swing off that. Writes guarded on 0.1 px of movement.
   */
  setCompass(headingDeg: number, originX: number, originZ: number): void {
    if (this.compassW <= 0) {
      return;
    } // hidden (phone, hud=0)
    let h = headingDeg % 360;
    if (h < 0) {
      h += 360;
    }
    this.compassHeading = h;

    const half = this.compassW * 0.5;
    // Draw from the MIDDLE copy of the circle: h + 360.
    const tx = Math.round((half - (h + 360) * BS_PX_PER_DEG) * 10) / 10;
    if (tx !== this.lastTapeX) {
      this.lastTapeX = tx;
      this.compassTapeEl.style.transform = `translate3d(${tx}px,0,0)`;
    }

    const limit = half - BS_EDGE_PAD;
    for (let i = 0; i < this.markers.length; i++) {
      const r = this.markers[i];
      // Shortest-arc bearing relative to the view, in (-180, 180].
      let rel = Math.atan2(r.m.x - originX, -(r.m.z - originZ)) * BS_RAD2DEG - h;
      rel = ((rel + 540) % 360) - 180;
      r.rel = rel;
      let px = rel * BS_PX_PER_DEG;
      let edge = 0;
      if (px < -limit) {
        px = -limit;
        edge = -1;
      } else if (px > limit) {
        px = limit;
        edge = 1;
      }
      px = Math.round(px * 10) / 10;
      if (px !== r.lastPx) {
        r.lastPx = px;
        // Two translateX, not a calc(): -50% must resolve against chip width.
        r.el.style.transform = `translateX(${px}px) translateX(-50%)`;
      }
      if (edge !== r.lastEdge) {
        r.lastEdge = edge;
        r.el.classList.toggle("edge", edge !== 0);
        r.el.classList.toggle("l", edge < 0);
        r.el.classList.toggle("r", edge > 0);
      }
    }
  }

  /** Snapshot for __dbgCompass. Allocates; not per frame. */
  compassDebug(): unknown {
    return {
      heading: +this.compassHeading.toFixed(2),
      cardinal: ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][
        Math.round(this.compassHeading / 45) % 8
      ],
      width: this.compassW,
      spanDeg: +(this.compassW / BS_PX_PER_DEG).toFixed(1),
      tapeX: this.lastTapeX,
      markers: this.markers.map((r) => ({
        id: r.m.id,
        rel: +r.rel.toFixed(2),
        px: r.lastPx,
        clamped: r.lastEdge !== 0,
        side: r.lastEdge === -1 ? "left" : r.lastEdge === 1 ? "right" : "on",
      })),
    };
  }

  /** `nameKey`, not `beastId`: a name title-cased from an id cannot translate. */
  private showLevelUp(nameKey: StringKey, level: number, learned?: SkillDef): void {
    const name = escapeHtml(t(nameKey));
    const txt = this.bannerEl.querySelector(".txt") as HTMLElement;
    if (learned) {
      const el = ELEMENT_COLORS[learned.element];
      this.bannerEl.style.setProperty("--el", hexColor(el));
      this.bannerEl.style.boxShadow = `0 0 34px ${rgba(el, 0.35)}, 0 10px 30px rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.1)`;
      // Skill name arrives pre-wrapped, so the table places it in the sentence.
      txt.innerHTML = t("hud.levelUpLearned", {
        beast: name,
        level,
        skill: `<em>${escapeHtml(t(learned.nameKey))}</em>`,
      });
    } else {
      this.bannerEl.style.setProperty("--el", "#ffd23f");
      this.bannerEl.style.boxShadow =
        "0 0 34px rgba(255,210,63,.3), 0 10px 30px rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.1)";
      txt.innerHTML = t("hud.levelUpReached", { beast: name, level });
    }
    this.bannerEl.classList.remove("show");
    void this.bannerEl.offsetWidth;
    this.bannerEl.classList.add("show");
    this.bannerTimer = 4;
  }

  private addToast(text: string): void {
    const el = div("bs-toast");
    el.textContent = text;
    this.toastWrap.appendChild(el);
    requestAnimationFrame(() => el.classList.add("show"));
    this.toasts.push({ el, t: 3.2, hiding: false });
    // Cap the stack: two panels swallow a quarter of a phone screen.
    const phone = window.innerWidth <= 620 || window.innerHeight <= 460;
    const maxStack = phone ? 1 : 4;
    while (this.toasts.length > maxStack) {
      const old = this.toasts.shift();
      old?.el.remove();
    }
  }

  /** `html` comes from the caller with key caps already wrapped by `kbd()`. */
  showHint(html: string): void {
    if (html !== this.hintText) {
      this.hintText = html;
      this.hintEl.innerHTML = html;
    }
    this.hintEl.classList.add("show");
  }

  hideHint(): void {
    this.hintEl.classList.remove("show");
  }

  /**
   * Not a modal — walking away ends it. `speaker`/`line` go in as `textContent`
   * so neither can be markup; `footHtml` carries a key cap. Called every slice.
   */
  showDialogue(speaker: string, line: string, footHtml: string): void {
    if (speaker !== this.dialogueWho) {
      this.dialogueWho = speaker;
      this.dialogueWhoEl.textContent = speaker;
    }
    if (line !== this.dialogueLine) {
      this.dialogueLine = line;
      this.dialogueLineEl.textContent = line;
    }
    if (footHtml !== this.dialogueFoot) {
      this.dialogueFoot = footHtml;
      this.dialogueFootEl.innerHTML = footHtml;
    }
    this.dialogueEl.classList.add("show");
  }

  /** Exit-to-title. Only the transient bits: readouts redraw next frame. */
  reset(): void {
    for (const toast of this.toasts) {
      toast.el.remove();
    }
    this.toasts.length = 0;
    this.hideHint();
    this.hintText = "";
    this.hideDialogue();
    // Written on CHANGE, so a quest-free session would inherit the old list.
    this.questSig = "";
    this.questsEl.innerHTML = "";
  }

  hideDialogue(): void {
    this.dialogueEl.classList.remove("show");
  }

  /** 0..1, every frame; guarded on whole degrees of sweep. */
  setMountHold(progress: number): void {
    const deg = Math.round(clamp01(progress) * 360);
    if (deg === this.mountDeg) {
      return;
    }
    const was = this.mountDeg;
    this.mountDeg = deg;
    this.mountRingEl.style.background = `conic-gradient(#8ef0ff ${deg}deg, rgba(255,255,255,.16) ${deg}deg)`;
    if (deg > 0 !== was > 0) {
      this.mountHoldEl.classList.toggle("show", deg > 0);
    }
    // Full ring: one pop, on the frame the hold completes.
    if (deg >= 360 && was < 360) {
      this.mountHoldEl.classList.remove("bs-pop");
      void this.mountHoldEl.offsetWidth;
      this.mountHoldEl.classList.add("bs-pop");
    }
  }

  /**
   * Pad faces instead of key caps, or `null` to go back. Returns whether it
   * changed: main.ts re-derives its composed hint strings on the same edge.
   */
  setPadPrompts(glyphs: PadGlyphs | null): boolean {
    if (glyphs === this.padGlyphSet) {
      return false;
    }
    this.padGlyphSet = glyphs;
    this.prompts = glyphs ? padPrompts(glyphs) : KBM_PROMPTS;

    const lbl = this.mountHoldEl.querySelector(".lbl");
    if (lbl) {
      lbl.innerHTML = t("hud.mountHold", { key: this.prompts.mount });
    }

    this.menuBtnCapEl.innerHTML = this.prompts.menu;

    for (let i = 0; i < this.slotRefs.length; i++) {
      const key = this.slotRefs[i].el.querySelector(".key");
      if (key) {
        key.textContent = this.prompts.slot(i);
      }
    }

    // Force the riding badge to rebuild; it early-returns on unchanged text.
    this.ridingText = "";
    this.ridingBeast = null;

    // The footer is composed at open time, so replace it under an open shop.
    const foot = this.shopWrap.querySelector(".bs-shop-foot");
    if (foot) {
      foot.innerHTML = shopFootHints(this.prompts);
    }

    // Reachable: picking up a pad while reading the sheet swaps its faces live.
    if (this.controlsOpen) {
      this.buildControls();
    }
    return true;
  }

  get interactPrompt(): string {
    return this.prompts.interact;
  }

  /**
   * Re-derive strings baked into markup at construction, after a language
   * change. Wire to `onLanguageChange`; never per frame. A live toast keeps its
   * words.
   */
  relabel(): void {
    const hpLbl = this.root.querySelector(".bs-hp .lbl");
    if (hpLbl) {
      hpLbl.textContent = t("hud.hp");
    }

    const eyebrow = this.bannerEl.querySelector(".eyebrow");
    if (eyebrow) {
      eyebrow.textContent = t("hud.levelUp");
    }

    const mountLbl = this.mountHoldEl.querySelector(".lbl");
    if (mountLbl) {
      mountLbl.innerHTML = t("hud.mountHold", { key: this.prompts.mount });
    }

    // A key name does not translate, so only the a11y label and tooltip.
    this.menuBtnEl.setAttribute("aria-label", t("hud.menu"));
    this.menuBtnEl.title = t("hud.menu");

    // Direct: the count guard only fires when the plural FORM flips.
    this.shardLblEl.textContent = itemName(CURRENCY, Math.max(0, this.shardsDisplayed));

    // Subject unchanged, text not. The quest rows are the host's to re-push.
    this.bagSig = "";
    this.questSig = "";
    for (const refs of this.slotRefs) {
      refs.skillId = "";
    }
    this.ridingText = "";
    this.ridingBeast = null;

    // Footer only: rebuilding the cards could interrupt a half-made purchase.
    const foot = this.shopWrap.querySelector(".bs-shop-foot");
    if (foot) {
      foot.innerHTML = shopFootHints(this.prompts);
    }

    // The sheet has no such state, so rebuild it whole.
    if (this.controlsOpen) {
      this.buildControls();
    }
  }

  /** `mode` is what they are DOING: a water beast ashore gets the ground badge. */
  setMounted(beastName: string | null, mode: RideMode): void {
    if (beastName === this.ridingBeast && mode === this.ridingMode) {
      return;
    }
    this.ridingBeast = beastName;
    this.ridingMode = mode;
    // Caps go in pre-wrapped so a translation can reorder the sentence.
    const text = beastName
      ? t(
          mode === "flying"
            ? "hud.ridingFlying"
            : mode === "swimming"
              ? "hud.ridingSwimming"
              : "hud.riding",
          {
            beast: escapeHtml(beastName.toUpperCase()),
            altitude: this.prompts.altitude,
            dismount: this.prompts.dismount,
          },
        )
      : "";
    if (text === this.ridingText) {
      return;
    }
    this.ridingText = text;
    if (!beastName) {
      this.ridingEl.classList.remove("show");
      return;
    }
    this.ridingEl.innerHTML = text;
    this.ridingEl.classList.add("show");
  }

  /** F1 only. main.ts treats an open sheet as a modal. */
  toggleControls(): void {
    if (this.controlsOpen) {
      this.closeControls();
    } else {
      this.openControls();
    }
  }

  openControls(): void {
    if (this.controlsOpen) {
      return;
    }
    this.controlsOpen = true;
    this.buildControls();
    this.root.classList.add("keys-open");
    // One frame so the open transition plays.
    requestAnimationFrame(() => {
      if (this.controlsOpen) {
        this.keysWrap.classList.add("open");
      }
    });
  }

  closeControls(): void {
    if (!this.controlsOpen) {
      return;
    }
    this.controlsOpen = false;
    this.keysWrap.classList.remove("open");
    this.root.classList.remove("keys-open");
    // Markup stays so the panel can fade out; the next open rebuilds it.
  }

  isControlsOpen(): boolean {
    return this.controlsOpen;
  }

  private buildControls(): void {
    this.keysWrap.innerHTML = "";

    const scrim = div("bs-scrim");
    scrim.addEventListener("click", () => this.closeControls());
    this.keysWrap.appendChild(scrim);

    const panel = div("bs-keys bs-glass");
    const head = div("bs-keys-head", `<h2>${escapeHtml(t("keys.title"))}</h2>`);
    const closeBtn = document.createElement("button");
    closeBtn.className = "bs-shop-x";
    closeBtn.innerHTML = CLOSE_ICON;
    closeBtn.addEventListener("click", () => this.closeControls());
    head.appendChild(closeBtn);
    panel.appendChild(head);

    panel.appendChild(div("bs-keys-body", controlsHtml(this.padGlyphSet)));
    panel.appendChild(div("bs-keys-foot", t("keys.foot", { key: kbd("F1"), esc: kbd("Esc") })));
    this.keysWrap.appendChild(panel);
  }

  openShop(
    title: string,
    offers: ShopOffer[],
    onBuy: (index: number) => void,
    onClose: () => void,
  ): void {
    this.shopOnClose = onClose;
    this.shopWrap.innerHTML = "";

    const scrim = div("bs-scrim");
    scrim.addEventListener("click", () => this.requestShopClose());
    this.shopWrap.appendChild(scrim);

    const panel = div("bs-shop bs-glass");

    const head = div("bs-shop-head");
    head.innerHTML =
      `<h2>${escapeHtml(title)}</h2>` +
      `<div class="bal"><span class="ic">${SHARD_ICON}</span><b>${Math.round(this.shardsTarget)}</b></div>`;
    this.shopBalEl = head.querySelector(".bal b") as HTMLElement;
    const closeBtn = document.createElement("button");
    closeBtn.className = "bs-shop-x";
    closeBtn.innerHTML = CLOSE_ICON;
    closeBtn.addEventListener("click", () => this.requestShopClose());
    head.appendChild(closeBtn);
    panel.appendChild(head);

    const grid = div("bs-offers");
    offers.forEach((offer, i) => {
      // Both kinds share frame, price foot and button; only the top branches.
      const el = offer.kind === "skill" ? ELEMENT_COLORS[offer.skill.element] : offer.color;
      const bought = offer.kind === "skill" && offer.owned;
      const card = div(`bs-offer${bought ? "" : offer.affordable ? "" : " locked"}`);
      card.style.setProperty("--el", hexColor(el));
      card.style.setProperty("--el2", rgba(el, 0.4));
      const offerHead =
        offer.kind === "skill"
          ? `<div class="top"><span class="oic" style="--el2:${rgba(el, 0.18)}">` +
            `${elementIcon(offer.skill.element)}</span>` +
            `<div><h3>${escapeHtml(t(offer.skill.nameKey))}</h3>` +
            `<div class="beast">${escapeHtml(t("shop.forBeast", { beast: offer.beastName }))}</div>` +
            `</div></div>` +
            `<p>${escapeHtml(t(offer.skill.descriptionKey))}</p>` +
            `<div class="bs-chips">` +
            `<span class="bs-chip">${escapeHtml(t("shop.stat.power"))} <b>${offer.skill.power}</b></span>` +
            `<span class="bs-chip">${escapeHtml(t("shop.stat.cooldown"))} <b>${offer.skill.cooldown}s</b></span>` +
            `<span class="bs-chip">${escapeHtml(offer.skill.targeting.toUpperCase())}</span>` +
            `</div>`
          : `<div class="top"><span class="oic" style="--el2:${rgba(el, 0.18)}">` +
            `${offer.orbTier !== undefined ? tameOrbIcon(offer.orbTier) : SHARD_ICON}</span>` +
            `<div><h3>${escapeHtml(offer.name)}</h3></div></div>` +
            `<p>${escapeHtml(offer.description)}</p>` +
            `<div class="bs-chips">` +
            `<span class="bs-chip">${escapeHtml(t("shop.stat.held"))} <b>${offer.held}</b></span>` +
            `</div>`;
      card.innerHTML =
        `<div class="accent" style="background:linear-gradient(90deg,${hexColor(el)},${rgba(el, 0.25)})"></div>` +
        offerHead +
        `<div class="foot"></div>`;
      const foot = card.querySelector(".foot") as HTMLElement;

      if (bought) {
        const owned = div(
          "bs-buy owned",
          `${CHECK_ICON}<span>${escapeHtml(t("shop.learned"))}</span>`,
        );
        foot.appendChild(owned);
      } else {
        const price = div(
          `bs-price${offer.affordable ? "" : " no"}`,
          `<span class="ic">${SHARD_ICON}</span><span>${offer.price}</span>`,
        );
        foot.appendChild(price);
        const btn = document.createElement("button");
        btn.className = "bs-buy";
        btn.textContent = t("shop.buy");
        btn.disabled = !offer.affordable;
        btn.addEventListener("click", () => onBuy(i));
        foot.appendChild(btn);
      }
      grid.appendChild(card);
    });
    panel.appendChild(grid);

    panel.appendChild(div("bs-shop-foot", shopFootHints(this.prompts)));
    this.shopWrap.appendChild(panel);

    if (!this.shopOpen) {
      this.shopOpen = true;
      this.root.classList.add("shop-open");
      requestAnimationFrame(() => {
        if (this.shopOpen) {
          this.shopWrap.classList.add("open");
        }
      });
    } else {
      this.shopWrap.classList.add("open");
    }
  }

  closeShop(): void {
    if (!this.shopOpen) {
      return;
    }
    this.shopOpen = false;
    this.shopOnClose = null;
    this.shopBalEl = null;
    this.shopWrap.classList.remove("open");
    this.root.classList.remove("shop-open");
  }

  isShopOpen(): boolean {
    return this.shopOpen;
  }

  /** Esc / X / scrim: close visuals, then notify the game. */
  private requestShopClose(): void {
    if (!this.shopOpen) {
      return;
    }
    const cb = this.shopOnClose;
    this.closeShop();
    cb?.();
  }

  update(dt: number): void {
    // damage-lag ghost bar
    if (this.ghostFrac > this.hpFrac) {
      if (this.ghostDelay > 0) {
        this.ghostDelay -= dt;
      } else {
        const gap = this.ghostFrac - this.hpFrac;
        this.ghostFrac = Math.max(this.hpFrac, this.ghostFrac - dt * (0.25 + gap * 2.4));
      }
    }
    const gPct = Math.round(this.ghostFrac * 1000) / 10;
    if (gPct !== this.lastGhostPct) {
      this.lastGhostPct = gPct;
      this.hpGhostEl.style.width = `${gPct}%`;
    }

    // shard count-up
    if (this.shardsShown !== this.shardsTarget) {
      const diff = this.shardsTarget - this.shardsShown;
      this.shardsShown += diff * Math.min(1, dt * 9);
      if (Math.abs(this.shardsTarget - this.shardsShown) < 0.5) {
        this.shardsShown = this.shardsTarget;
      }
    }
    const shown = Math.round(this.shardsShown);
    if (shown !== this.shardsDisplayed) {
      const wasPlural = this.shardsDisplayed !== 1;
      this.shardsDisplayed = shown;
      this.shardNumEl.textContent = String(shown);
      // Only when the plural form flips, not on every tick of a count-up.
      if ((shown !== 1) !== wasPlural) {
        this.shardLblEl.textContent = itemName(CURRENCY, shown);
      }
      if (this.shopBalEl) {
        this.shopBalEl.textContent = String(shown);
      }
    }

    // banner auto-hide
    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) {
        this.bannerEl.classList.remove("show");
      }
    }

    // toast lifetimes
    for (let i = this.toasts.length - 1; i >= 0; i--) {
      const toast = this.toasts[i];
      toast.t -= dt;
      if (toast.t <= 0) {
        toast.el.remove();
        this.toasts.splice(i, 1);
      } else if (toast.t < 0.35 && !toast.hiding) {
        toast.hiding = true;
        toast.el.classList.add("hide");
      }
    }
  }
}
