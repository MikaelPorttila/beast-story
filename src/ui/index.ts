import type { ElementType, EventBus, Locomotion, SkillDef } from '../core/types';
import { ELEMENT_COLORS } from '../core/types';
import { CURRENCY, itemName, type BagEntry } from '../core/items';
import { t, type StringKey } from '../i18n';
import { PAD_GLYPHS, type PadGlyphs } from '../core/gamepad';
import { CONTROL_SECTIONS } from './keybinds';
import { injectStyles } from './styles';
import {
  elementIcon, locomotionIcon, tameOrbIcon,
  SHARD_ICON, CHECK_ICON, CLOSE_ICON, BURGER_ICON,
} from './icons';

// ---------------------------------------------------------------------------
// Public data shapes (consumed by main.ts)
// ---------------------------------------------------------------------------
export interface BeastHudInfo {
  name: string;
  element: ElementType;
  /**
   * WHERE it can go. Beside `element` rather than derived from it, because the
   * two are genuinely independent — Aquaxol is water AND amphibious, Snapclaw
   * is rock and amphibious — and the card draws a glyph for each.
   */
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

/**
 * A world-anchored marker on the compass strip.
 *
 * Everything a caller has to provide is here, and adding one is a one-liner:
 *
 *     hud.addCompassMarker({ id: 'town', x: 118, z: -46, color: 0xffd23f, label: 'TOWN' });
 *
 * `id` is the identity — re-adding the same id moves and restyles the existing
 * chip rather than duplicating it, which is also how a marker on something that
 * moves is kept up to date (call it again with a new x/z; it is one style write,
 * not a DOM rebuild). `removeCompassMarker(id)` takes it away. Height is
 * deliberately not a field: a heading strip has no vertical axis to put it on.
 */
export interface CompassMarker {
  id: string;
  /** World position. Only the horizontal plane is read. */
  x: number;
  z: number;
  /** Chip fill, 0xRRGGBB. */
  color: number;
  /** Optional short tag inside the chip (~4 chars); omit for a plain square. */
  label?: string;
}

/**
 * One quest on the HUD tracker (issue #98). Every string is ALREADY RESOLVED —
 * see `HUD.setQuests`. `id` is here for the signature guard and for the probe;
 * nothing is drawn from it.
 */
export interface QuestTrackRow {
  id: string;
  name: string;
  category: 'main' | 'side';
  steps: readonly { text: string; have: number; need: number }[];
}

/**
 * WHAT A DEN SELLS. Two shapes, and the discriminant is what they are.
 *
 * It was a skill and only a skill until taming orbs went on sale. A den that
 * sold both through one flattened record would have had a `skill?` and an
 * `item?` and a card renderer opening with a test of which was set — so the
 * union states it once, and the renderer switches on `kind` rather than on
 * whether a field happens to be there.
 *
 * A SKILL OFFER IS PER BEAST and an ITEM OFFER IS NOT, which is the deeper
 * reason these cannot be one record: half of a skill card (which animal is
 * learning it, whether that animal already knows it) has no meaning on a
 * consumable, and an item's stack is bought over and over where a skill is
 * bought once.
 */
export type ShopOffer = SkillOffer | ItemOffer;

export interface SkillOffer {
  kind: 'skill';
  skill: SkillDef;
  price: number;
  owned: boolean;
  /**
   * WHICH beast this offer belongs to. The buy handler in main.ts used to find the
   * beast by matching `beastName`, which is a display string — under `?lang=sv` the
   * match failed and the purchase silently taught nobody anything. Identity is
   * an id; the name below is only ever printed.
   */
  beastId: string;
  /** Display name, already looked up. Rendered under the skill title. */
  beastName: string;
  affordable: boolean;
}

/**
 * A consumable on the shelf. Every string ALREADY RESOLVED, like `QuestTrackRow`
 * — a den has no business knowing what an `ItemDef` is or how a plural works.
 */
export interface ItemOffer {
  kind: 'item';
  /** Item id, for the buy handler. Round-tripped; the panel never parses it. */
  itemId: string;
  name: string;
  description: string;
  price: number;
  affordable: boolean;
  /** Card tint. The item's own colour. */
  color: number;
  /** Draws the orb glyph at this grade when set. See `tameOrbIcon`. */
  orbTier?: number;
  /** How many the player already carries. Shown so a restock is one glance. */
  held: number;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function hexColor(c: number): string {
  return '#' + c.toString(16).padStart(6, '0');
}
function rgba(c: number, a: number): string {
  return `rgba(${(c >> 16) & 255},${(c >> 8) & 255},${c & 255},${a})`;
}
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function div(className: string, html = ''): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  if (html) el.innerHTML = html;
  return el;
}
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * The `BEAST STORY v1.0` plate is a development affordance, not part of the game:
 * opt in with `?debug=1`. It used to be shown by default and suppressed for
 * captures, which made a version chip the loudest element of normal gameplay.
 * Read here rather than in main.ts so the HUD stays self-contained.
 */
function isDebugMode(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('debug') === '1';
  } catch {
    return false;
  }
}

/** Locked hotbar slot marker: a chunky closed padlock. */
const LOCK_ICON =
  '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
  '<path fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" ' +
  'd="M8.2 10.4V7.6a3.8 3.8 0 0 1 7.6 0v2.8"/>' +
  '<rect fill="currentColor" x="5.4" y="10.2" width="13.2" height="9.6" rx="2.2"/>' +
  '</svg>';

/** Markup for an unearned hotbar slot (padlock + small key hint). */
function lockedSlotHtml(index: number, p: Prompts): string {
  return `<span class="key">${p.slot(index)}</span><span class="lock">${LOCK_ICON}</span>`;
}

interface BeastCardRefs {
  card: HTMLDivElement;
  inner: HTMLDivElement;
  hpBar: HTMLElement;
  xpBar: HTMLElement;
  /** the XP track itself, hidden while a fresh beast has nothing to show */
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

/**
 * Compass strip scale. 3.4 px per degree puts ~123° across the 420px window at
 * 1280 wide: wide enough that the letter you are walking toward is on screen
 * well before you are pointed at it, tight enough that two cardinals are never
 * both under the pointer's half of the strip (at 2 px/deg it showed 210° and
 * read as a ruler rather than a heading).
 */
const BS_PX_PER_DEG = 3.4;
/** Tick every 15°, label every 45°. */
const BS_TICK_STEP = 15;
/**
 * The tape is three copies of the circle laid end to end and simply slid, so
 * there is no seam to hide and no element is ever rebuilt: any heading in
 * [0,360) is drawn from the middle copy with a full turn of runway either side.
 */
const BS_TAPE_DEG = 1080;
/** Clamped markers park this far inside the window, clear of the 16px mask fade. */
const BS_EDGE_PAD = 24;
const BS_RAD2DEG = 180 / Math.PI;

interface MarkerRefs {
  m: CompassMarker;
  el: HTMLDivElement;
  /** Last written px offset from centre; NaN forces the next write. */
  lastPx: number;
  /** -1 clamped left, 0 on strip, 1 clamped right; 2 = never written. */
  lastEdge: number;
  /** Signed bearing relative to the view, degrees. For __dbgCompass only. */
  rel: number;
}

interface ToastEntry {
  el: HTMLDivElement;
  t: number;
  hiding: boolean;
}

/**
 * `<kbd>` wrapper for a key name interpolated into a string-table entry.
 *
 * Exported because the hint pill's text is composed by the CALLER (main.ts owns
 * which key opens a skill den), and the markup has to travel INSIDE the
 * placeholder value — that is the whole mechanism that let the `/\bPress (\S+)/`
 * regex in showHint go away.
 */
export function kbd(key: string): string {
  return `<kbd>${key}</kbd>`;
}

/**
 * The same, for a CONTROLLER face. Styled rounder in styles.ts, because a pad
 * button is round and a keycap is not, and at a glance the shape is what tells
 * a player which device the HUD is talking about.
 *
 * A face is not always a face: `Start` and `Options` are WORDS printed beside a
 * button, and a circle sized for one character clips them. Past two characters
 * this hands out a pill instead — same border, same colour, still nothing like
 * a keycap. Two is the threshold rather than one because `RT`, `L3` and `LB`
 * all fit the circle, and they are most of the table.
 */
export function padKey(key: string): string {
  return `<kbd class="pad${key.length > 2 ? ' wide' : ''}">${key}</kbd>`;
}

/**
 * The key caps every prompt in the HUD prints, for one input device.
 *
 * A device is described in ONE place so that adding a third never means hunting
 * for the next hardcoded `kbd('F')`. There is no touch entry, deliberately: the
 * touch build hides the hotbar and the shop's hint row outright (see the
 * viewport query in styles.ts) rather than restating them, so there is nothing
 * for it to fill in.
 */
/**
 * What the riding badge is describing — which is what the pair are DOING, not
 * which species is under the saddle. See `setMounted`.
 */
export type RideMode = 'ground' | 'flying' | 'swimming';

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
  /** The cap on the HUD's menu button — `F10`, or the pad's Start/Options. */
  menu: string;
  /** What a hotbar slot badge shows for slot `i`. */
  slot(i: number): string;
}

