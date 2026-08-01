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

  // ---- towns ---------------------------------------------------------------
  // Keyed by the SiteSpec id in world/towns.ts. The id is what a quest stores
  // and what the road network and the compass chip key on; only these move.
  //
  // `.sign` is what a fingerpost ARM reads, and it is the one string in this
  // file with a HARD CHARACTER LIMIT. Signposts are voxel letters out of the
  // 3x5 bitmap font in world/town-parts.ts, which knows A-Z, 0-9, '-', an
  // apostrophe and a space — and nothing else. Anything outside that set is
  // folded (Å/Ä -> A, Ö -> O, É -> E; see `signText`) and whatever survives the
  // fold is dropped, so a sign written in kanji renders as a blank plank. Keep
  // signs upper-case, <= 10 characters, and inside the Latin alphabet; put the
  // pretty form in `.name`, which has a real font behind it.
  'town.encampment.name': 'The Encampment',
  'town.encampment.sign': 'ENCAMPMENT',
  'town.redbriar.name': 'Redbriar Mill',
  'town.redbriar.sign': 'REDBRIAR',
  'town.stonewatch.name': 'Stonewatch',
  'town.stonewatch.sign': 'STONEWATCH',
  /** The fork the road network hangs off — a sign, but not a town. */
  'town.junction.sign': 'CROSSWAY',

  // ---- NPCs ----------------------------------------------------------------
  // Keyed by the NpcCharacter id in src/world/npc-gain.ts. The id ('gain') is
  // what `talk(id)` takes, what the hint cache keys on and what a quest will
  // store; the name and the line are display and live here.
  //
  // If a name ever has to reach a fingerpost or any other carved sign, mind the
  // 3x5 voxel font — A-Z, 0-9, '-', an apostrophe and a space, see the `.sign`
  // note above. 'Gain' is inside it; a translated one might not be.
  'npc.gain.name': 'Deckard Gains Armstrong',
  'npc.gain.greeting': 'Hello, my friend. Stay awhile and... gain some knowledge.',

  // ---- beast species -------------------------------------------------------
  // Keyed by the species id in src/beasts/species/*.ts. The id is what the roster,
  // the ?beast= capture parameter, /mount and every save key on; the name and the
  // flavour blurb are display and live here.
  'beast.aquaxol.name': 'Aquaxol',
  'beast.aquaxol.desc':
    'A perpetually smiling axolotl that waddles on land and ripples through water, gills fluttering like party streamers.',
  'beast.boulderpup.name': 'Boulderpup',
  'beast.boulderpup.desc':
    'A puppy chiseled from mountain strata by a very sentimental earthquake. Moss grows where it naps too long, and the amber crystal on its back glows brighter the happier it gets.',
  'beast.drakelet.name': 'Drakelet',
  'beast.drakelet.desc':
    'A pocket-sized dragon with the ego of a mountain-sized one. Polishes its ember-crimson scales on cliff quartz and practices its roar at sunrise, every sunrise.',
  'beast.emberfox.name': 'Emberfox',
  'beast.emberfox.desc':
    'An eager little fox whose oversized tail smolders when it is excited — which is always.',
  'beast.frostwing.name': 'Frostwing',
  'beast.frostwing.desc':
    'A snowy owl born in the heart of a glacier. It drifts on silent wings, watching everything with polite, unblinking curiosity, and its speckles glitter like fresh frost at dawn.',
  'beast.galebird.name': 'Galebird',
  'beast.galebird.desc':
    'A wind-stitched swallow that treats gravity as a polite suggestion — the fastest wings in the valley.',
  'beast.lumimoth.name': 'Lumimoth',
  'beast.lumimoth.desc':
    'A radiant moth that drifts between lantern posts at dusk, its glowing tail-light said to guide lost travelers home. Collects starlight on its wing-spots.',
  'beast.sparkit.name': 'Sparkit',
  'beast.sparkit.desc':
    'A hyperactive spark rodent that physically cannot sit still. Its tall zigzag tail is a living lightning rod, and its cheek spots crackle whenever it gets excited — so, always.',
  'beast.sproutle.name': 'Sproutle',
  'beast.sproutle.desc':
    'A round mossy turtle-dino whose shell is a garden of overlapping leaf plates. It plods along at its own unhurried pace, head-sprout bobbing, utterly unbothered by anything.',
  'beast.umbrakit.name': 'Umbrakit',
  'beast.umbrakit.desc':
    'A hovering wisp of a cat woven from dusk. Its tail keeps drifting apart and lazily reassembling.',

  // ---- skills --------------------------------------------------------------
  // Keyed by the SkillDef id, which is already namespaced by species and is what
  // the hotbar, the cooldown map and the shop's "already learned" test key on.
  'skill.aquaxol.bubble-pop.name': 'Bubble Pop',
  'skill.aquaxol.bubble-pop.desc':
    'Blows a wobbling bubble that bursts with a surprisingly rude POP.',
  'skill.aquaxol.tide-swirl.name': 'Tide Swirl',
  'skill.aquaxol.tide-swirl.desc':
    'Spins its paddle tail to whip up a chilly whirlpool around itself.',
  'skill.aquaxol.soothing-slime.name': 'Soothing Slime',
  'skill.aquaxol.soothing-slime.desc':
    'Sheds a film of regenerative slime that patches up nearby friends. Slightly gross, extremely effective.',
  'skill.aquaxol.hydro-jet.name': 'Hydro Jet',
  'skill.aquaxol.hydro-jet.desc':
    'Gulps, aims, and fires a pressure-washer stream of water. Do not stand in front of the smile.',
  'skill.boulderpup.pebble-pop.name': 'Pebble Pop',
  'skill.boulderpup.pebble-pop.desc': 'Sneezes a hot pebble at surprising velocity. Bless you.',
  'skill.boulderpup.stomp-quake.name': 'Stomp Quake',
  'skill.boulderpup.stomp-quake.desc':
    'Slams all four paws down at once; the ground complains loudly.',
  'skill.boulderpup.moss-mantle.name': 'Moss Mantle',
  'skill.boulderpup.moss-mantle.desc':
    'Fluffs up its back-moss into a springy cushion that soaks up scrapes.',
  'skill.boulderpup.amber-avalanche.name': 'Amber Avalanche',
  'skill.boulderpup.amber-avalanche.desc':
    'The back-crystal flares white-hot and hurls a fan of molten amber boulders.',
  'skill.drakelet.fang-rush.name': 'Fang Rush',
  'skill.drakelet.fang-rush.desc':
    'Darts in with a snap of needle fangs and far too much confidence for its size.',
  'skill.drakelet.drakefire-breath.name': 'Drakefire Breath',
  'skill.drakelet.drakefire-breath.desc':
    'Puffs up its chest, inhales the whole sky, and exhales a rolling cone of ember-red dragonfire.',
  'skill.drakelet.tailspin-tempest.name': 'Tailspin Tempest',
  'skill.drakelet.tailspin-tempest.desc':
    'Whirls its arrow-tipped tail into a shredding cyclone that batters everything in reach.',
  'skill.drakelet.comet-crash.name': 'Comet Crash',
  'skill.drakelet.comet-crash.desc':
    'Climbs, tucks its wings, and falls like a burning star. The landing is not subtle.',
  'skill.emberfox.flame-dart.name': 'Flame Dart',
  'skill.emberfox.flame-dart.desc':
    'Spits a zippy bolt of foxfire that pops in a shower of sparks.',
  'skill.emberfox.ember-pounce.name': 'Ember Pounce',
  'skill.emberfox.ember-pounce.desc': 'A gleeful flaming pounce — equal parts play and ambush.',
  'skill.emberfox.tail-flare.name': 'Tail Flare',
  'skill.emberfox.tail-flare.desc':
    'Whirls its magnificent tail into a ring of cinders that singes everything nearby.',
  'skill.emberfox.foxfire-beam.name': 'Foxfire Beam',
  'skill.emberfox.foxfire-beam.desc':
    'Rears up and exhales a roaring ribbon of blue-white foxfire.',
  'skill.frostwing.frost-dart.name': 'Frost Dart',
  'skill.frostwing.frost-dart.desc':
    'Flicks a razor feather of ice that chills whatever it pricks.',
  'skill.frostwing.blizzard-wing.name': 'Blizzard Wing',
  'skill.frostwing.blizzard-wing.desc':
    'One mighty wingbeat whips up a stinging ring of snow around the owl.',
  'skill.frostwing.aurora-veil.name': 'Aurora Veil',
  'skill.frostwing.aurora-veil.desc':
    'Weaves shimmering polar light overhead that gently mends allies beneath it.',
  'skill.frostwing.comet-dive.name': 'Comet Dive',
  'skill.frostwing.comet-dive.desc':
    'Folds its wings and falls like a frozen star. Impact included, free of charge.',
  'skill.galebird.gust-dart.name': 'Gust Dart',
  'skill.galebird.gust-dart.desc':
    'Snaps its wings shut and flings a whistling blade of compressed air.',
  'skill.galebird.skyshear-dive.name': 'Skyshear Dive',
  'skill.galebird.skyshear-dive.desc':
    'Folds into a teardrop and shears past the target, wingtips slicing like scissors.',
  'skill.galebird.tailwind.name': 'Tailwind',
  'skill.galebird.tailwind.desc':
    'Carves a lazy circle overhead, kicking up a tailwind that hurries the whole team along.',
  'skill.galebird.cyclone-waltz.name': 'Cyclone Waltz',
  'skill.galebird.cyclone-waltz.desc':
    'Spins a pirouette so fast the sky joins in, wrapping everything nearby in a shrieking tornado.',
  'skill.lumimoth.glimmer-dart.name': 'Glimmer Dart',
  'skill.lumimoth.glimmer-dart.desc':
    'Flicks a needle of condensed moonlight from a wingtip. Travels fast, stings brighter.',
  'skill.lumimoth.prismbeam.name': 'Prismbeam',
  'skill.lumimoth.prismbeam.desc':
    'Focuses lantern-light through shimmering wings into a piercing ray of dawn.',
  'skill.lumimoth.dust-waltz.name': 'Dust Waltz',
  'skill.lumimoth.dust-waltz.desc':
    'A twirling blizzard of luminous wing-dust that dazzles everything nearby.',
  'skill.lumimoth.lantern-blessing.name': 'Lantern Blessing',
  'skill.lumimoth.lantern-blessing.desc':
    'The abdomen-lantern flares with gentle warmth, mending wounds in its soft halo.',
  'skill.sparkit.static-zap.name': 'Static Zap',
  'skill.sparkit.static-zap.desc':
    'Flicks a stinging bead of static off its cheek spots. Cheap, cheerful, and mildly rude.',
  'skill.sparkit.volt-dash.name': 'Volt Dash',
  'skill.sparkit.volt-dash.desc':
    'Blinks forward in a crackle of afterimages and shoulder-checks the target at full charge.',
  'skill.sparkit.thunder-coil.name': 'Thunder Coil',
  'skill.sparkit.thunder-coil.desc':
    'Winds its zigzag tail like a spring, then releases a snapping ring of lightning around itself.',
  'skill.sparkit.gigavolt-crash.name': 'Gigavolt Crash',
  'skill.sparkit.gigavolt-crash.desc':
    'Every stripe on its back lights up as it fires a searing bolt-beam straight down the line.',
  'skill.sproutle.leaf-flick.name': 'Leaf Flick',
  'skill.sproutle.leaf-flick.desc':
    'Snaps its head forward and flings a spinning razor leaf that whistles as it flies.',
  'skill.sproutle.shell-spin.name': 'Shell Spin',
  'skill.sproutle.shell-spin.desc':
    'Tucks in tight and whirls like a leafy top, batting away everything within reach.',
  'skill.sproutle.verdant-veil.name': 'Verdant Veil',
  'skill.sproutle.verdant-veil.desc':
    'The head-sprout spins up like a propeller, showering allies in glittering pollen that mends wounds.',
  'skill.sproutle.bramble-burst.name': 'Bramble Burst',
  'skill.sproutle.bramble-burst.desc':
    'Stomps its stubby feet and erupts a ring of snapping thorn vines from the earth around it.',
  'skill.umbrakit.gloom-bolt.name': 'Gloom Bolt',
  'skill.umbrakit.gloom-bolt.desc':
    'Coughs up a purring orb of night that unravels into claws on impact.',
  'skill.umbrakit.phantom-claw.name': 'Phantom Claw',
  'skill.umbrakit.phantom-claw.desc':
    'Its paw never moves — the shadow of the paw does the raking.',
  'skill.umbrakit.veil-of-dusk.name': 'Veil of Dusk',
  'skill.umbrakit.veil-of-dusk.desc':
    'Pulls the evening over itself like a blanket and dares the world to find it.',
  'skill.umbrakit.midnight-bloom.name': 'Midnight Bloom',
  'skill.umbrakit.midnight-bloom.desc':
    'Plants a seed of midnight underfoot; it blooms into a garden of grasping shadows.',

  // ---- wild enemies --------------------------------------------------------
  // Keyed by the EnemySpeciesId in src/combat/enemies.ts. Nothing renders these
  // yet — the kill is reported on the bus and only the XP is read — so they are
  // here so that whatever renders one FIRST is already translated.
  'enemy.gloopling.name': 'Gloopling',
  'enemy.snortle.name': 'Snortle',
  'enemy.peckit.name': 'Peckit',

  // ---- HUD ---------------------------------------------------------------
  'hud.hp': 'HP',
  'hud.level': 'Lv {n}',
  'hud.levelUp': 'LEVEL UP',
  'hud.levelUpReached': '{beast} reached Lv {level}!',
  // {skill} arrives already wrapped in its own emphasis markup, so the
  // translation decides where in the sentence the skill name lands.
  'hud.levelUpLearned': '{beast} reached Lv {level} — learned {skill}!',
  'hud.mountHold': 'HOLD {key} TO MOUNT',
  'hud.riding': 'RIDING {beast} · tap {dismount} to dismount',
  'hud.ridingFlying': 'RIDING {beast} · {altitude} altitude · tap {dismount} to dismount',

  // ---- hints -------------------------------------------------------------
  // The hint pill is HTML, and `{key}` arrives already wrapped in `<kbd>` — the
  // same shape the riding badge and the shop footer use. It used to be plain
  // text that the HUD then ran `/\bPress (\S+)/` over to find the key cap in,
  // which worked in English and produced an unstyled key in every other
  // language. A translation puts `{key}` wherever its own grammar wants it.
  'hint.skillDen': 'Press {key} — Skill Den',
  // {name} is an NPC's display name. Composed once per NPC and cached, not
  // rebuilt per frame — see the hint cache in main.ts.
  'hint.npcTalk': 'Press {key} — Talk to {name}',
  // The gateway countdown. ONE key each rather than "Entering " + name + "… " +
  // pct + "%": Swedish wants the verb and the destination in the other order,
  // and there is nowhere in a concatenation for a translator to stand.
  'hint.zoneEntering': 'Entering {zone}… {pct}%',
  'hint.zoneStand': 'Stand in the gateway — {zone}',

  // ---- dialogue ------------------------------------------------------------
  // The talk panel's footer. `{key}` arrives already wrapped in <kbd>, like
  // every other key cap since the `Press (\S+)` regex went away.
  'npc.dialogue.close': '{key} to leave',

  // ---- shop --------------------------------------------------------------
  'shop.skillDen.title': 'Skill Den',
  'shop.forBeast': 'for {beast}',
  'shop.learned': 'Learned',
  'shop.buy': 'BUY',
  'shop.stat.power': 'PWR',
  'shop.stat.cooldown': 'CD',
  'shop.foot.move': '{key} move',
  'shop.foot.jump': '{key} jump',
  'shop.foot.attack': '{key} attack',
  'shop.foot.skills': '{key} skills',
  'shop.foot.swap': '{key} swap beast',
  'shop.foot.interact': '{key} interact',

  // ---- toasts ------------------------------------------------------------
  'toast.welcome.desktop': 'Welcome to Beast Story! Click to play.',
  'toast.welcome.touch': 'Welcome to Beast Story! Left stick moves, right stick looks.',
  'toast.controls.desktop':
    'WASD move · Space jump · LMB attack · 1-4 skills · hold F to ride · Tab swap · E shop',
  'toast.controls.touch':
    'Left stick moves · right stick looks · ATK / JUMP / USE · 1-4 skills · SWAP',
  // Face names rather than the {key} placeholder the HUD prompts use, because
  // this is one flat sentence and threading eight glyph substitutions through it
  // would cost every translator eight chances to lose one. The pad's own glyph
  // table (core/gamepad.ts) is what the HUD prints where the layout matters.
  'toast.controls.gamepad':
    'Left stick moves · right stick looks · A jump · RT attack · D-pad skills · hold Y to ride · L3 swap · X shop',
  'toast.enteredZone': 'Entered {zone}',
  'toast.beastLeads': '{lead} leads · {support} supports',
  'toast.beastTakesLead': '{beast} takes the lead!',
  'toast.dismountFirst': 'Dismount first (tap F).',
  'toast.fetched': '{beast} fetched {item} ({n})',
  'toast.learnedSkill': '{beast} learned {skill}!',
  'toast.fainted': 'You fainted!',
  'toast.revived': 'Back on your feet!',

  // ---- mounting ------------------------------------------------------------
  // The beast's name lands INSIDE each of these, which is the whole reason they
  // are one key apiece with a `{beast}` placeholder rather than a name glued to a
  // fixed tail. These surfaced with the species rename: `mount.ts` was building
  // them out of `species.name`.
  'toast.mount.flying': '{beast} spreads its wings — hold on!',
  'toast.mount.ground': "{beast} kneels — you're in the saddle!",
  'toast.dismounted': 'Dismounted {beast}',
  'toast.mount.beastDown': '{beast} is down!',
  'toast.mount.refuse.swimming': 'Too deep to mount — get out of the water first.',
  'toast.mount.refuse.climbing': 'Not while you are on the wall.',
  'toast.mount.refuse.beastDead': '{beast} is in no shape to carry you.',
  'toast.mount.refuse.noBeast': 'No beast to ride.',
  'toast.mount.refuse.other': 'Not now.',

  // ---- fullscreen offer (touch devices only) -------------------------------
  'fs.prompt': 'Play fullscreen?',
  'fs.yes': 'YES',
  'fs.no': 'NO',

  // ---- touch overlay buttons -----------------------------------------------
  // Thumb-sized caps: 3-5 characters is what the button geometry in
  // src/core/touch.ts leaves room for, and a longer word will overflow rather
  // than resize the button. Abbreviate rather than translate literally.
  'touch.move': 'MOVE',
  'touch.look': 'LOOK',
  'touch.attack': 'ATK',
  'touch.jump': 'JUMP',
  'touch.interact': 'USE',
  'touch.swap': 'SWAP',

  // ---- start menu ----------------------------------------------------------
  // The title screen in src/ui/menu.ts. The game's own name is deliberately NOT
  // here: it is the logo artwork (src/ui/menu-logo.webp), which is a picture of
  // the words and cannot be translated by editing this file. `menu.title` is the
  // logo's alt text, which is all a screen reader gets of it.
  'menu.title': 'Beast Story: Bonds of Red',
  'menu.pressStart': 'Press start...',
  'menu.newGame': 'New Game',
  'menu.load': 'Load',
  /** Sits under Load, which is inert until there is a save system to load from. */
  'menu.load.unavailable': 'No saved game',
  'menu.settings': 'Settings',
  'menu.back': 'Back',
  'menu.settings.title': 'Settings',
  /**
   * Says "controller" rather than "haptics" or "rumble" on purpose: it is the
   * word on the box, and the row has to be recognisable by someone who opened
   * Settings because their pad keeps buzzing.
   */
  'menu.settings.hapticFeedback': 'Enable Controller Vibration',
  'menu.settings.invertX': 'Invert look X',
  'menu.settings.invertY': 'Invert look Y',
  /** Both toggles are pad-only, and saying so stops them reading as mouse bugs. */
  'menu.settings.controllerNote': 'Controller only — the mouse is never inverted.',
  'menu.settings.language': 'Language',
  'menu.on': 'ON',
  'menu.off': 'OFF',
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
