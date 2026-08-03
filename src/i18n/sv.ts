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

  // The biomes, and A DELIBERATE SUBSET again — the four that are weather are
  // translated, and the two that are not ('underwater', 'trampled') plus the
  // shore are left to fall back, so this block carries its own proof the same
  // way the beasts and the skills above do. See the note at the top of the file
  // before filling the hole in.
  'biome.plains.name': 'Slätter',
  'biome.forest.name': 'Skog',
  'biome.desert.name': 'Öken',
  'biome.snow.name': 'Snöfält',

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

  // The start menu is translated in FULL, and that is a deliberate exception to
  // this file's "leave a hole" rule. The menu is where the language picker
  // lives, so it is the surface a player watches while switching: a half
  // English menu there reads as a broken switch rather than as the fallback
  // doing its job. The fallback proof is untouched — the beasts, the skills and
  // the zone names above still have their holes.
  //
  // The game's NAME is not here because it is not a string: the logo is
  // artwork. `menu.title` is its alt text, and it is translated because a
  // screen reader is the one place the name IS a string.
  'menu.title': 'Beast Story: Bonds of Red',
  'menu.pressStart': 'Tryck på start...',
  'menu.newGame': 'Nytt spel',
  'menu.load': 'Ladda',
  'menu.load.unavailable': 'Inget sparat spel',
  'menu.settings': 'Inställningar',
  'menu.back': 'Tillbaka',
  'menu.settings.title': 'Inställningar',
  // Flikarna över inställningarna. 'Spel' och inte 'Spelupplevelse': fliken står
  // bredvid tre andra i en spalt som är 400 px bred, och ordet ska rymmas.
  'menu.settings.tab.gameplay': 'Spel',
  'menu.settings.tab.controls': 'Kontroller',
  'menu.settings.tab.graphics': 'Grafik',
  'menu.settings.tab.sound': 'Ljud',
  // Grafikfliken. Samma reglage som F3-panelen, men med spelarens ord —
  // 'Växtlighet' täcker gräs, blommor och markens småväxter tillsammans.
  'menu.settings.ao': 'Omgivningsskuggning',
  'menu.settings.bloom': 'Ljussken',
  'menu.settings.aa': 'Kantutjämning',
  'menu.settings.shadows': 'Skuggor',
  'menu.settings.foliage': 'Växtlighet',
  'menu.settings.hapticFeedback': 'Aktivera vibration i handkontrollen',
  'menu.settings.invertX': 'Invertera sikte X',
  'menu.settings.invertY': 'Invertera sikte Y',
  'menu.settings.controllerNote': 'Gäller bara handkontroll — musen inverteras aldrig.',
  'menu.settings.autoFullscreen': 'Helskärm vid start',
  'menu.settings.music': 'Musik',
  'menu.settings.language': 'Språk',
  // Under språkväljaren, och bara när inställningarna öppnats inifrån ett spel
  // där den är avstängd. Säger var inställningen finns, inte att den saknas.
  'menu.settings.languageInGame': 'Byt språk från startskärmen.',

  // Menyn i spelet (src/ui/pause.ts) — Escape, Start på handkontrollen eller
  // MENY-knappen på pekskärmen.
  //
  // 'Meny' och inte 'Pausad': hjälten står stilla medan menyn är uppe, men
  // världen bakom honom gör inte det — bestar följer, vilda varelser rör sig
  // och klockan går. Samma resonemang som i en.ts.
  'pause.title': 'Meny',
  'pause.continue': 'Fortsätt',
  'pause.settings': 'Inställningar',
  'pause.exit': 'Avsluta till startskärmen',
  // MENY-knappen uppe till vänster på pekskärmen. En knappetikett, så den är
  // lika kort som den engelska — knappen växer inte med ordet.
  'touch.menu': 'MENY',
  // Raden för Escape i F1-arket. Samma ordning som originalet: det öppnar menyn
  // när inget annat är uppe, och stänger det som är uppe när något är det.
  'keys.cancel': 'Meny · stäng · avbryt',

  // Uppstartsförloppet (src/ui/loading.ts).
  'load.world': 'Bygger världen',
  'load.actors': 'Väcker bestarna',
  'load.shaders': 'Kompilerar shaders',
  'load.terrain': 'Låter skogen växa',
  'load.ready': 'Klar',
  'menu.on': 'PÅ',
  'menu.off': 'AV',

};