const KBM_PROMPTS: Prompts = {
  move: kbd('WASD'),
  jump: kbd('Space'),
  attack: kbd('LMB'),
  skills: `${kbd('1')}–${kbd('4')}`,
  swap: kbd('Tab'),
  interact: kbd('E'),
  altitude: `${kbd('Space')}/${kbd('C')}`,
  mount: kbd('F'),
  dismount: kbd('F'),
  menu: kbd('F10'),
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

/**
 * The shop's footer hints, for the device in use.
 *
 * This was a module-level constant built once at load, which was correct while
 * the keyboard was the only thing it could describe. It is a function now
 * because a pad may connect at any point in a session — but it is still only
 * called when the shop OPENS, so the six lookups cost nothing per frame.
 *
 * Each hint is ONE table entry with a `{key}` placeholder rather than "key" +
 * " move" glued together, because a language that puts the verb first has
 * nowhere to stand in a concatenation.
 */
function shopFootHints(p: Prompts): string {
  return `<span>${t('shop.foot.move', { key: p.move })}</span>`
    + `<span>${t('shop.foot.jump', { key: p.jump })}</span>`
    + `<span>${t('shop.foot.attack', { key: p.attack })}</span>`
    + `<span>${t('shop.foot.skills', { key: p.skills })}</span>`
    + `<span>${t('shop.foot.swap', { key: p.swap })}</span>`
    + `<span>${t('shop.foot.interact', { key: p.interact })}</span>`;
}

/**
 * The F1 controls sheet, as markup.
 *
 * Composed when the panel OPENS and thrown away when it closes, exactly like
 * the shop's cards: thirty rows is nothing to build once, and a live panel would
 * be a fifth surface for `setPadPrompts` to keep in step. The table it walks is
 * src/ui/keybinds.ts — read the maintenance note there before adding a binding.
 *
 * `glyphs` is the pad the player is on, or null for nobody: an unrecognised or
 * absent controller gets the Xbox faces, the same fallback `detectGlyphs` uses,
 * because the sheet has to name SOME controller and that is both the commoner
 * pad and the layout the W3C standard mapping is named after.
 */
function controlsHtml(glyphs: PadGlyphs | null): string {
  const faces = PAD_GLYPHS[glyphs ?? 'xbox'];
  let html = '';
  for (const section of CONTROL_SECTIONS) {
    // The section heading IS the column header row — one line doing two jobs,
    // so the two device names stay directly over the columns they label however
    // the sections reflow.
    html += '<div class="bs-keys-sec">'
      + `<div class="bs-keyrow head"><span class="nm">${escapeHtml(t(section.title))}</span>`
      + `<span class="kbm">${escapeHtml(t('keys.col.kbm'))}</span>`
      + `<span class="pad">${escapeHtml(t('keys.col.pad'))}</span><span class="mode"></span></div>`;
    for (const b of section.rows) {
      const caps = b.caps.map(kbd).join(b.join ?? ' ');
      const pad = b.pad
        ? b.pad.map((a) => padKey(faces[a])).join('')
        : `<span class="none">${escapeHtml(t('keys.none'))}</span>`;
      const hold = b.mode === 'hold';
      html += '<div class="bs-keyrow">'
        + `<span class="nm">${escapeHtml(t(b.label))}`
        + (b.note ? `<em>${escapeHtml(t(b.note))}</em>` : '')
        + `</span><span class="kbm">${caps}</span><span class="pad">${pad}</span>`
        + `<span class="mode ${hold ? 'hold' : 'press'}">`
        + `${escapeHtml(t(hold ? 'keys.mode.hold' : 'keys.mode.press'))}</span></div>`;
    }
    html += '</div>';
  }
  return html;
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------
export class HUD {
  private root: HTMLDivElement;

  // player hp
  private hpFillEl: HTMLElement;
  private hpGhostEl: HTMLElement;
  private hpValEl: HTMLElement;
  private hpFrac = 1;
  private ghostFrac = 1;
  private ghostDelay = 0;
  private lastFillPct = -1;
  private lastGhostPct = -1;
  private lastHpText = '';

  // beasts
  private beastRefs: [BeastCardRefs, BeastCardRefs];
  private prevBeastNames: [string | null, string | null] = [null, null];

  // skills
  private slotRefs: SlotRefs[] = [];

  // currency (the 'shard' item — displayed as "Cubloons", see src/i18n)
  private shardNumEl: HTMLElement;
  private shardLblEl: HTMLElement;
  private shardPillEl: HTMLElement;
  private shopBalEl: HTMLElement | null = null;
  private shardsShown = 0;
  private shardsTarget = 0;
  private shardsDisplayed = -1;
  private shardsInit = false;

  // bag (stackable items)
  private bagEl: HTMLDivElement;
  private bagSig = '';
  private orbEl: HTMLDivElement;
  private orbSig = '';

  // tracked quests (issue #98) — filled from the journal; see setQuests
  private questsEl: HTMLDivElement;
  private questSig = '';

  // compass
  private compassWinEl: HTMLDivElement;
  private compassTapeEl: HTMLDivElement;
  private compassMarksEl: HTMLDivElement;
  private markers: MarkerRefs[] = [];
  private markerIdx = new Map<string, MarkerRefs>();
  /** Measured window width; the visible span is this / BS_PX_PER_DEG degrees. */
  private compassW = 0;
  private lastTapeX = NaN;
  private compassHeading = 0;

  // banner
  private bannerEl: HTMLDivElement;
  private bannerTimer = 0;

  // toasts
  private toastWrap: HTMLDivElement;
  private toasts: ToastEntry[] = [];

  // hint
  private hintEl: HTMLDivElement;
  private hintText = '';

  // dialogue
  private dialogueEl: HTMLDivElement;
  private dialogueWhoEl: HTMLElement;
  private dialogueLineEl: HTMLElement;
  private dialogueFootEl: HTMLElement;
  private dialogueWho = '';
  private dialogueLine = '';
  private dialogueFoot = '';

  /**
   * Which device's key caps every prompt prints. See `setPadPrompts`.
   *
   * A field rather than a lookup at each print site, and swapped only when the
   * device changes, so nothing here does per-frame string work.
   */
  private prompts: Prompts = KBM_PROMPTS;
  private padGlyphSet: PadGlyphs | null = null;

  // mounting
  private mountHoldEl: HTMLDivElement;
  private mountRingEl: HTMLElement;
  private ridingEl: HTMLDivElement;
  private mountDeg = -1;
  private ridingText = '';
  private ridingBeast: string | null = null;
  private ridingMode: RideMode = 'ground';

  // menu button (F10)
  private menuBtnEl: HTMLButtonElement;
  private menuBtnCapEl: HTMLElement;
  /**
   * Clicked. Wired by the composition root to the same virtual key every other
   * device taps — see where this is built.
   */
  onMenu: (() => void) | null = null;

  // controls sheet (F1)
  private keysWrap: HTMLDivElement;
  private controlsOpen = false;

  // shop
  private shopWrap: HTMLDivElement;
  private shopOpen = false;
  private shopOnClose: (() => void) | null = null;

  constructor(bus: EventBus) {
    injectStyles();

    this.root = div('bs-root');

    // title chip (dev plate; only with ?debug=1) ----------------------------
    if (isDebugMode()) {
      this.root.appendChild(div('bs-title bs-glass', '<b>BEAST STORY</b><span>v1.0</span>'));
    }

    // tracked quests ---------------------------------------------------------
    // Empty until the player has one and has left it switched on in the journal,
    // so a fresh save shows nothing — the bag's rule. Where it SITS is the
    // stylesheet's business: it stacks under the menu button, which itself
    // stacks under the debug plate, all three by one :has() rule.
    this.questsEl = div('bs-quests');
    this.root.appendChild(this.questsEl);

    // menu button ------------------------------------------------------------
    // THE MENU HAS TO BE VISIBLE, not only bound. It moved off Escape onto F10
    // (which the browser does not spend on fullscreen and pointer lock), and a
    // key nobody presses by accident is also a key nobody discovers by accident
    // — so the binding is printed on a button in the corner rather than left in
    // the F1 sheet for a player who does not yet know there is one.
    //
    // It TAPS THE KEY rather than calling the menu: `onMenu` is wired in main.ts
    // to `input.tapVirtual('F10')`, so this button, the pad's Start, the touch
    // overlay's MENU and the real key all arrive at the one reader in `frame()`.
    // A button that opened the menu directly would be a second opinion about
    // what "menu" means, and the first thing it would get wrong is the toggle.
    this.menuBtnEl = document.createElement('button');
    this.menuBtnEl.type = 'button';
    this.menuBtnEl.className = 'bs-menubtn bs-glass';
    this.menuBtnEl.innerHTML = `${BURGER_ICON}<span class="cap"></span>`;
    this.menuBtnCapEl = this.menuBtnEl.querySelector('.cap') as HTMLElement;
    this.menuBtnCapEl.innerHTML = this.prompts.menu;
    this.menuBtnEl.setAttribute('aria-label', t('hud.menu'));
    this.menuBtnEl.title = t('hud.menu');
    this.menuBtnEl.addEventListener('click', () => this.onMenu?.());
    this.root.appendChild(this.menuBtnEl);

    // currency counter -----------------------------------------------------
    // The NAME is on the pill, not just the icon: money the player cannot name
    // is money they cannot be told a price in. It is written from the string
    // table in update(), on the same change guard as the number, so the label
    // and the count can never disagree about singular vs plural.
    this.shardPillEl = div(
      'bs-shards bs-glass',
      `<span class="ic">${SHARD_ICON}</span><span class="num">0</span><span class="lbl"></span>`,
    );
    this.shardNumEl = this.shardPillEl.querySelector('.num') as HTMLElement;
    this.shardLblEl = this.shardPillEl.querySelector('.lbl') as HTMLElement;
    // Seeded in the plural form, which is what `shardsDisplayed = -1` claims is
    // on screen; update()'s guard only rewrites it when the form actually flips.
    this.shardLblEl.textContent = itemName(CURRENCY, 0);
    this.root.appendChild(this.shardPillEl);

    // bag (stackable items) — empty until something is picked up ------------
    this.bagEl = div('bs-bag');
    this.root.appendChild(this.bagEl);

    // readied taming orb — empty until one is readied in the panel ----------
    this.orbEl = div('bs-orb');
    this.root.appendChild(this.orbEl);

    // compass --------------------------------------------------------------
    const compass = div('bs-compass');
    this.compassWinEl = div('win');
    this.compassTapeEl = this.buildCompassTape();
    this.compassMarksEl = div('marks');
    this.compassWinEl.appendChild(this.compassTapeEl);
    this.compassWinEl.appendChild(this.compassMarksEl);
    compass.appendChild(this.compassWinEl);
    compass.appendChild(div('ptr'));
    this.root.appendChild(compass);

    // crosshair ------------------------------------------------------------
    this.root.appendChild(div('bs-cross'));

    // hold-to-mount ring, wrapped around the crosshair ----------------------
    // It belongs AT the reticle: the thing being held is a commitment made
    // where the player is already looking, and a bar in a corner of the screen
    // would be feedback for an action happening somewhere else.
    this.mountHoldEl = div(
      'bs-mounthold',
      `<div class="ring"></div><div class="lbl">${t('hud.mountHold', { key: this.prompts.mount })}</div>`,
    );
    this.mountRingEl = this.mountHoldEl.querySelector('.ring') as HTMLElement;
    this.root.appendChild(this.mountHoldEl);

    // "riding" badge, above the interact hint --------------------------------
    this.ridingEl = div('bs-riding bs-glass');
    this.root.appendChild(this.ridingEl);

    // left cluster: one panel holding the beast cards + player hp ----------
    const left = div('bs-left');
    const beasts = div('bs-beasts');
    this.beastRefs = [this.makeBeastCard(true), this.makeBeastCard(false)];
    beasts.appendChild(this.beastRefs[0].card);
    beasts.appendChild(this.beastRefs[1].card);
    left.appendChild(beasts);

    const hp = div(
      'bs-hp',
      `<div class="row"><span class="lbl">${escapeHtml(t('hud.hp'))}</span><span class="val"></span></div>` +
      '<div class="track"><div class="ghost"></div><div class="fill"></div></div>',
    );
    this.hpFillEl = hp.querySelector('.fill') as HTMLElement;
    this.hpGhostEl = hp.querySelector('.ghost') as HTMLElement;
    this.hpValEl = hp.querySelector('.val') as HTMLElement;
    left.appendChild(hp);
    this.root.appendChild(left);

    // hotbar ---------------------------------------------------------------
    const hotbar = div('bs-hotbar');
    for (let i = 0; i < 4; i++) {
      const slot = div('bs-slot empty', lockedSlotHtml(i, this.prompts));
      hotbar.appendChild(slot);
      this.slotRefs.push({
        el: slot,
        cd: slot,       // placeholder until filled
        cdNum: slot,    // placeholder until filled
        skillId: '',
        prevReady: false,
        lastSweepDeg: -1,
        lastCdText: '',
      });
    }
    this.root.appendChild(hotbar);

    // hint pill ------------------------------------------------------------
    this.hintEl = div('bs-hint bs-glass');
    this.root.appendChild(this.hintEl);

    // dialogue panel --------------------------------------------------------
    this.dialogueEl = div(
      'bs-dialogue bs-glass',
      '<div class="who"></div><div class="line"></div><div class="foot"></div>',
    );
    this.dialogueWhoEl = this.dialogueEl.querySelector('.who') as HTMLElement;
    this.dialogueLineEl = this.dialogueEl.querySelector('.line') as HTMLElement;
    this.dialogueFootEl = this.dialogueEl.querySelector('.foot') as HTMLElement;
    this.root.appendChild(this.dialogueEl);

    // level-up banner ------------------------------------------------------
    this.bannerEl = div(
      'bs-banner bs-glass',
      `<div class="eyebrow">${escapeHtml(t('hud.levelUp'))}</div><div class="txt"></div>`,
    );
    this.root.appendChild(this.bannerEl);

    // toasts ---------------------------------------------------------------
    this.toastWrap = div('bs-toasts');
    this.root.appendChild(this.toastWrap);

    // shop -----------------------------------------------------------------
    this.shopWrap = div('bs-shopwrap');
    this.root.appendChild(this.shopWrap);

    // controls sheet ---------------------------------------------------------
    // Last child of the root, so it draws over the shop: F1 can be pressed with
    // a den open, and the answer to "what closes this?" must not be underneath
    // the thing it is answering for.
    this.keysWrap = div('bs-keyswrap');
    // The controls sheet is where a player goes to find out what something
    // does, which is exactly what the question-mark cursor means. It is the one
    // honest home for `help` in this game — see ui/cursor.ts.
    this.keysWrap.setAttribute('data-cursor', 'help');
    this.root.appendChild(this.keysWrap);

    document.body.appendChild(this.root);
    // The strip's visible span is a measurement, not a constant: the width is
    // min(420px,44vw) and the phone breakpoint hides it entirely, so marker
    // clamping has to follow whatever the layout actually gave us.
    this.measureCompass();
    window.addEventListener('resize', () => this.measureCompass());

    // THERE IS NO ESCAPE LISTENER HERE, and its absence is load-bearing. The
    // shop used to add one on `document` while it was open, and it closed the
    // panel SYNCHRONOUSLY — so by the time the simulation slice read the same
    // press there was no modal left, the slice took its other branch, and one
    // key closed the den and opened the in-game menu behind it. That is the
    // hazard ui/pause.ts's `onKeyDown` names at length ("one press seen twice,
    // once by this listener and once by the host's slice"), which is why
    // neither the pause menu nor the inventory handles Escape in its own
    // markup either. The host owns that edge for every device: a keyboard's
    // Escape and F10, the pad's B and Start, the touch overlay's MENU button
    // and this HUD's own menu button all arrive as a virtual key in main.ts's
    // cancel branch, which closes the topmost thing. The X and the scrim are
    // still here, because those are clicks.

    this.setPlayerHp(100, 100);

    bus.on((e) => {
      if (e.type === 'toast') this.addToast(e.text);
      else if (e.type === 'shardsChanged') this.setShards(e.total);
      else if (e.type === 'beastLevelUp') this.showLevelUp(e.nameKey, e.level, e.learned);
    });
  }

  // -------------------------------------------------------------------------
  // Player HP
  // -------------------------------------------------------------------------
  setPlayerHp(hp: number, maxHp: number): void {
    const frac = maxHp > 0 ? clamp01(hp / maxHp) : 0;
    if (frac < this.hpFrac) this.ghostDelay = 0.35;       // took damage: ghost lingers
    if (frac > this.ghostFrac) this.ghostFrac = frac;     // healed: ghost snaps up
    this.hpFrac = frac;

    const pct = Math.round(frac * 1000) / 10;
    if (pct !== this.lastFillPct) {
      this.lastFillPct = pct;
      const hue = 8 + frac * 112; // red -> green
      this.hpFillEl.style.width = `${pct}%`;
      this.hpFillEl.style.background =
        `linear-gradient(90deg, hsl(${hue.toFixed(0)},82%,48%), hsl(${hue.toFixed(0)},85%,60%))`;
    }
    const text = `${Math.max(0, Math.ceil(hp))} / ${Math.ceil(maxHp)}`;
    if (text !== this.lastHpText) {
      this.lastHpText = text;
      this.hpValEl.textContent = text;
    }
  }

  // -------------------------------------------------------------------------
  // Beast cards
  // -------------------------------------------------------------------------
  private makeBeastCard(primary: boolean): BeastCardRefs {
    const card = div(`bs-beast hidden ${primary ? 'primary' : 'support'}`);
    const inner = div('bs-beast-in');
    card.appendChild(inner);
    return { card, inner, hpBar: inner, xpBar: inner, xpTrack: inner, sig: '' };
  }

  setBeasts(primary: BeastHudInfo | null, support: BeastHudInfo | null): void {
    const swapped =
      primary !== null && support !== null &&
      this.prevBeastNames[0] === support.name && this.prevBeastNames[1] === primary.name;
    this.renderBeast(this.beastRefs[0], primary, swapped);
    this.renderBeast(this.beastRefs[1], support, swapped);
    this.prevBeastNames[0] = primary?.name ?? null;
    this.prevBeastNames[1] = support?.name ?? null;
  }

  private renderBeast(refs: BeastCardRefs, info: BeastHudInfo | null, animateSwap: boolean): void {
    if (!info) {
      refs.card.classList.add('hidden');
      refs.sig = '';
      return;
    }
    refs.card.classList.remove('hidden');
    const sig = `${info.name}|${info.element}|${info.locomotion}|${info.level}`;
    if (sig !== refs.sig) {
      refs.sig = sig;
      const el = ELEMENT_COLORS[info.element];
      refs.card.style.setProperty('--el', hexColor(el));
      refs.inner.innerHTML =
        `<div class="badge">${elementIcon(info.element)}` +
        `<span class="loco">${locomotionIcon(info.locomotion)}</span></div>` +
        `<div class="meta">` +
        `<div class="row"><span class="nm">${escapeHtml(info.name)}</span>` +
        `<span class="lv">${escapeHtml(t('hud.level', { n: info.level }))}</span></div>` +
        `<div class="bs-micro hp"><i></i></div>` +
        `<div class="bs-micro xp"><i></i></div>` +
        `</div>`;
      refs.hpBar = refs.inner.querySelector('.bs-micro.hp > i') as HTMLElement;
      refs.xpBar = refs.inner.querySelector('.bs-micro.xp > i') as HTMLElement;
      refs.xpTrack = refs.inner.querySelector('.bs-micro.xp') as HTMLElement;
      if (animateSwap) {
        refs.inner.classList.remove('bs-swap');
        void refs.inner.offsetWidth; // restart animation
        refs.inner.classList.add('bs-swap');
      }
    }
    const hpPct = Math.round(clamp01(info.maxHp > 0 ? info.hp / info.maxHp : 0) * 1000) / 10;
    const xpPct = Math.round(clamp01(info.xpToNext > 0 ? info.xp / info.xpToNext : 0) * 1000) / 10;
    refs.hpBar.style.width = `${hpPct}%`;
    refs.xpBar.style.width = `${xpPct}%`;
    // A dead-empty XP bar under a Lv 1 beast reads as a broken widget, so the
    // track only appears once there is progress to show. Past level 1 it stays
    // put (an empty track there is meaningful) and the faint pre-filled track
    // styling in styles.ts keeps it from looking like a rendering failure.
    const showXp = info.xpToNext > 0 && (info.xp > 0 || info.level > 1);
    refs.xpTrack.style.display = showXp ? '' : 'none';
  }

  // -------------------------------------------------------------------------
  // Skill hotbar
  // -------------------------------------------------------------------------
  setSkills(slots: SkillSlot[]): void {
    for (let i = 0; i < this.slotRefs.length; i++) {
      const refs = this.slotRefs[i];
      const slot = i < slots.length ? slots[i] : undefined;
      if (!slot) {
        if (refs.skillId !== '') {
          refs.skillId = '';
          refs.el.className = 'bs-slot empty';
          refs.el.innerHTML = lockedSlotHtml(i, this.prompts);
          refs.el.removeAttribute('style');
          refs.prevReady = false;
          refs.lastSweepDeg = -1;
          refs.lastCdText = '';
        }
        continue;
      }

      const def = slot.def;
      if (refs.skillId !== def.id) {
        refs.skillId = def.id;
        const el = ELEMENT_COLORS[def.element];
        refs.el.className = 'bs-slot filled';
        refs.el.style.setProperty('--el', hexColor(el));
        refs.el.style.setProperty('--el2', rgba(el, 0.55));
        refs.el.style.background =
          `linear-gradient(165deg, ${rgba(el, 0.26)}, ${rgba(el, 0.08)}), ` +
          `linear-gradient(165deg, rgba(30,38,54,.72), rgba(14,18,28,.82))`;
        refs.el.innerHTML =
          `<span class="key">${this.prompts.slot(i)}</span>` +
          `<span class="ic">${elementIcon(def.element)}</span>` +
          `<span class="cd"></span><span class="cdnum"></span>` +
          `<span class="nm">${escapeHtml(t(def.nameKey))}</span>`;
        refs.cd = refs.el.querySelector('.cd') as HTMLElement;
        refs.cdNum = refs.el.querySelector('.cdnum') as HTMLElement;
        refs.prevReady = slot.ready;
        refs.lastSweepDeg = -1;
        refs.lastCdText = '';
      }

      // radial cooldown sweep
      const frac = def.cooldown > 0 ? clamp01(slot.cooldownRemaining / def.cooldown) : 0;
      const deg = Math.round(frac * 360);
      if (deg !== refs.lastSweepDeg) {
        refs.lastSweepDeg = deg;
        refs.cd.style.background = deg > 0
          ? `conic-gradient(rgba(8,11,18,.78) ${deg}deg, transparent ${deg}deg)`
          : 'none';
      }
      const cdText = slot.cooldownRemaining > 0.05
        ? (slot.cooldownRemaining >= 10
          ? String(Math.ceil(slot.cooldownRemaining))
          : slot.cooldownRemaining.toFixed(1))
        : '';
      if (cdText !== refs.lastCdText) {
        refs.lastCdText = cdText;
        refs.cdNum.textContent = cdText;
      }

      refs.el.classList.toggle('ready', slot.ready);
      refs.el.classList.toggle('cooling', !slot.ready);
      if (slot.ready && !refs.prevReady) {
        refs.el.classList.remove('bs-flash');
        void refs.el.offsetWidth;
        refs.el.classList.add('bs-flash');
      }
      refs.prevReady = slot.ready;
    }
  }

  // -------------------------------------------------------------------------
  // Shards
  // -------------------------------------------------------------------------
  setShards(n: number): void {
    this.shardsTarget = n;
    if (!this.shardsInit) {
      // first value: no count-up from zero on load
      this.shardsInit = true;
      this.shardsShown = n;
    } else if (n !== this.shardsDisplayed) {
      this.shardPillEl.classList.remove('bs-pop');
      void this.shardPillEl.offsetWidth;
      this.shardPillEl.classList.add('bs-pop');
    }
  }

  // -------------------------------------------------------------------------
  // Bag
  // -------------------------------------------------------------------------
  /**
   * Stackable items the player holds, one chip each. Call on CHANGE only — it
   * rebuilds the chips (the signature guard below makes a redundant call cheap,
   * but the caller still allocates the entry array to get here).
   *
   * This is also the readout for the support beast's fetch rule: a chip present
   * is exactly the condition under which the beast will fetch more of that item.
   */
  setBag(entries: BagEntry[]): void {
    const sig = entries.map((e) => `${e.def.id}:${e.count}`).join('|');
    if (sig === this.bagSig) return;
    this.bagSig = sig;
    this.bagEl.innerHTML = entries.map((e) =>
      `<div class="chip bs-glass"><i class="sw" style="background:${hexColor(e.def.color)};` +
      `color:${hexColor(e.def.color)}"></i>` +
      `<span class="nm">${escapeHtml(itemName(e.def, e.count))}</span>` +
      `<span class="n">${e.count}</span></div>`,
    ).join('');
    if (entries.length) {
      this.bagEl.classList.remove('bs-pop');
      void this.bagEl.offsetWidth;
      this.bagEl.classList.add('bs-pop');
    }
  }

  // -------------------------------------------------------------------------
  // Readied taming orb
  // -------------------------------------------------------------------------
  /**
   * The orb `Q` would throw, and how many are left — or null for none readied.
   *
   * ON SCREEN AND NOT IN THE PANEL, because the decision it supports is made in
   * a fight: an orb is thrown at a beast whose health bar the player is watching,
   * and "have I still got one" cannot be a question that costs them the modal.
   * It sits under the bag chips for the same reason those are there — the right
   * column is what you HAVE, and the left is what is happening to you.
   *
   * Call on CHANGE only. The signature guard makes a redundant call cheap, but
   * the caller resolved a plural name to get here.
   */
  setOrb(orb: { name: string; count: number; color: number; tier: number } | null): void {
    const sig = orb ? `${orb.name}:${orb.count}:${orb.color}:${orb.tier}` : '';
    if (sig === this.orbSig) return;
    this.orbSig = sig;
    if (!orb) { this.orbEl.innerHTML = ''; return; }
    this.orbEl.innerHTML =
      `<div class="chip bs-glass" style="--el:${hexColor(orb.color)}">` +
      `<i class="oi">${tameOrbIcon(orb.tier)}</i>` +
      `<span class="nm">${escapeHtml(orb.name)}</span>` +
      `<span class="n">${orb.count}</span>` +
      // `kbd` builds the element itself, so it goes in raw — see its own note.
      `<span class="k">${kbd('Q')}</span></div>`;
    this.orbEl.classList.remove('bs-pop');
    void this.orbEl.offsetWidth;
    this.orbEl.classList.add('bs-pop');
  }

  // -------------------------------------------------------------------------
  // Tracked quests
  // -------------------------------------------------------------------------
  /**
   * The quests the player left switched on in the journal (issue #98). Call on
   * CHANGE only — the signature guard below makes a redundant call cheap, but
   * the caller still resolves every string to get here.
   *
   * ROWS ARRIVE ALREADY RESOLVED, names and objective text both, because a
   * quest's words live in content rather than in the string table and this class
   * has no business knowing what a `ContentText` is. That is also why `relabel`
   * only INVALIDATES the guard: the host re-derives and pushes again.
   *
   * A DONE STEP IS STRUCK THROUGH RATHER THAN REMOVED. The list is short, and a
   * step that vanishes the moment it is finished takes its own completion off
   * the screen with it — the one frame the player wanted to see.
   */
  setQuests(rows: readonly QuestTrackRow[]): void {
    const sig = rows.map((q) =>
      `${q.id}:${q.category}:${q.name}:${q.steps.map((s) => `${s.text}|${s.have}/${s.need}`).join(';')}`,
    ).join('~');
    if (sig === this.questSig) return;
    this.questSig = sig;
    this.questsEl.innerHTML = rows.map((q) =>
      `<div class="q c-${q.category}">` +
        `<div class="qt-n"><i></i>${escapeHtml(q.name)}</div>` +
        (q.steps.length
          ? `<div class="qt-s">${q.steps.map((s) => {
              const done = s.have >= s.need;
              return `<span class="${done ? 'ok' : ''}">${escapeHtml(s.text)}` +
                (s.need > 1 ? ` <b>${s.have}/${s.need}</b>` : '') + '</span>';
            }).join('')}</div>`
          : '') +
      '</div>',
    ).join('');
  }

  // -------------------------------------------------------------------------
  // Compass
  // -------------------------------------------------------------------------
  /**
   * Ticks and letters, built once and never touched again. ~290 absolutely
   * positioned children sounds like a lot, but they are laid out once at boot
   * and after that the ONLY per-frame DOM work in the whole widget is one
   * transform on their parent — which is the entire point of a sliding tape.
   */
  private buildCompassTape(): HTMLDivElement {
    const tape = div('tape');
    const NAMES = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    let html = '';
    for (let d = 0; d <= BS_TAPE_DEG; d += BS_TICK_STEP) {
      const x = (d * BS_PX_PER_DEG).toFixed(1);
      const a = d % 360;
      if (a % 45 === 0) {
        const name = NAMES[(a / 45) | 0];
        const card = a % 90 === 0;
        html += `<i class="t maj" style="left:${x}px"></i>` +
          `<span class="lb ${card ? 'card' : 'ord'}" style="left:${x}px">${name}</span>`;
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
    for (const r of this.markers) { r.lastPx = NaN; r.lastEdge = 2; }
  }

  /** Replace the whole marker set — a zone change, not a per-frame call. */
  setCompassMarkers(list: CompassMarker[]): void {
    this.compassMarksEl.innerHTML = '';
    this.markers.length = 0;
    this.markerIdx.clear();
    for (const m of list) this.addCompassMarker(m);
  }

  /** Add or update one marker. See CompassMarker for what a caller supplies. */
  addCompassMarker(m: CompassMarker): void {
    let refs = this.markerIdx.get(m.id);
    if (!refs) {
      refs = { m, el: div('mk'), lastPx: NaN, lastEdge: 2, rel: 0 };
      this.compassMarksEl.appendChild(refs.el);
      this.markers.push(refs);
      this.markerIdx.set(m.id, refs);
    }
    refs.m = m;
    refs.lastPx = NaN;
    refs.el.style.setProperty('--mc', hexColor(m.color));
    refs.el.textContent = m.label ?? '';
  }

  removeCompassMarker(id: string): void {
    const refs = this.markerIdx.get(id);
    if (!refs) return;
    refs.el.remove();
    this.markerIdx.delete(id);
    this.markers.splice(this.markers.indexOf(refs), 1);
  }

  /**
   * Slide the strip to `headingDeg` and place every marker relative to it.
   * Called once per RENDERED frame from main.ts's presentation block.
   *
   * `headingDeg` is compass bearing — 0 = north = world -Z, 90 = east = +X —
   * and it comes from the CAMERA's forward vector, not the hero's facing: the
   * crosshair is pinned to the viewport centre, so what the lens points at is
   * what is under the pointer. `originX/originZ` is where marker bearings are
   * measured FROM, which is the hero (the camera trails him by a few units and
   * a marker you are standing next to would swing wildly off that).
   *
   * Every write is guarded on a tenth of a pixel of actual movement, so a
   * standing still frame touches the DOM zero times and a turning frame touches
   * it once for the tape plus once per marker that moved.
   */
  setCompass(headingDeg: number, originX: number, originZ: number): void {
    if (this.compassW <= 0) return;                       // hidden (phone, hud=0)
    let h = headingDeg % 360;
    if (h < 0) h += 360;
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
      if (px < -limit) { px = -limit; edge = -1; }
      else if (px > limit) { px = limit; edge = 1; }
      px = Math.round(px * 10) / 10;
      if (px !== r.lastPx) {
        r.lastPx = px;
        // translateX twice rather than a calc(): the -50% has to resolve
        // against the chip's own width, which changes with its label.
        r.el.style.transform = `translateX(${px}px) translateX(-50%)`;
      }
      if (edge !== r.lastEdge) {
        r.lastEdge = edge;
        r.el.classList.toggle('edge', edge !== 0);
        r.el.classList.toggle('l', edge < 0);
        r.el.classList.toggle('r', edge > 0);
      }
    }
  }

  /** Read-only snapshot for the __dbgCompass probe. Allocates; not per frame. */
  compassDebug(): unknown {
    return {
      heading: +this.compassHeading.toFixed(2),
      cardinal: ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][
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
        side: r.lastEdge === -1 ? 'left' : r.lastEdge === 1 ? 'right' : 'on',
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Level-up banner
  // -------------------------------------------------------------------------
  /**
   * `nameKey` rather than `beastId`: the banner used to title-case the identifier
   * ('emberfox' -> "Emberfox"), which happens to look right in English and is
   * wrong everywhere else — a name derived from an id can never be translated,
   * and would not follow a rename either. The event carries both halves now.
   */
  private showLevelUp(nameKey: StringKey, level: number, learned?: SkillDef): void {
    const name = escapeHtml(t(nameKey));
    const txt = this.bannerEl.querySelector('.txt') as HTMLElement;
    if (learned) {
      const el = ELEMENT_COLORS[learned.element];
      this.bannerEl.style.setProperty('--el', hexColor(el));
      this.bannerEl.style.boxShadow =
        `0 0 34px ${rgba(el, 0.35)}, 0 10px 30px rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.1)`;
      // The skill name arrives already wrapped, so the TABLE decides where in
      // the sentence it lands — the emphasis travels with it.
      txt.innerHTML = t('hud.levelUpLearned', {
        beast: name, level, skill: `<em>${escapeHtml(t(learned.nameKey))}</em>`,
      });
    } else {
      this.bannerEl.style.setProperty('--el', '#ffd23f');
      this.bannerEl.style.boxShadow =
        '0 0 34px rgba(255,210,63,.3), 0 10px 30px rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.1)';
      txt.innerHTML = t('hud.levelUpReached', { beast: name, level });
    }
    this.bannerEl.classList.remove('show');
    void this.bannerEl.offsetWidth;
    this.bannerEl.classList.add('show');
    this.bannerTimer = 4;
  }

  // -------------------------------------------------------------------------
  // Toasts
  // -------------------------------------------------------------------------
  private addToast(text: string): void {
    const el = div('bs-toast');
    el.textContent = text;
    this.toastWrap.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    this.toasts.push({ el, t: 3.2, hiding: false });
    // Cap the stack. On a phone two stacked instruction panels swallowed a
    // quarter of the screen, so there only the newest toast survives; the 3.2s
    // lifetime in update() then clears it without any input.
    const phone = window.innerWidth <= 620 || window.innerHeight <= 460;
    const maxStack = phone ? 1 : 4;
    while (this.toasts.length > maxStack) {
      const old = this.toasts.shift();
      old?.el.remove();
    }
  }

  // -------------------------------------------------------------------------
  // Hint
  // -------------------------------------------------------------------------
  /**
   * The interact / gateway pill. `html` is composed by the caller out of the
   * string table, with any key cap already wrapped by `kbd()` — the same shape
   * the riding badge and the shop footer use.
   *
   * It used to take plain text and go hunting for the key with
   * `/\bPress (\S+)/`, which is a rule about ENGLISH grammar living in the HUD:
   * it found nothing in "Tryck på E" and produced an unstyled letter, and it
   * would have matched the wrong word in any sentence that happened to contain
   * "press". A placeholder carrying the markup as a VALUE lets the translation
   * put the key wherever its own grammar wants it, so the regex is gone.
   *
   * Still guarded on change, so a held-still frame near a den writes nothing.
   */
  showHint(html: string): void {
    if (html !== this.hintText) {
      this.hintText = html;
      this.hintEl.innerHTML = html;
    }
    this.hintEl.classList.add('show');
  }

  hideHint(): void {
    this.hintEl.classList.remove('show');
  }

  // -------------------------------------------------------------------------
  // Dialogue
  // -------------------------------------------------------------------------
  /**
   * What an NPC is saying. Not a modal — the world keeps running behind it and
   * the player can walk away mid-sentence, which is what ends it.
   *
   * `speaker` and `line` are PLAIN TEXT out of the string table and go in as
   * `textContent`, so nothing in a name or a spoken sentence can be markup;
   * `footHtml` is composed by the caller, because it carries a key cap inside a
   * `{key}` placeholder and the markup has to travel as a value — the same
   * shape `showHint` and the riding badge use.
   *
   * Called every simulation slice while a talk is open, so each field is
   * compared BEFORE it is written and nothing here builds a string: a held
   * conversation touches the DOM exactly once.
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
    this.dialogueEl.classList.add('show');
  }

  /**
   * Clear everything transient on the HUD: toasts in flight, the interact hint,
   * a conversation still on screen.
   *
   * For the one moment the game ends without the page going with it — Exit, in
   * main.ts. Everything else here is a READOUT of state that is about to be
   * reset anyway (health bars, beast cards, the purse) and redraws itself on the
   * next frame from the numbers the reset wrote. These three do not: a toast is
   * a timer, a hint is a latch, and a dialogue waits to be dismissed, so all
   * three would otherwise be carried across the title screen into the next game.
   */
  reset(): void {
    for (const toast of this.toasts) toast.el.remove();
    this.toasts.length = 0;
    this.hideHint();
    this.hintText = '';
    this.hideDialogue();
    // The tracker is the fourth of these: it is written on CHANGE rather than
    // per frame, so a new session that happens to start with no quests would
    // otherwise inherit the last one's list and never be told to clear it.
    this.questSig = '';
    this.questsEl.innerHTML = '';
  }

  hideDialogue(): void {
    this.dialogueEl.classList.remove('show');
  }

  // -------------------------------------------------------------------------
  // Mounting
  // -------------------------------------------------------------------------
  /**
   * Hold-to-mount fill, 0..1. Called every frame; the whole body is guarded on
   * the rounded sweep angle so a held key does not touch the DOM 60 times a
   * second for a ring that only moves in whole degrees.
   */
  setMountHold(progress: number): void {
    const deg = Math.round(clamp01(progress) * 360);
    if (deg === this.mountDeg) return;
    const was = this.mountDeg;
    this.mountDeg = deg;
    this.mountRingEl.style.background =
      `conic-gradient(#8ef0ff ${deg}deg, rgba(255,255,255,.16) ${deg}deg)`;
    if ((deg > 0) !== (was > 0)) this.mountHoldEl.classList.toggle('show', deg > 0);
    // Full ring: one pop, on the frame the hold completes.
    if (deg >= 360 && was < 360) {
      this.mountHoldEl.classList.remove('bs-pop');
      void this.mountHoldEl.offsetWidth;
      this.mountHoldEl.classList.add('bs-pop');
    }
  }

  /**
   * Name of the beast being ridden, or null when on foot. Called every frame, so
   * the inputs are compared BEFORE any string is built — the badge changes
   * about twice a session and there is no reason to allocate a label per frame.
   */
  /**
   * Print controller faces instead of key caps, or `null` to go back.
   *
   * Called every frame from main.ts and returns immediately unless the device
   * actually changed. It changes BOTH WAYS now: the caller passes the device
   * that last produced input rather than "a pad has been used at some point",
   * so a player who puts the controller down and reaches for the keyboard gets
   * key caps back mid-session. That round trip is why this reports whether it
   * did anything — main.ts holds a few composed hint strings that have a key cap
   * baked into them and has to re-derive them on the same edge, exactly as it
   * does for a language change.
   *
   * The hotbar badges are rewritten in place rather than by invalidating
   * `setSkills`' diff: that diff keys on the skill id, so forcing it would mean
   * faking an id change and rebuilding four slots' worth of markup to alter one
   * character in each.
   */
  setPadPrompts(glyphs: PadGlyphs | null): boolean {
    if (glyphs === this.padGlyphSet) return false;
    this.padGlyphSet = glyphs;
    this.prompts = glyphs ? padPrompts(glyphs) : KBM_PROMPTS;

    const lbl = this.mountHoldEl.querySelector('.lbl');
    if (lbl) lbl.innerHTML = t('hud.mountHold', { key: this.prompts.mount });

    // The menu button's cap follows the device like every other prompt: `F10`
    // on a keyboard, Start or Options on a pad — and it is the SAME `<kbd>` /
    // `.pad` markup, so it picks up the keycap-vs-round-face distinction the
    // stylesheet already draws for free.
    this.menuBtnCapEl.innerHTML = this.prompts.menu;

    for (let i = 0; i < this.slotRefs.length; i++) {
      const key = this.slotRefs[i].el.querySelector('.key');
      if (key) key.textContent = this.prompts.slot(i);
    }

    // Force the riding badge to rebuild on its next update; it early-returns on
    // unchanged text and the text is about to change under it.
    this.ridingText = '';
    this.ridingBeast = null;

    // The shop's footer is composed at open time, so an open shop needs the row
    // replaced under it; a closed one picks the new device up for free.
    const foot = this.shopWrap.querySelector('.bs-shop-foot');
    if (foot) foot.innerHTML = shopFootHints(this.prompts);

    // Same for the controls sheet, and this one is not hypothetical: a pad's
    // buttons are read for "the pad is the live device" BEFORE the modal branch
    // in gamepad.ts, so picking the controller up WHILE READING THE SHEET swaps
    // its faces under the player's eyes. That is the point of it.
    if (this.controlsOpen) this.buildControls();
    return true;
  }

  /**
   * The interact cap — `E` or the pad's own face — already wrapped in its
   * markup, ready to drop into a `{key}` placeholder.
   *
   * Exposed for the same reason `kbd` is exported: the hint pill's sentence is
   * composed by main.ts, which owns which key opens a skill den and which one
   * talks to somebody. Read it on the way to the DOM and it is always the right
   * device; the callers that hoist it out of the frame loop re-derive on the
   * edge `setPadPrompts` reports.
   */
  get interactPrompt(): string { return this.prompts.interact; }

  /**
   * Re-derive every string this panel captured at CONSTRUCTION time, after the
   * display language changed under it. Wire it to `onLanguageChange` — see
   * src/i18n/index.ts — and never call it per frame: it rewrites markup.
   *
   * Two kinds of string live in here and only the first kind needs this.
   * Anything main.ts hands in each slice (beast names, skill names on a card,
   * the hint pill, a dialogue line) is already re-looked-up upstream and arrives
   * translated on its own. What is stuck is what was baked into markup once —
   * the HP caption, the level-up eyebrow, the mount ring's label, the currency
   * word — plus anything sitting behind a change guard that a language switch
   * does NOT move: a skill slot keyed on `skillId` and a bag keyed on
   * `id:count` both re-render only when their subject changes, and the subject
   * has not changed, only its name. Those guards are invalidated here so the
   * next ordinary update redraws them.
   *
   * The one string this cannot reach is a toast already on screen: it was
   * formatted when it was raised and it keeps the words it was raised with for
   * the couple of seconds it has left. Rewriting mid-flight would be worse.
   */
  relabel(): void {
    const hpLbl = this.root.querySelector('.bs-hp .lbl');
    if (hpLbl) hpLbl.textContent = t('hud.hp');

    const eyebrow = this.bannerEl.querySelector('.eyebrow');
    if (eyebrow) eyebrow.textContent = t('hud.levelUp');

    const mountLbl = this.mountHoldEl.querySelector('.lbl');
    if (mountLbl) mountLbl.innerHTML = t('hud.mountHold', { key: this.prompts.mount });

    // The menu button says nothing, so only the two strings a screen reader and
    // a hover tooltip use need re-deriving. The cap is a key name and does not
    // translate.
    this.menuBtnEl.setAttribute('aria-label', t('hud.menu'));
    this.menuBtnEl.title = t('hud.menu');

    // The currency word is only rewritten when the plural FORM flips, which a
    // language switch does not do, so it is written directly rather than by
    // invalidating the count guard.
    this.shardLblEl.textContent = itemName(CURRENCY, Math.max(0, this.shardsDisplayed));

    // Guards whose subject is unchanged but whose text is not. The quest guard
    // is only INVALIDATED — its rows are resolved by the host (see setQuests),
    // so the redraw is the host's next push and not ours.
    this.bagSig = '';
    this.questSig = '';
    for (const refs of this.slotRefs) refs.skillId = '';
    this.ridingText = '';
    this.ridingBeast = null;

    // An open shop keeps its cards until it is reopened — the footer is one
    // element and worth replacing, the card list is a rebuild with a purchase
    // possibly half made. In practice this is unreachable: the language picker
    // is in the start menu, which cannot be up at the same time as a shop.
    const foot = this.shopWrap.querySelector('.bs-shop-foot');
    if (foot) foot.innerHTML = shopFootHints(this.prompts);

    // The controls sheet is thirty translated rows, and unlike the shop it is
    // cheap to rebuild whole — there is no half-made purchase inside it. Also
    // unreachable in practice today (the picker is in the start menu), and
    // written anyway so that an in-game language switch cannot leave the one
    // panel a confused player opened stuck in the language that confused them.
    if (this.controlsOpen) this.buildControls();
  }

  /**
   * `mode` is what the pair are DOING and not what the animal is: a water beast
   * on a beach rides like a ground mount and gets the ground badge, and starts
   * showing the depth line the moment it is actually afloat. That is why this
   * is a mode and not the species' locomotion — the badge changes under a rider
   * who never pressed anything, because the world under it changed.
   */
  setMounted(beastName: string | null, mode: RideMode): void {
    if (beastName === this.ridingBeast && mode === this.ridingMode) return;
    this.ridingBeast = beastName;
    this.ridingMode = mode;
    // Built from the table with the key caps already marked up, so the sentence
    // can be reordered by a translation. Previously this glued the badge
    // together in English and then went hunting for "SPACE/C" and "F" with
    // regexes — which only ever worked because the words around them were fixed.
    const text = beastName
      ? t(mode === 'flying' ? 'hud.ridingFlying'
        : mode === 'swimming' ? 'hud.ridingSwimming'
        : 'hud.riding', {
        beast: escapeHtml(beastName.toUpperCase()),
        altitude: this.prompts.altitude,
        dismount: this.prompts.dismount,
      })
      : '';
    if (text === this.ridingText) return;
    this.ridingText = text;
    if (!beastName) {
      this.ridingEl.classList.remove('show');
      return;
    }
    this.ridingEl.innerHTML = text;
    this.ridingEl.classList.add('show');
  }

  // -------------------------------------------------------------------------
  // Controls sheet (F1)
  // -------------------------------------------------------------------------
  /**
   * Show or hide the controls sheet. F1 is the only thing that calls this; see
   * the frame loop in main.ts, which also treats an open sheet as a modal —
   * the hero stands still while the player reads, exactly as he does for a shop.
   */
  toggleControls(): void {
    if (this.controlsOpen) this.closeControls();
    else this.openControls();
  }

  openControls(): void {
    if (this.controlsOpen) return;
    this.controlsOpen = true;
    this.buildControls();
    this.root.classList.add('keys-open');
    // Let the DOM settle so the open transition plays, the same one-frame wait
    // the shop takes.
    requestAnimationFrame(() => {
      if (this.controlsOpen) this.keysWrap.classList.add('open');
    });
  }

  closeControls(): void {
    if (!this.controlsOpen) return;
    this.controlsOpen = false;
    this.keysWrap.classList.remove('open');
    this.root.classList.remove('keys-open');
    // The markup stays where it is so the panel can fade out; the next open
    // rebuilds it, which is also how it picks up a device change made while it
    // was shut.
  }

  isControlsOpen(): boolean {
    return this.controlsOpen;
  }

  private buildControls(): void {
    this.keysWrap.innerHTML = '';

    const scrim = div('bs-scrim');
    scrim.addEventListener('click', () => this.closeControls());
    this.keysWrap.appendChild(scrim);

    const panel = div('bs-keys bs-glass');
    const head = div('bs-keys-head', `<h2>${escapeHtml(t('keys.title'))}</h2>`);
    const closeBtn = document.createElement('button');
    closeBtn.className = 'bs-shop-x';
    closeBtn.innerHTML = CLOSE_ICON;
    closeBtn.addEventListener('click', () => this.closeControls());
    head.appendChild(closeBtn);
    panel.appendChild(head);

    panel.appendChild(div('bs-keys-body', controlsHtml(this.padGlyphSet)));
    panel.appendChild(div(
      'bs-keys-foot',
      t('keys.foot', { key: kbd('F1'), esc: kbd('Esc') }),
    ));
    this.keysWrap.appendChild(panel);
  }

  // -------------------------------------------------------------------------
  // Shop
  // -------------------------------------------------------------------------
  openShop(title: string, offers: ShopOffer[], onBuy: (index: number) => void, onClose: () => void): void {
    this.shopOnClose = onClose;
    this.shopWrap.innerHTML = '';

    const scrim = div('bs-scrim');
    scrim.addEventListener('click', () => this.requestShopClose());
    this.shopWrap.appendChild(scrim);

    const panel = div('bs-shop bs-glass');

    const head = div('bs-shop-head');
    head.innerHTML =
      `<h2>${escapeHtml(title)}</h2>` +
      `<div class="bal"><span class="ic">${SHARD_ICON}</span><b>${Math.round(this.shardsTarget)}</b></div>`;
    this.shopBalEl = head.querySelector('.bal b') as HTMLElement;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'bs-shop-x';
    closeBtn.innerHTML = CLOSE_ICON;
    closeBtn.addEventListener('click', () => this.requestShopClose());
    head.appendChild(closeBtn);
    panel.appendChild(head);

    const grid = div('bs-offers');
    offers.forEach((offer, i) => {
      // The two cards share their frame, their price foot and their buy button
      // and differ in the top half; only that half is branched.
      const el = offer.kind === 'skill' ? ELEMENT_COLORS[offer.skill.element] : offer.color;
      const bought = offer.kind === 'skill' && offer.owned;
      const card = div(`bs-offer${bought ? '' : offer.affordable ? '' : ' locked'}`);
      card.style.setProperty('--el', hexColor(el));
      card.style.setProperty('--el2', rgba(el, 0.4));
      const head = offer.kind === 'skill'
        ? `<div class="top"><span class="oic" style="--el2:${rgba(el, 0.18)}">` +
          `${elementIcon(offer.skill.element)}</span>` +
          `<div><h3>${escapeHtml(t(offer.skill.nameKey))}</h3>` +
          `<div class="beast">${escapeHtml(t('shop.forBeast', { beast: offer.beastName }))}</div>` +
          `</div></div>` +
          `<p>${escapeHtml(t(offer.skill.descriptionKey))}</p>` +
          `<div class="bs-chips">` +
          `<span class="bs-chip">${escapeHtml(t('shop.stat.power'))} <b>${offer.skill.power}</b></span>` +
          `<span class="bs-chip">${escapeHtml(t('shop.stat.cooldown'))} <b>${offer.skill.cooldown}s</b></span>` +
          `<span class="bs-chip">${escapeHtml(offer.skill.targeting.toUpperCase())}</span>` +
          `</div>`
        : `<div class="top"><span class="oic" style="--el2:${rgba(el, 0.18)}">` +
          `${offer.orbTier !== undefined ? tameOrbIcon(offer.orbTier) : SHARD_ICON}</span>` +
          `<div><h3>${escapeHtml(offer.name)}</h3></div></div>` +
          `<p>${escapeHtml(offer.description)}</p>` +
          `<div class="bs-chips">` +
          `<span class="bs-chip">${escapeHtml(t('shop.stat.held'))} <b>${offer.held}</b></span>` +
          `</div>`;
      card.innerHTML =
        `<div class="accent" style="background:linear-gradient(90deg,${hexColor(el)},${rgba(el, 0.25)})"></div>` +
        head +
        `<div class="foot"></div>`;
      const foot = card.querySelector('.foot') as HTMLElement;

      if (bought) {
        const owned = div('bs-buy owned', `${CHECK_ICON}<span>${escapeHtml(t('shop.learned'))}</span>`);
        foot.appendChild(owned);
      } else {
        const price = div(
          `bs-price${offer.affordable ? '' : ' no'}`,
          `<span class="ic">${SHARD_ICON}</span><span>${offer.price}</span>`,
        );
        foot.appendChild(price);
        const btn = document.createElement('button');
        btn.className = 'bs-buy';
        btn.textContent = t('shop.buy');
        btn.disabled = !offer.affordable;
        btn.addEventListener('click', () => onBuy(i));
        foot.appendChild(btn);
      }
      grid.appendChild(card);
    });
    panel.appendChild(grid);

    panel.appendChild(div('bs-shop-foot', shopFootHints(this.prompts)));
    this.shopWrap.appendChild(panel);

    if (!this.shopOpen) {
      this.shopOpen = true;
      this.root.classList.add('shop-open');
      // let the DOM settle so the open transition plays
      requestAnimationFrame(() => {
        if (this.shopOpen) this.shopWrap.classList.add('open');
      });
    } else {
      this.shopWrap.classList.add('open');
    }
  }

  closeShop(): void {
    if (!this.shopOpen) return;
    this.shopOpen = false;
    this.shopOnClose = null;
    this.shopBalEl = null;
    this.shopWrap.classList.remove('open');
    this.root.classList.remove('shop-open');
  }

  isShopOpen(): boolean {
    return this.shopOpen;
  }

  /** Esc / X / scrim: close visuals, then notify the game. */
  private requestShopClose(): void {
    if (!this.shopOpen) return;
    const cb = this.shopOnClose;
    this.closeShop();
    cb?.();
  }

  // -------------------------------------------------------------------------
  // Per-frame animation tick
  // -------------------------------------------------------------------------
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
      if (Math.abs(this.shardsTarget - this.shardsShown) < 0.5) this.shardsShown = this.shardsTarget;
    }
    const shown = Math.round(this.shardsShown);
    if (shown !== this.shardsDisplayed) {
      const wasPlural = this.shardsDisplayed !== 1;
      this.shardsDisplayed = shown;
      this.shardNumEl.textContent = String(shown);
      // Only when the FORM changes — 1 Cubloon / 2 Cubloons — not on every tick
      // of a count-up, which would rewrite the same word sixty times a second.
      if ((shown !== 1) !== wasPlural) {
        this.shardLblEl.textContent = itemName(CURRENCY, shown);
      }
      if (this.shopBalEl) this.shopBalEl.textContent = String(shown);
    }

    // banner auto-hide
    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) this.bannerEl.classList.remove('show');
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
        toast.el.classList.add('hide');
      }
    }
  }
}
