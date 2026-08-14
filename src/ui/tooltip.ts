import { t } from "../i18n";
import type { ItemRarity } from "../core/types";
import { tameOrbIcon } from "./icons";
import { isWeaponIcon, weaponIconStyle } from "./weapon-icons";

/**
 * The hover tooltip, hoisted out of the inventory (issue #246) so the journal
 * feeds the same mechanism a different tip map — one mechanism per family.
 * The host element decides the panel; this owns the `.tip` box inside it, the
 * viewport clamping and the content markup. Desktop-only by construction: it
 * only ever shows from a pointerover.
 */

export interface TipStat {
  label: string;
  value: string;
}

export interface TipContent {
  /** Already plural-resolved for `count` by the host. */
  name: string;
  color: number;
  rarity?: ItemRarity;
  description?: string;
  stats?: readonly TipStat[];
  note?: string;
  /** Optional portrait/icon, rendered beside the heading. `entryIconHtml` builds one. */
  iconHtml?: string;
}

export const RARITY_KEYS: Record<
  ItemRarity,
  "inv.rarity.common" | "inv.rarity.rare" | "inv.rarity.legendary"
> = {
  common: "inv.rarity.common",
  rare: "inv.rarity.rare",
  legendary: "inv.rarity.legendary",
};

const escapeHtml = (s: string): string =>
  s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
  );

const hexColor = (c: number): string => "#" + c.toString(16).padStart(6, "0");

/** What the icon chain needs to know — a flattened `InvEntry`, or a tip's stand-in. */
export interface EntryIcon {
  color: number;
  kind?: string;
  /** A tile name in the weapon atlas. */
  icon?: string;
  orbTier?: number;
  /** Set for a beast; `iconUrl` is its baked portrait when one exists yet. */
  speciesId?: string;
  iconUrl?: string | null;
}

/**
 * The one icon fallback chain (issue #246): baked portrait → orb glyph →
 * weapon atlas → coloured lozenge. The inventory's slots and every tooltip
 * render through it, so a new item kind gets its look in one place.
 */
export function entryIconHtml(e: EntryIcon): string {
  if (e.speciesId !== undefined) {
    const url = e.iconUrl ?? null;
    return (
      `<i class="ic beast${url ? "" : " blob"}" data-beast="${escapeHtml(e.speciesId)}"` +
      ` style="--el:${hexColor(e.color)}${url ? `;background-image:url(${url})` : ""}"></i>`
    );
  }
  if (e.kind === "orb") {
    return `<i class="ic glyph" style="--el:${hexColor(e.color)}">${tameOrbIcon(e.orbTier)}</i>`;
  }
  if (e.icon && isWeaponIcon(e.icon)) {
    return `<i class="ic" style="${weaponIconStyle(e.icon)}"></i>`;
  }
  return `<i class="ic blob" style="--el:${hexColor(e.color)}"></i>`;
}

export class Tooltip {
  private el: HTMLDivElement | null = null;

  /** Creates the `.tip` box inside `host`; the host's stylesheet places it. */
  attach(host: HTMLElement): void {
    const el = document.createElement("div");
    el.className = "tip";
    el.setAttribute("aria-hidden", "true");
    host.appendChild(el);
    this.el = el;
  }

  detach(): void {
    this.el?.remove();
    this.el = null;
  }

  get visible(): boolean {
    return this.el?.classList.contains("on") ?? false;
  }

  show(e: TipContent, x: number, y: number): void {
    const tip = this.el;
    if (!tip) {
      return;
    }
    const heading =
      `<h3 style="--el:${hexColor(e.color)}">${escapeHtml(e.name)}</h3>` +
      (e.rarity
        ? `<span class="rar r-${e.rarity}">${escapeHtml(t(RARITY_KEYS[e.rarity]))}</span>`
        : "");
    tip.innerHTML =
      (e.iconHtml ? `<div class="hd"><span class="tico">${e.iconHtml}</span><div>` : "") +
      heading +
      (e.iconHtml ? "</div></div>" : "") +
      (e.description ? `<p>${escapeHtml(e.description)}</p>` : "") +
      (e.stats?.length
        ? `<div class="bs-chips">${e.stats
            .map(
              (s) =>
                `<span class="bs-chip">${escapeHtml(s.label)} <b>${escapeHtml(s.value)}</b></span>`,
            )
            .join("")}</div>`
        : "") +
      (e.note ? `<p class="note">${escapeHtml(e.note)}</p>` : "");
    tip.classList.add("on");
    this.move(x, y);
  }

  /** Measured, not flipped at a breakpoint: the dock is on the right edge. */
  move(x: number, y: number): void {
    const tip = this.el;
    if (!tip) {
      return;
    }
    const r = tip.getBoundingClientRect();
    const pad = 12;
    const left = Math.max(pad, Math.min(x - r.width - 18, window.innerWidth - r.width - pad));
    const top = Math.max(pad, Math.min(y - 12, window.innerHeight - r.height - pad));
    tip.style.transform = `translate(${Math.round(left)}px,${Math.round(top)}px)`;
  }

  hide(): void {
    this.el?.classList.remove("on");
  }

  /** Patch a beast portrait that finished baking while the tip was up. */
  patchIcon(speciesId: string, url: string): void {
    const el = this.el;
    if (!el) {
      return;
    }
    for (const i of el.querySelectorAll<HTMLElement>(`.ic.beast[data-beast="${speciesId}"]`)) {
      i.style.backgroundImage = `url(${url})`;
      i.classList.remove("blob");
    }
  }
}
