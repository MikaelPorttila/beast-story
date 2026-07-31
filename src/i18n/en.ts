/**
 * The BASE string table — English, and the source of truth for every key.
 *
 * IDS ARE KEYS; NAMES ARE DISPLAY. Nothing in this file is an identifier. Item
 * ids ('shard'), species ids, skill ids, zone ids and town ids are stable
 * strings that saves, drop tables and lookups all key on, and they never change
 * when a name does — the currency is still `id: 'shard'` in core/items.ts while
 * it displays as "Cubloons" here. Renaming a thing in the game is an edit to
 * this file and nothing else.
 *
 * `as const` is what makes the keys TYPED: `StringKey` below is derived from
 * this object, so `t('hud.lveel')` is a compile error rather than a blank label,
 * and a translation file that invents a key is rejected by tsc too.
 *
 * Other languages are `src/i18n/<iso639-1>.ts` (sv.ts, de.ts, …) and hold only
 * the keys they have actually translated — see index.ts for the fallback.
 *
 * PLACEHOLDERS are `{name}`, substituted by `t()`/`tn()`. Never build a sentence
 * by concatenating fragments: word order differs between languages and a
 * concatenation cannot be translated. If a string needs a value in the middle,
 * it gets a placeholder and stays ONE key.
 *
 * PLURALS are two forms, `<base>.one` and `<base>.other`, selected by `tn()`.
 * See index.ts for what that does and does not cover.
 */
export const en = {
  // ---- items -------------------------------------------------------------
  // Keyed by the item's id, which does NOT change with the display name.
  'item.shard.one': 'Cubloon',
  'item.shard.other': 'Cubloons',
  'item.sunberry.one': 'Sunberry',
  'item.sunberry.other': 'Sunberries',
  'item.glowpebble.one': 'Glow Pebble',
  'item.glowpebble.other': 'Glow Pebbles',

  // ---- zones -------------------------------------------------------------
  // Keyed by the ZoneDef id in main.ts ('overworld', 'hold').
  'zone.overworld.name': 'Embervale',
  'zone.hold.name': 'The Sunken Hold',

  // ---- HUD ---------------------------------------------------------------
  'hud.hp': 'HP',
  'hud.level': 'Lv {n}',
  'hud.levelUp': 'LEVEL UP',
  'hud.levelUpReached': '{pal} reached Lv {level}!',
  // {skill} arrives already wrapped in its own emphasis markup, so the
  // translation decides where in the sentence the skill name lands.
  'hud.levelUpLearned': '{pal} reached Lv {level} — learned {skill}!',
  'hud.mountHold': 'HOLD {key} TO MOUNT',
  'hud.riding': 'RIDING {pal} · tap {dismount} to dismount',
  'hud.ridingFlying': 'RIDING {pal} · {altitude} altitude · tap {dismount} to dismount',

  // ---- hints -------------------------------------------------------------
  'hint.skillDen': 'Press E — Skill Den',

  // ---- shop --------------------------------------------------------------
  'shop.skillDen.title': 'Skill Den',
  'shop.forPal': 'for {pal}',
  'shop.learned': 'Learned',
  'shop.buy': 'BUY',
  'shop.stat.power': 'PWR',
  'shop.stat.cooldown': 'CD',
  'shop.foot.move': '{key} move',
  'shop.foot.jump': '{key} jump',
  'shop.foot.attack': '{key} attack',
  'shop.foot.skills': '{key} skills',
  'shop.foot.swap': '{key} swap pal',
  'shop.foot.interact': '{key} interact',

  // ---- toasts ------------------------------------------------------------
  'toast.welcome.desktop': 'Welcome to Cube Pals! Click to play.',
  'toast.welcome.touch': 'Welcome to Cube Pals! Left stick moves, right stick looks.',
  'toast.controls.desktop':
    'WASD move · Space jump · LMB attack · 1-4 skills · hold F to ride · Tab swap · E shop',
  'toast.controls.touch':
    'Left stick moves · right stick looks · ATK / JUMP / USE · 1-4 skills · SWAP',
  'toast.enteredZone': 'Entered {zone}',
  'toast.palLeads': '{lead} leads · {support} supports',
  'toast.palTakesLead': '{pal} takes the lead!',
  'toast.dismountFirst': 'Dismount first (tap F).',
  'toast.fetched': '{pal} fetched {item} ({n})',
  'toast.learnedSkill': '{pal} learned {skill}!',
} as const;

/**
 * Every key in the game, derived from the base table. A key that is not in
 * `en` above does not exist, and `t()` will not accept it.
 */
export type StringKey = keyof typeof en;

/**
 * What a non-base language file looks like: a PARTIAL map. Anything left out
 * falls back to `en`, so a half-translated language is still fully playable —
 * and an invented key is a compile error, because the index signature only
 * admits `StringKey`.
 */
export type Translation = Partial<Record<StringKey, string>>;
