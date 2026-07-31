import type { Translation } from './en';

/**
 * Swedish — a PARTIAL override, and deliberately left partial.
 *
 * This is what every non-base language looks like: only the keys that have
 * actually been translated. Everything absent falls back to `en` (see
 * index.ts), so the game is fully playable in `?lang=sv` today with the
 * untranslated half rendering in English — never a blank, never a raw key.
 *
 * It is also the working proof of that rule, which is why it is not finished:
 * the zone names, the welcome toasts and two of the three item names are
 * missing ON PURPOSE. If you translate them, translate something else new and
 * leave a hole, or move the fallback proof to a test language.
 *
 * A key that is not in `en.ts` does not compile here — `Translation` is
 * `Partial<Record<StringKey, string>>`, so a typo cannot silently do nothing.
 */
export const sv: Translation = {
  // The currency, which is the whole point of the exercise: rename it once in
  // en.ts and once here, and every place it is displayed follows.
  'item.shard.one': 'Kubloon',
  'item.shard.other': 'Kubloner',

  'hud.hp': 'HP',
  'hud.level': 'Nivå {n}',
  'hud.levelUp': 'NY NIVÅ',
  'hud.levelUpReached': '{pal} nådde nivå {level}!',
  'hud.levelUpLearned': '{pal} nådde nivå {level} — lärde sig {skill}!',
  'hud.mountHold': 'HÅLL {key} FÖR ATT RIDA',

  'shop.buy': 'KÖP',
  'shop.learned': 'Inlärd',
  'shop.forPal': 'till {pal}',

  // Word order differs from English here — "hämtade" takes the item before the
  // count, and the zone name lands after the verb. Exactly why these are single
  // keys with placeholders rather than concatenated fragments.
  'toast.fetched': '{pal} hämtade {item} ({n})',
  'toast.enteredZone': 'Du kom fram till {zone}',
  'toast.palTakesLead': '{pal} tar ledningen!',
};
