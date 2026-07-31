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

  // A DELIBERATE SUBSET of the new names, so a single frame shows both halves
  // of the fallback: Emberfox and Sproutle are translated, the other eight beasts
  // are not and render their English names from `en.ts`. Same for the skills —
  // Flame Dart moved, Ember Pounce did not.
  'beast.emberfox.name': 'Glödräv',
  'beast.emberfox.desc':
    'En ivrig liten räv vars överdimensionerade svans pyr när den är upprymd — vilket är jämt.',
  'beast.sproutle.name': 'Grodd',
  'skill.emberfox.flame-dart.name': 'Eldpil',
  'skill.emberfox.flame-dart.desc':
    'Spottar en snabb rävelds-blixt som brister i ett regn av gnistor.',

  // Both halves of a town: the pretty name, and the SIGN.
  //
  // The sign is written in natural Swedish, accents and all, and `signText` in
  // world/town-parts.ts folds it to the 3x5 voxel font on the way to the plank
  // (Ö -> O, Ä -> A) — captured: this renders "RODBRIAR" on the fingerpost.
  // Without that fold the old code would have carved a BLANK where the Ö is,
  // because `letters()` draws an unknown glyph as empty space. A translator
  // writes the word; they do not have to know what the carver can cut.
  // Stonewatch and the Encampment are left in English on purpose.
  'town.redbriar.name': 'Rödbriars Kvarn',
  'town.redbriar.sign': 'RÖDBRIAR',

  // The gateway hints, which are the concatenation this pass removed. Swedish
  // puts the destination after the preposition and the percentage last, and the
  // second line reverses the clause order outright — neither is expressible in
  // "Entering " + name + "… " + pct + "%".
  'hint.zoneEntering': 'På väg in i {zone}… {pct}%',
  'hint.zoneStand': 'Ställ dig i porten för att resa till {zone}',
  // `{key}` arrives already wrapped in <kbd>, so it can land mid-sentence here
  // where English puts it second. This is what replaced the `Press (\S+)` regex.
  'hint.skillDen': 'Tryck {key} för Färdighetslyan',
  // {name} is the NPC's display name, and it lands after the verb here where
  // English puts it at the end of the clause.
  'hint.npcTalk': 'Tryck {key} för att prata med {name}',

  // GAIN. His name is left in English (a name is not translated) but his LINE
  // is, and it is the best argument in this file for one key per sentence: the
  // joke is a word cut off half way into his own name — "and l[isten]" becomes
  // "…gain some knowledge" — and it cannot survive being reassembled out of
  // fragments. Swedish gets the same joke with a different word: "lyssna"
  // (listen) breaks at "ly…" and lands on Gain. Note the ellipsis and the
  // trailing full stop are part of the line, in both languages.
  'npc.gain.greeting': 'Stanna en stund, och ly... Gain lär dig något klokt.',
  // 'npc.dialogue.close' is deliberately NOT translated: it puts an English
  // footer under a Swedish line in the same panel, which is the fallback rule
  // visible in one screenshot.

  'toast.fainted': 'Du svimmade!',
  'toast.revived': 'På benen igen!',

  'hud.hp': 'HP',
  'hud.level': 'Nivå {n}',
  'hud.levelUp': 'NY NIVÅ',
  'hud.levelUpReached': '{beast} nådde nivå {level}!',
  'hud.levelUpLearned': '{beast} nådde nivå {level} — lärde sig {skill}!',
  'hud.mountHold': 'HÅLL {key} FÖR ATT RIDA',

  'shop.buy': 'KÖP',
  'shop.learned': 'Inlärd',
  'shop.forBeast': 'till {beast}',

  // Word order differs from English here — "hämtade" takes the item before the
  // count, and the zone name lands after the verb. Exactly why these are single
  // keys with placeholders rather than concatenated fragments.
  'toast.fetched': '{beast} hämtade {item} ({n})',
  'toast.enteredZone': 'Du kom fram till {zone}',
  'toast.beastTakesLead': '{beast} tar ledningen!',
};
