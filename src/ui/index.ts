import type { ElementType, EventBus, SkillDef } from '../core/types';
import { ELEMENT_COLORS } from '../core/types';
import type { BagEntry } from '../core/items';
import { injectStyles } from './styles';
import { elementIcon, SHARD_ICON, CHECK_ICON, CLOSE_ICON } from './icons';

// ---------------------------------------------------------------------------
// Public data shapes (consumed by main.ts)
// ---------------------------------------------------------------------------
export interface PalHudInfo {
  name: string;
  element: ElementType;
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

export interface ShopOffer {
  skill: SkillDef;
  price: number;
  owned: boolean;
  palName: string;
  affordable: boolean;
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
function titleCase(id: string): string {
  return id.replace(/[-_]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
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
 * The `CUBE PALS v1.0` plate is a development affordance, not part of the game:
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
function lockedSlotHtml(index: number): string {
  return `<span class="key">${index + 1}</span><span class="lock">${LOCK_ICON}</span>`;
}

interface PalCardRefs {
  card: HTMLDivElement;
  inner: HTMLDivElement;
  hpBar: HTMLElement;
  xpBar: HTMLElement;
  /** the XP track itself, hidden while a fresh pal has nothing to show */
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

interface ToastEntry {
  el: HTMLDivElement;
  t: number;
  hiding: boolean;
}

const SHOP_FOOT_HINTS =
  '<span><kbd>WASD</kbd> move</span><span><kbd>Space</kbd> jump</span>' +
  '<span><kbd>LMB</kbd> attack</span><span><kbd>1</kbd>–<kbd>4</kbd> skills</span>' +
  '<span><kbd>Tab</kbd> swap pal</span><span><kbd>E</kbd> interact</span>';

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

  // pals
  private palRefs: [PalCardRefs, PalCardRefs];
  private prevPalNames: [string | null, string | null] = [null, null];

  // skills
  private slotRefs: SlotRefs[] = [];

  // shards
  private shardNumEl: HTMLElement;
  private shardPillEl: HTMLElement;
  private shopBalEl: HTMLElement | null = null;
  private shardsShown = 0;
  private shardsTarget = 0;
  private shardsDisplayed = -1;
  private shardsInit = false;

  // bag (stackable items)
  private bagEl: HTMLDivElement;
  private bagSig = '';

  // banner
  private bannerEl: HTMLDivElement;
  private bannerTimer = 0;

  // toasts
  private toastWrap: HTMLDivElement;
  private toasts: ToastEntry[] = [];

  // hint
  private hintEl: HTMLDivElement;
  private hintText = '';

  // mounting
  private mountHoldEl: HTMLDivElement;
  private mountRingEl: HTMLElement;
  private ridingEl: HTMLDivElement;
  private mountDeg = -1;
  private ridingText = '';
  private ridingPal: string | null = null;
  private ridingFlying = false;

  // shop
  private shopWrap: HTMLDivElement;
  private shopOpen = false;
  private shopOnClose: (() => void) | null = null;
  private escHandler: (e: KeyboardEvent) => void;

  constructor(bus: EventBus) {
    injectStyles();

    this.root = div('cp-root');

    // title chip (dev plate; only with ?debug=1) ----------------------------
    if (isDebugMode()) {
      this.root.appendChild(div('cp-title cp-glass', '<b>CUBE PALS</b><span>v1.0</span>'));
    }

    // shard counter --------------------------------------------------------
    this.shardPillEl = div('cp-shards cp-glass', `<span class="ic">${SHARD_ICON}</span><span class="num">0</span>`);
    this.shardNumEl = this.shardPillEl.querySelector('.num') as HTMLElement;
    this.root.appendChild(this.shardPillEl);

    // bag (stackable items) — empty until something is picked up ------------
    this.bagEl = div('cp-bag');
    this.root.appendChild(this.bagEl);

    // crosshair ------------------------------------------------------------
    this.root.appendChild(div('cp-cross'));

    // hold-to-mount ring, wrapped around the crosshair ----------------------
    // It belongs AT the reticle: the thing being held is a commitment made
    // where the player is already looking, and a bar in a corner of the screen
    // would be feedback for an action happening somewhere else.
    this.mountHoldEl = div('cp-mounthold', '<div class="ring"></div><div class="lbl">HOLD <kbd>F</kbd> TO MOUNT</div>');
    this.mountRingEl = this.mountHoldEl.querySelector('.ring') as HTMLElement;
    this.root.appendChild(this.mountHoldEl);

    // "riding" badge, above the interact hint --------------------------------
    this.ridingEl = div('cp-riding cp-glass');
    this.root.appendChild(this.ridingEl);

    // left cluster: one panel holding the pal cards + player hp ------------
    const left = div('cp-left');
    const pals = div('cp-pals');
    this.palRefs = [this.makePalCard(true), this.makePalCard(false)];
    pals.appendChild(this.palRefs[0].card);
    pals.appendChild(this.palRefs[1].card);
    left.appendChild(pals);

    const hp = div(
      'cp-hp',
      '<div class="row"><span class="lbl">HP</span><span class="val"></span></div>' +
      '<div class="track"><div class="ghost"></div><div class="fill"></div></div>',
    );
    this.hpFillEl = hp.querySelector('.fill') as HTMLElement;
    this.hpGhostEl = hp.querySelector('.ghost') as HTMLElement;
    this.hpValEl = hp.querySelector('.val') as HTMLElement;
    left.appendChild(hp);
    this.root.appendChild(left);

    // hotbar ---------------------------------------------------------------
    const hotbar = div('cp-hotbar');
    for (let i = 0; i < 4; i++) {
      const slot = div('cp-slot empty', lockedSlotHtml(i));
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
    this.hintEl = div('cp-hint cp-glass');
    this.root.appendChild(this.hintEl);

    // level-up banner ------------------------------------------------------
    this.bannerEl = div('cp-banner cp-glass', '<div class="eyebrow">LEVEL UP</div><div class="txt"></div>');
    this.root.appendChild(this.bannerEl);

    // toasts ---------------------------------------------------------------
    this.toastWrap = div('cp-toasts');
    this.root.appendChild(this.toastWrap);

    // shop -----------------------------------------------------------------
    this.shopWrap = div('cp-shopwrap');
    this.root.appendChild(this.shopWrap);

    document.body.appendChild(this.root);

    this.escHandler = (e: KeyboardEvent) => {
      if (e.code === 'Escape' && this.shopOpen) this.requestShopClose();
    };

    this.setPlayerHp(100, 100);

    bus.on((e) => {
      if (e.type === 'toast') this.addToast(e.text);
      else if (e.type === 'shardsChanged') this.setShards(e.total);
      else if (e.type === 'palLevelUp') this.showLevelUp(e.palId, e.level, e.learned);
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
  // Pal cards
  // -------------------------------------------------------------------------
  private makePalCard(primary: boolean): PalCardRefs {
    const card = div(`cp-pal hidden ${primary ? 'primary' : 'support'}`);
    const inner = div('cp-pal-in');
    card.appendChild(inner);
    return { card, inner, hpBar: inner, xpBar: inner, xpTrack: inner, sig: '' };
  }

  setPals(primary: PalHudInfo | null, support: PalHudInfo | null): void {
    const swapped =
      primary !== null && support !== null &&
      this.prevPalNames[0] === support.name && this.prevPalNames[1] === primary.name;
    this.renderPal(this.palRefs[0], primary, swapped);
    this.renderPal(this.palRefs[1], support, swapped);
    this.prevPalNames[0] = primary?.name ?? null;
    this.prevPalNames[1] = support?.name ?? null;
  }

  private renderPal(refs: PalCardRefs, info: PalHudInfo | null, animateSwap: boolean): void {
    if (!info) {
      refs.card.classList.add('hidden');
      refs.sig = '';
      return;
    }
    refs.card.classList.remove('hidden');
    const sig = `${info.name}|${info.element}|${info.level}`;
    if (sig !== refs.sig) {
      refs.sig = sig;
      const el = ELEMENT_COLORS[info.element];
      refs.card.style.setProperty('--el', hexColor(el));
      refs.inner.innerHTML =
        `<div class="badge">${elementIcon(info.element)}</div>` +
        `<div class="meta">` +
        `<div class="row"><span class="nm">${escapeHtml(info.name)}</span><span class="lv">Lv ${info.level}</span></div>` +
        `<div class="cp-micro hp"><i></i></div>` +
        `<div class="cp-micro xp"><i></i></div>` +
        `</div>`;
      refs.hpBar = refs.inner.querySelector('.cp-micro.hp > i') as HTMLElement;
      refs.xpBar = refs.inner.querySelector('.cp-micro.xp > i') as HTMLElement;
      refs.xpTrack = refs.inner.querySelector('.cp-micro.xp') as HTMLElement;
      if (animateSwap) {
        refs.inner.classList.remove('cp-swap');
        void refs.inner.offsetWidth; // restart animation
        refs.inner.classList.add('cp-swap');
      }
    }
    const hpPct = Math.round(clamp01(info.maxHp > 0 ? info.hp / info.maxHp : 0) * 1000) / 10;
    const xpPct = Math.round(clamp01(info.xpToNext > 0 ? info.xp / info.xpToNext : 0) * 1000) / 10;
    refs.hpBar.style.width = `${hpPct}%`;
    refs.xpBar.style.width = `${xpPct}%`;
    // A dead-empty XP bar under a Lv 1 pal reads as a broken widget, so the
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
          refs.el.className = 'cp-slot empty';
          refs.el.innerHTML = lockedSlotHtml(i);
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
        refs.el.className = 'cp-slot filled';
        refs.el.style.setProperty('--el', hexColor(el));
        refs.el.style.setProperty('--el2', rgba(el, 0.55));
        refs.el.style.background =
          `linear-gradient(165deg, ${rgba(el, 0.26)}, ${rgba(el, 0.08)}), ` +
          `linear-gradient(165deg, rgba(30,38,54,.72), rgba(14,18,28,.82))`;
        refs.el.innerHTML =
          `<span class="key">${i + 1}</span>` +
          `<span class="ic">${elementIcon(def.element)}</span>` +
          `<span class="cd"></span><span class="cdnum"></span>` +
          `<span class="nm">${escapeHtml(def.name)}</span>`;
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
        refs.el.classList.remove('cp-flash');
        void refs.el.offsetWidth;
        refs.el.classList.add('cp-flash');
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
      this.shardPillEl.classList.remove('cp-pop');
      void this.shardPillEl.offsetWidth;
      this.shardPillEl.classList.add('cp-pop');
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
   * This is also the readout for the support pal's fetch rule: a chip present
   * is exactly the condition under which the pal will fetch more of that item.
   */
  setBag(entries: BagEntry[]): void {
    const sig = entries.map((e) => `${e.def.id}:${e.count}`).join('|');
    if (sig === this.bagSig) return;
    this.bagSig = sig;
    this.bagEl.innerHTML = entries.map((e) =>
      `<div class="chip cp-glass"><i class="sw" style="background:${hexColor(e.def.color)};` +
      `color:${hexColor(e.def.color)}"></i>` +
      `<span class="nm">${escapeHtml(e.def.name)}</span>` +
      `<span class="n">${e.count}</span></div>`,
    ).join('');
    if (entries.length) {
      this.bagEl.classList.remove('cp-pop');
      void this.bagEl.offsetWidth;
      this.bagEl.classList.add('cp-pop');
    }
  }

  // -------------------------------------------------------------------------
  // Level-up banner
  // -------------------------------------------------------------------------
  private showLevelUp(palId: string, level: number, learned?: SkillDef): void {
    const name = escapeHtml(titleCase(palId));
    const txt = this.bannerEl.querySelector('.txt') as HTMLElement;
    if (learned) {
      const el = ELEMENT_COLORS[learned.element];
      this.bannerEl.style.setProperty('--el', hexColor(el));
      this.bannerEl.style.boxShadow =
        `0 0 34px ${rgba(el, 0.35)}, 0 10px 30px rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.1)`;
      txt.innerHTML = `${name} reached Lv ${level} — learned <em>${escapeHtml(learned.name)}</em>!`;
    } else {
      this.bannerEl.style.setProperty('--el', '#ffd23f');
      this.bannerEl.style.boxShadow =
        '0 0 34px rgba(255,210,63,.3), 0 10px 30px rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.1)';
      txt.innerHTML = `${name} reached Lv ${level}!`;
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
    const el = div('cp-toast');
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
  showHint(text: string): void {
    if (text !== this.hintText) {
      this.hintText = text;
      this.hintEl.innerHTML = escapeHtml(text)
        .replace(/\bPress (\S+)/, 'Press <kbd>$1</kbd>');
    }
    this.hintEl.classList.add('show');
  }

  hideHint(): void {
    this.hintEl.classList.remove('show');
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
      this.mountHoldEl.classList.remove('cp-pop');
      void this.mountHoldEl.offsetWidth;
      this.mountHoldEl.classList.add('cp-pop');
    }
  }

  /**
   * Name of the pal being ridden, or null when on foot. Called every frame, so
   * the inputs are compared BEFORE any string is built — the badge changes
   * about twice a session and there is no reason to allocate a label per frame.
   */
  setMounted(palName: string | null, flying: boolean): void {
    if (palName === this.ridingPal && flying === this.ridingFlying) return;
    this.ridingPal = palName;
    this.ridingFlying = flying;
    const text = palName
      ? (flying
        ? `RIDING ${palName.toUpperCase()} · SPACE/C altitude · tap F to dismount`
        : `RIDING ${palName.toUpperCase()} · tap F to dismount`)
      : '';
    if (text === this.ridingText) return;
    this.ridingText = text;
    if (!palName) {
      this.ridingEl.classList.remove('show');
      return;
    }
    this.ridingEl.innerHTML = escapeHtml(text)
      .replace(/\bSPACE\/C\b/, '<kbd>Space</kbd>/<kbd>C</kbd>')
      .replace(/\bF\b(?= to)/, '<kbd>F</kbd>');
    this.ridingEl.classList.add('show');
  }

  // -------------------------------------------------------------------------
  // Shop
  // -------------------------------------------------------------------------
  openShop(title: string, offers: ShopOffer[], onBuy: (index: number) => void, onClose: () => void): void {
    this.shopOnClose = onClose;
    this.shopWrap.innerHTML = '';

    const scrim = div('cp-scrim');
    scrim.addEventListener('click', () => this.requestShopClose());
    this.shopWrap.appendChild(scrim);

    const panel = div('cp-shop cp-glass');

    const head = div('cp-shop-head');
    head.innerHTML =
      `<h2>${escapeHtml(title)}</h2>` +
      `<div class="bal"><span class="ic">${SHARD_ICON}</span><b>${Math.round(this.shardsTarget)}</b></div>`;
    this.shopBalEl = head.querySelector('.bal b') as HTMLElement;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'cp-shop-x';
    closeBtn.innerHTML = CLOSE_ICON;
    closeBtn.addEventListener('click', () => this.requestShopClose());
    head.appendChild(closeBtn);
    panel.appendChild(head);

    const grid = div('cp-offers');
    offers.forEach((offer, i) => {
      const s = offer.skill;
      const el = ELEMENT_COLORS[s.element];
      const card = div(`cp-offer${offer.owned ? '' : offer.affordable ? '' : ' locked'}`);
      card.style.setProperty('--el', hexColor(el));
      card.style.setProperty('--el2', rgba(el, 0.4));
      card.innerHTML =
        `<div class="accent" style="background:linear-gradient(90deg,${hexColor(el)},${rgba(el, 0.25)})"></div>` +
        `<div class="top"><span class="oic" style="--el2:${rgba(el, 0.18)}">${elementIcon(s.element)}</span>` +
        `<div><h3>${escapeHtml(s.name)}</h3><div class="pal">for ${escapeHtml(offer.palName)}</div></div></div>` +
        `<p>${escapeHtml(s.description)}</p>` +
        `<div class="cp-chips">` +
        `<span class="cp-chip">PWR <b>${s.power}</b></span>` +
        `<span class="cp-chip">CD <b>${s.cooldown}s</b></span>` +
        `<span class="cp-chip">${escapeHtml(s.targeting.toUpperCase())}</span>` +
        `</div>` +
        `<div class="foot"></div>`;
      const foot = card.querySelector('.foot') as HTMLElement;

      if (offer.owned) {
        const owned = div('cp-buy owned', `${CHECK_ICON}<span>Learned</span>`);
        foot.appendChild(owned);
      } else {
        const price = div(
          `cp-price${offer.affordable ? '' : ' no'}`,
          `<span class="ic">${SHARD_ICON}</span><span>${offer.price}</span>`,
        );
        foot.appendChild(price);
        const btn = document.createElement('button');
        btn.className = 'cp-buy';
        btn.textContent = 'BUY';
        btn.disabled = !offer.affordable;
        btn.addEventListener('click', () => onBuy(i));
        foot.appendChild(btn);
      }
      grid.appendChild(card);
    });
    panel.appendChild(grid);

    panel.appendChild(div('cp-shop-foot', SHOP_FOOT_HINTS));
    this.shopWrap.appendChild(panel);

    if (!this.shopOpen) {
      this.shopOpen = true;
      this.root.classList.add('shop-open');
      document.addEventListener('keydown', this.escHandler);
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
    document.removeEventListener('keydown', this.escHandler);
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
      this.shardsDisplayed = shown;
      this.shardNumEl.textContent = String(shown);
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
