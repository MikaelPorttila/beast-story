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
  "item.shard.one": "Cubloon",
  "item.shard.other": "Cubloons",
  "item.sunberry.one": "Sunberry",
  "item.sunberry.other": "Sunberries",
  "item.glowpebble.one": "Glow Pebble",
  "item.glowpebble.other": "Glow Pebbles",
  "item.sunberry.desc": "Sweet enough to be worth the thorns. Traders take them by the handful.",
  "item.glowpebble.desc": "Cold to hold, and bright enough to read by once your eyes settle.",
  "item.swordIron.one": "Iron Sword",
  "item.swordIron.other": "Iron Swords",
  "item.swordIron.desc":
    "Plain, balanced and honest. Everyone in Embervale learns on one of these.",
  "item.greatswordIron.one": "Iron Greatsword",
  "item.greatswordIron.other": "Iron Greatswords",
  "item.greatswordIron.desc": "Two hands, one intention. Slow to bring round, hard to argue with.",
  "item.bowAsh.one": "Ashwood Bow",
  "item.bowAsh.other": "Ashwood Bows",
  "item.bowAsh.desc": "Cut from a tree that came down in the storm. The limbs still remember it.",
  "item.scytheReaper.one": "Reaper's Scythe",
  "item.scytheReaper.other": "Reaper's Scythes",
  "item.scytheReaper.desc":
    "Farm tool by shape only. Something has been sharpening it for a long time.",
  "item.daggerQuick.one": "Quickfang",
  "item.daggerQuick.other": "Quickfangs",
  "item.daggerQuick.desc": "Short, light and already moving before you decide to use it.",
  "item.bpSword.one": "Sword Blueprint",
  "item.bpSword.other": "Sword Blueprints",
  "item.bpGreatsword.one": "Greatsword Blueprint",
  "item.bpGreatsword.other": "Greatsword Blueprints",
  "item.bpBow.one": "Bow Blueprint",
  "item.bpBow.other": "Bow Blueprints",
  "item.bpScythe.one": "Scythe Blueprint",
  "item.bpScythe.other": "Scythe Blueprints",
  "item.bpDagger.one": "Dagger Blueprint",
  "item.bpDagger.other": "Dagger Blueprints",
  // One blurb for all five: what a blueprint IS does not change with its shape,
  // and the shape is on the icon and in the name already.
  "item.bp.desc":
    "A pattern waiting for Cubloons. Fill it with attributes and the forge makes it real.",
  "item.potionMend.one": "Mending Draught",
  "item.potionMend.other": "Mending Draughts",
  "item.potionMend.desc": "Tastes of iron and moss. The ache goes before the taste does.",
  "item.potionFury.one": "Draught of Fury",
  "item.potionFury.other": "Draughts of Fury",
  "item.potionFury.desc":
    "Brief, loud and slightly regrettable. Everything hits harder for half a minute.",
  // The four taming orbs. Their NAMES say what they do to a beast — bond, not
  // catch — because that is the word the campaign uses for it everywhere (see
  // game-story.md §1); the ids stay plain (`orb-tame`) so a rename is an edit to
  // this file and nothing else.
  "item.orbTame.one": "Tame Orb",
  "item.orbTame.other": "Tame Orbs",
  "item.orbTame.desc":
    "Red glass around a coil of thread. Enough for a small animal that has already given up.",
  "item.orbGreater.one": "Greater Tame Orb",
  "item.orbGreater.other": "Greater Tame Orbs",
  "item.orbGreater.desc": "Blue, and heavier than it looks. The thread inside is wound twice.",
  "item.orbUltra.one": "Ultra Tame Orb",
  "item.orbUltra.other": "Ultra Tame Orbs",
  "item.orbUltra.desc": "Violet, and warm at the seam. Bridle work, whatever the trader tells you.",
  "item.orbMaster.one": "Master Tame Orb",
  "item.orbMaster.other": "Master Tame Orbs",
  "item.orbMaster.desc":
    "Black glass that gives nothing back. Very few of these were ever made, and nobody says by whom.",
  "item.redShard.one": "Red Shard",
  "item.redShard.other": "Red Shards",
  "item.redShard.desc":
    "Cut, not broken — one edge of it was finished by a tool. The red thread through the middle is still warm.",
  "item.gainToken.one": "Gain's Token",
  "item.gainToken.other": "Gain's Tokens",
  "item.gainToken.desc":
    "A carved weight on a cord. Given, not found, and not yours to throw away.",

  // ---- inventory -----------------------------------------------------------
  "inv.title": "Inventory",
  "inv.tab.all": "All",
  "inv.tab.beast": "Beasts",
  "inv.tab.weapon": "Weapons",
  "inv.tab.blueprint": "Blueprints",
  "inv.tab.potion": "Potions",
  "inv.tab.stackable": "Materials",
  "inv.tab.quest": "Quest",
  "inv.tab.orb": "Orbs",
  "inv.gear": "Equipped",
  "inv.slot.weapon": "Weapon",
  "inv.slot.primary": "Lead beast",
  "inv.slot.support": "Support beast",
  "inv.slot.empty": "Empty",
  // The three mount badges under the gear strip. `inv.mount.locked` is the one
  // sentence a locked badge exists to say, so it names the reason rather than
  // restating the obvious — and it names no quest, because none of them ship
  // yet and a line pointing at one would send the player looking for it.
  "inv.mounts": "Riding",
  "inv.mount.unlocked": "Unlocked — hold F beside your lead beast.",
  "inv.mount.locked": "Locked. Story progress is required to unlock this.",
  "inv.pick": "Select an item to see what it does.",
  "inv.equip": "Equip",
  "inv.equipped": "Equipped",
  "inv.unequip": "Unequip",
  "inv.use": "Use",
  "inv.salvage": "Salvage",
  "inv.drop": "Drop",
  "inv.forge": "Forge",
  "inv.forge.soon": "The forge is not built yet — the blueprint keeps until it is.",
  "inv.quest.kept": "A quest item stays with you. It cannot be dropped or salvaged.",
  "inv.stat.power": "Power",
  "inv.stat.budget": "Power budget",
  "inv.stat.heal": "Restores",
  "inv.stat.attack": "Attack",
  "inv.stat.level": "Level",
  "inv.stat.movement": "Movement",
  "inv.stat.salvage": "Worth",
  "inv.stat.held": "Held",
  "inv.stat.orbTier": "Orb grade",
  "shop.stat.held": "You hold",
  "inv.rarity.common": "Common",
  "inv.rarity.rare": "Rare",
  "inv.rarity.legendary": "Legendary",
  "inv.beast.lead": "Leading",
  "inv.beast.support": "Supporting",
  "inv.beast.benched": "Benched",
  // What stands in for a beast's name where a slot is empty. One string rather
  // than a branch at each site: four surfaces print a party slot, and "nobody"
  // is a display word like any other.
  "beast.none": "nobody",
  "inv.setLead": "Send in front",
  "inv.setSupport": "Send to support",
  "inv.slot.orb": "Taming orb",
  "inv.ready": "Ready to throw",
  "inv.unready": "Put away",
  // The orb slot's own line, for the same reason the blueprint has one: a player
  // holding an orb and no way to throw it should be told the key, not left to
  // find it on the F1 sheet.
  "inv.orb.hint": "Readied. Press {key} to throw it at a weakened beast.",
  // ---- quest journal -------------------------------------------------------
  "journal.title": "Journal",
  "journal.tab.active": "Active",
  "journal.tab.available": "Offered",
  "journal.tab.completed": "Done",
  // The category, printed on the card. Two words rather than a colour alone: a
  // player who cannot tell a story quest from an errand is being asked to guess
  // which one the game will wait for.
  "journal.main": "Main",
  "journal.side": "Side",
  // The HUD toggle, which is one button with two labels rather than a checkbox:
  // the label says what the state IS, and pressing it flips to the other.
  "journal.hud.on": "Showing on screen",
  "journal.hud.off": "Show on screen",
  "journal.empty.active":
    "Nothing on the go. Talk to the people you pass — someone always needs something.",
  "journal.empty.available": "No one is offering work just now.",
  "journal.empty.completed": "Nothing finished yet.",
  // Rewards, keyed by what is granted. Anything that is not `xp` is an item and
  // is named from the item table instead — see `rewardLines` in main.ts.
  "journal.reward.xp": "XP",

  // ---- the campaign: Act 1, Land (game-story.md §4, issue #143) -------------
  // Keyed by the quest id with the slash dropped and the name camel-cased:
  // `quest:land/first-light` -> `quest.land.firstLight`. Objectives hang off
  // `.obj.<objectiveKey>` in the same camel case — the KEY in the asset is the
  // save identifier and never changes, these are the words and may.
  "quest.land.firstLight.name": "First Light",
  "quest.land.firstLight.desc":
    "Gain has been up since before you were, and there is a penned Sproutle standing between you and breakfast.",
  "quest.land.firstLight.obj.talkToGain": "Speak with Gain at the fire",
  // "Practise the throw" read as a melee swing. An objective names the VERB the
  // player is being asked for, and the verb here is taming — the orb is how you
  // tame, so the orb is what the line says.
  "quest.land.firstLight.obj.bondPractice": "Throw taming orbs at the penned Sproutle",
  "quest.land.theFirstBond.name": "The First Bond",
  "quest.land.theFirstBond.desc":
    "A penned animal has already agreed. Gain wants you to go past the wall and ask one that has not.",
  "quest.land.theFirstBond.obj.tameWild": "Bond a wild beast beyond the camp wall",
  "quest.land.theMillRoad.name": "The Mill Road",
  "quest.land.theMillRoad.desc":
    "Mera Ashgrove's oxen have turned and the drove road is not safe. Walk it anyway — Gain says you will understand the valley better on your feet than you ever will from a saddle.",
  "quest.land.theMillRoad.obj.reachRedbriar": "Follow the drove road to Redbriar Mill",
  // "Corrupted" is the valley's word for it, and nobody in Act 1 has a better
  // one — which is the point of the beat, so the objective does not explain it.
  "quest.land.theMillRoad.obj.cullCorrupted": "Put down corrupted beasts on the road",
  "quest.land.theRedThread.name": "The Red Thread",
  "quest.land.theRedThread.desc":
    "Whatever turned Mera's oxen came up out of the millrace. The Sunken Hold is where the water comes from, and something down there is holding an animal by its bond.",
  "quest.land.theRedThread.obj.enterTheHold": "Go down into the Sunken Hold",
  // The objective names what you DO — the thread is wound onto something, and
  // that something is what you fight. The animal itself is never touched.
  "quest.land.theRedThread.obj.freeTheSproutle": "Cut the Sproutle loose from what is holding it",
  "quest.land.theRedThread.obj.recoverShard": "Recover the shard beside it",
  "toast.equipped": "{item} equipped",
  "toast.unequipped": "{item} put away",
  // `{currency}` rather than the word: the currency's name is one entry in this
  // file and a sentence that spelled it out would be a second, silent copy.
  "toast.salvaged": "Salvaged {item} for {n} {currency}",
  "toast.dropped": "Dropped {item}",
  "toast.used": "{item} used",
  "toast.buffEnded": "The draught wears off",
  "toast.gotItem": "Received {item}",
  // The bond. The first one gets its own line because it is the moment the game
  // stops being one person with a sword.
  "toast.bought": "Bought {item}",
  "toast.orbReady": "{item} ready to throw",
  "toast.bonded": "{beast} is bonded to you",
  "toast.bondedFirst": "{beast} is bonded to you — your first",
  "toast.bondFailed": "The orb broke. {beast} is loose again",
  "toast.orbNone": "Ready a taming orb in your bag first",
  "toast.orbNoTarget": "Aim at a wild beast before you throw",
  "toast.orbNotBondable": "That one cannot be bonded",
  "toast.orbAlreadyOwned": "{beast} is already bonded to you",
  // One per mount kind, because what the story hands over is the RIDING of a
  // kind of animal and each act hands over a different one (game-story.md §5).
  "toast.mountUnlocked.ground": "You may ride a ground beast — hold F beside your lead beast",
  "toast.mountUnlocked.water": "You may ride a swimming beast — hold F beside your lead beast",
  "toast.mountUnlocked.flying": "You may ride a flying beast — hold F beside your lead beast",

  // ---- zones -------------------------------------------------------------
  // Keyed by the ZoneDef id in main.ts ('overworld', 'hold').
  "zone.overworld.name": "Embervale",
  "zone.hold.name": "The Sunken Hold",

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
  "town.encampment.name": "The Encampment",
  "town.encampment.sign": "ENCAMPMENT",
  "town.redbriar.name": "Redbriar Mill",
  "town.redbriar.sign": "REDBRIAR",
  "town.stonewatch.name": "Stonewatch",
  "town.stonewatch.sign": "STONEWATCH",
  /**
   * SKYHAVEN — the town that flies (issue #68). A settlement like any other as
   * far as this table is concerned; that it is carried rather than sited is
   * `"carried": true` on the asset, not a property of its name.
   *
   * It has a `.sign` because every town does and the field is required, and
   * nothing carves it: there is no road to the island and therefore no
   * fingerpost to name it on. Kept inside the 3x5 font's alphabet anyway, so
   * the day something does carve it there is nothing to fix.
   */
  "town.skyhaven.name": "Skyhaven",
  "town.skyhaven.sign": "SKYHAVEN",
  /** The fork the road network hangs off — a sign, but not a town. */
  "town.junction.sign": "CROSSWAY",

  // ---- NPCs ----------------------------------------------------------------
  // Keyed by the NpcCharacter id in src/world/npc-gain.ts. The id ('gain') is
  // what `talk(id)` takes, what the hint cache keys on and what a quest will
  // store; the name and the line are display and live here.
  //
  // If a name ever has to reach a fingerpost or any other carved sign, mind the
  // 3x5 voxel font — A-Z, 0-9, '-', an apostrophe and a space, see the `.sign`
  // note above. 'Gain' is inside it; a translated one might not be.
  "npc.gain.name": "Deckard Gains Armstrong",
  "npc.gain.greeting": "Hello, my friend. Stay awhile and... gain some knowledge.",
  // Gain's campaign lines. One row per quest STATE — offer, busy, done — because
  // an `NpcTalkLine` is chosen by condition and the first match wins, so the
  // dialogue's branching lives in the data and this table only holds the words.
  // See `npc:gain`'s `talk` list in content/data/core.json.
  "npc.gain.q1.offer":
    "You slept through the interesting part. There is a Sproutle in the pen and three taming orbs in your hand — throw them at it, and stop flinching.",
  "npc.gain.q1.busy": "Three orbs, at the Sproutle. It will not bite, and I will not laugh. Much.",
  "npc.gain.q1.done":
    "There. That is the whole trick — the orb does nothing an animal has not already agreed to.",
  "npc.gain.q2.offer":
    "Penned is not the same as willing. Go past the wall and find one that can say no to you, and see if it does.",
  "npc.gain.q2.busy": "Out there. Not in here. It has to be one that chose you.",
  "npc.gain.q2.done":
    "Then you have a partner and I have my morning back. Keep it fed and it will keep you upright.",
  "npc.gain.q3.offer":
    "Word came up the road from Redbriar: Mera's oxen have turned on her. Walk it — the whole way, on your own feet. Whatever is doing this, you will pass six of it before the mill, and I want it dead behind you.",
  "npc.gain.q3.busy":
    "The road, not the shortcut. Six of them down, and Mera at the other end of it.",

  // Redbriar's miller. She closes The Mill Road (issue #149) — the quest Gain
  // offers and she ends, which is what `turnIn` on the asset says. Her own
  // quest, The Red Thread, is issue #150 and adds its rows beside these.
  "npc.mera.name": "Mera Ashgrove",
  "npc.mera.greeting":
    "Mind the race when you pass it. The water has been running wrong since spring and I have stopped pretending I know why.",
  "npc.mera.q3.busy":
    "You made it. Good. There are more of them out on the drove ground, and I am not sleeping until there are fewer.",
  "npc.mera.q4.offer":
    "The race runs up from the Sunken Hold, and whatever is in my beasts came up it. I am not going down there. You have an animal that chose you — go and see what is holding the ones that did not.",
  "npc.mera.q4.busy":
    "Down, and keep going down. If something is tied to it, cut it loose and bring me what it was tied with.",
  "npc.mera.q4.done":
    "That is not a stone. Look at the edge — somebody CUT that, and the thread is still warm. This was never a sickness. Take it to Stonewatch; Warden Coil has been asking after things exactly like it.",
  "npc.mera.q3.done":
    "Six of them, and you walked every step of it. Then stop walking — that beast of yours has been keeping your pace all day and it never once had to. Get up on it. You will want the speed before this is finished.",

  // The three who live on Skyhaven. Their lines are the one place the game
  // explains what the island IS, so each of them says a different part of it:
  // that it moves, that it is lived on, and that it is worth being up here for.
  "npc.skyPilot.name": "Corwin Vane",
  "npc.skyPilot.greeting":
    "She drifts where the warm air takes her. I only ask her not to drift into a mountain.",
  "npc.skyGardener.name": "Mother Pell",
  "npc.skyGardener.greeting":
    "Soil this thin, and every root has to hold on twice — once for itself, once for the rest of us.",
  "npc.skyLamplighter.name": "Tobin Ashgrove",
  "npc.skyLamplighter.greeting":
    "Mind the rim after dark. I light the lamps so you can see the edge, not so you can stand on it.",

  // ---- beast species -------------------------------------------------------
  // Keyed by the species id in src/beasts/species/*.ts. The id is what the roster,
  // the ?beast= capture parameter, /mount and every save key on; the name and the
  // flavour blurb are display and live here.
  "beast.aquaxol.name": "Aquaxol",
  "beast.aquaxol.desc":
    "A perpetually smiling axolotl that waddles on land and ripples through water, gills fluttering like party streamers.",
  "beast.boulderpup.name": "Boulderpup",
  "beast.boulderpup.desc":
    "A puppy chiseled from mountain strata by a very sentimental earthquake. Moss grows where it naps too long, and the amber crystal on its back glows brighter the happier it gets.",
  "beast.coralback.name": "Coralback",
  "beast.coralback.desc":
    "A sea turtle so unhurried that a reef moved onto its back and stayed. It has outlasted three shipwrecks and one empire, and it will outlast whatever is chasing you.",
  "beast.drakelet.name": "Drakelet",
  "beast.drakelet.desc":
    "A pocket-sized dragon with the ego of a mountain-sized one. Polishes its ember-crimson scales on cliff quartz and practices its roar at sunrise, every sunrise.",
  "beast.emberfox.name": "Emberfox",
  "beast.emberfox.desc":
    "An eager little fox whose oversized tail smolders when it is excited — which is always.",
  "beast.finnick.name": "Finnick",
  "beast.finnick.desc":
    "A porpoise pup with a permanent grin and no concept of a straight line. The fastest thing in the water and, on dry land, an enthusiastic disaster.",
  "beast.frostwing.name": "Frostwing",
  "beast.frostwing.desc":
    "A snowy owl born in the heart of a glacier. It drifts on silent wings, watching everything with polite, unblinking curiosity, and its speckles glitter like fresh frost at dawn.",
  "beast.galebird.name": "Galebird",
  "beast.galebird.desc":
    "A wind-stitched swallow that treats gravity as a polite suggestion — the fastest wings in the valley.",
  "beast.graveback.name": "Graveback",
  "beast.graveback.desc":
    "Something the barrow kept for itself. Its own ribs have grown out through its back and the shroud they buried it in is still knotted over its shoulders, and it walks with its skull down like a dog that has caught a scent it will follow until one of you stops.",
  "beast.graveborn.name": "Graveborn",
  "beast.graveborn.desc":
    "A soldier who never got the order to stand down. Two hundred years in the wet ground took the flesh, the name and the war, and left the drill, the belt and the sword — and a cold blue light still burning in the sockets, waiting to be told where to stand.",
  "beast.lanternfin.name": "Lanternfin",
  "beast.lanternfin.desc":
    "An anglerfish that swam up out of the black water with its lamp still burning. It has never seen the sun and remains unconvinced by it.",
  "beast.lumimoth.name": "Lumimoth",
  "beast.lumimoth.desc":
    "A radiant moth that drifts between lantern posts at dusk, its glowing tail-light said to guide lost travelers home. Collects starlight on its wing-spots.",
  "beast.rivotter.name": "Rivotter",
  "beast.rivotter.desc":
    "A river otter built entirely out of enthusiasm and one very long spine. Gallops badly, swims magnificently, and will not stop showing you rocks.",
  "beast.sparkit.name": "Sparkit",
  "beast.sparkit.desc":
    "A hyperactive spark rodent that physically cannot sit still. Its tall zigzag tail is a living lightning rod, and its cheek spots crackle whenever it gets excited — so, always.",
  "beast.snapclaw.name": "Snapclaw",
  "beast.snapclaw.desc":
    "A hermit crab in a spiral shell two sizes too grand for it. Carries its house up the beach, into the surf and out the other side, and has strong opinions about fingers.",
  "beast.sproutle.name": "Sproutle",
  "beast.sproutle.desc":
    "A round mossy turtle-dino whose shell is a garden of overlapping leaf plates. It plods along at its own unhurried pace, head-sprout bobbing, utterly unbothered by anything.",
  "beast.umbrakit.name": "Umbrakit",
  "beast.umbrakit.desc":
    "A hovering wisp of a cat woven from dusk. Its tail keeps drifting apart and lazily reassembling.",

  // ---- skills --------------------------------------------------------------
  // Keyed by the SkillDef id, which is already namespaced by species and is what
  // the hotbar, the cooldown map and the shop's "already learned" test key on.
  "skill.aquaxol.bubble-pop.name": "Bubble Pop",
  "skill.aquaxol.bubble-pop.desc":
    "Blows a wobbling bubble that bursts with a surprisingly rude POP.",
  "skill.aquaxol.tide-swirl.name": "Tide Swirl",
  "skill.aquaxol.tide-swirl.desc":
    "Spins its paddle tail to whip up a chilly whirlpool around itself.",
  "skill.aquaxol.soothing-slime.name": "Soothing Slime",
  "skill.aquaxol.soothing-slime.desc":
    "Sheds a film of regenerative slime that patches up nearby friends. Slightly gross, extremely effective.",
  "skill.aquaxol.hydro-jet.name": "Hydro Jet",
  "skill.aquaxol.hydro-jet.desc":
    "Gulps, aims, and fires a pressure-washer stream of water. Do not stand in front of the smile.",
  "skill.boulderpup.pebble-pop.name": "Pebble Pop",
  "skill.boulderpup.pebble-pop.desc": "Sneezes a hot pebble at surprising velocity. Bless you.",
  "skill.boulderpup.stomp-quake.name": "Stomp Quake",
  "skill.boulderpup.stomp-quake.desc":
    "Slams all four paws down at once; the ground complains loudly.",
  "skill.boulderpup.moss-mantle.name": "Moss Mantle",
  "skill.boulderpup.moss-mantle.desc":
    "Fluffs up its back-moss into a springy cushion that soaks up scrapes.",
  "skill.boulderpup.amber-avalanche.name": "Amber Avalanche",
  "skill.boulderpup.amber-avalanche.desc":
    "The back-crystal flares white-hot and hurls a fan of molten amber boulders.",
  "skill.coralback.shell-slam.name": "Shell Slam",
  "skill.coralback.shell-slam.desc":
    "Puts its whole borrowed continent behind one shove. Nothing about it is fast and nothing about it needs to be.",
  "skill.coralback.brine-bubble.name": "Brine Bubble",
  "skill.coralback.brine-bubble.desc":
    "Coughs up a wobbling sphere of seawater that travels with great dignity and lands with none.",
  "skill.coralback.reef-guard.name": "Reef Guard",
  "skill.coralback.reef-guard.desc":
    "The coral on its back flares, and everything standing close enough gets a share of four centuries of not dying.",
  "skill.coralback.tide-anchor.name": "Tide Anchor",
  "skill.coralback.tide-anchor.desc":
    "Spins low and drags the whole tide round with it. Whatever was standing there is now standing somewhere else.",
  "skill.drakelet.fang-rush.name": "Fang Rush",
  "skill.drakelet.fang-rush.desc":
    "Darts in with a snap of needle fangs and far too much confidence for its size.",
  "skill.drakelet.drakefire-breath.name": "Drakefire Breath",
  "skill.drakelet.drakefire-breath.desc":
    "Puffs up its chest, inhales the whole sky, and exhales a rolling cone of ember-red dragonfire.",
  "skill.drakelet.tailspin-tempest.name": "Tailspin Tempest",
  "skill.drakelet.tailspin-tempest.desc":
    "Whirls its arrow-tipped tail into a shredding cyclone that batters everything in reach.",
  "skill.drakelet.comet-crash.name": "Comet Crash",
  "skill.drakelet.comet-crash.desc":
    "Climbs, tucks its wings, and falls like a burning star. The landing is not subtle.",
  "skill.emberfox.flame-dart.name": "Flame Dart",
  "skill.emberfox.flame-dart.desc":
    "Spits a zippy bolt of foxfire that pops in a shower of sparks.",
  "skill.emberfox.ember-pounce.name": "Ember Pounce",
  "skill.emberfox.ember-pounce.desc": "A gleeful flaming pounce — equal parts play and ambush.",
  "skill.emberfox.tail-flare.name": "Tail Flare",
  "skill.emberfox.tail-flare.desc":
    "Whirls its magnificent tail into a ring of cinders that singes everything nearby.",
  "skill.emberfox.foxfire-beam.name": "Foxfire Beam",
  "skill.emberfox.foxfire-beam.desc":
    "Rears up and exhales a roaring ribbon of blue-white foxfire.",
  "skill.finnick.sonar-ping.name": "Sonar Ping",
  "skill.finnick.sonar-ping.desc":
    "A click you feel in your teeth from fifteen metres. It is aimed, it is fast, and it is very pleased with itself.",
  "skill.finnick.breach.name": "Breach",
  "skill.finnick.breach.desc":
    "Leaves the water entirely, turns over once, and comes down on whatever it was looking at.",
  "skill.finnick.wake-spiral.name": "Wake Spiral",
  "skill.finnick.wake-spiral.desc":
    "Circles hard enough to leave a standing whirlpool behind. Getting out of it is a separate problem.",
  "skill.finnick.echo-song.name": "Echo Song",
  "skill.finnick.echo-song.desc":
    "Sings one long note that everyone nearby feels rather than hears, and stands up a little straighter for.",
  "skill.frostwing.frost-dart.name": "Frost Dart",
  "skill.frostwing.frost-dart.desc":
    "Flicks a razor feather of ice that chills whatever it pricks.",
  "skill.frostwing.blizzard-wing.name": "Blizzard Wing",
  "skill.frostwing.blizzard-wing.desc":
    "One mighty wingbeat whips up a stinging ring of snow around the owl.",
  "skill.frostwing.aurora-veil.name": "Aurora Veil",
  "skill.frostwing.aurora-veil.desc":
    "Weaves shimmering polar light overhead that gently mends allies beneath it.",
  "skill.frostwing.comet-dive.name": "Comet Dive",
  "skill.frostwing.comet-dive.desc":
    "Folds its wings and falls like a frozen star. Impact included, free of charge.",
  "skill.galebird.gust-dart.name": "Gust Dart",
  "skill.galebird.gust-dart.desc":
    "Snaps its wings shut and flings a whistling blade of compressed air.",
  "skill.galebird.skyshear-dive.name": "Skyshear Dive",
  "skill.galebird.skyshear-dive.desc":
    "Folds into a teardrop and shears past the target, wingtips slicing like scissors.",
  "skill.galebird.tailwind.name": "Tailwind",
  "skill.galebird.tailwind.desc":
    "Carves a lazy circle overhead, kicking up a tailwind that hurries the whole team along.",
  "skill.galebird.cyclone-waltz.name": "Cyclone Waltz",
  "skill.galebird.cyclone-waltz.desc":
    "Spins a pirouette so fast the sky joins in, wrapping everything nearby in a shrieking tornado.",
  "skill.graveback.bonecrush.name": "Bonecrush",
  "skill.graveback.bonecrush.desc":
    "Takes hold and leans. Nothing about the bite is fast and nothing about it lets go.",
  "skill.graveback.grave-howl.name": "Grave Howl",
  "skill.graveback.grave-howl.desc":
    "Lifts its skull and lets out a note with no throat behind it. Everything close enough remembers being buried.",
  "skill.graveback.rib-shard.name": "Rib Shard",
  "skill.graveback.rib-shard.desc":
    "Snaps a rib off its own flank and flings it. Another one has grown in by the time it lands.",
  "skill.graveback.barrow-tide.name": "Barrow Tide",
  "skill.graveback.barrow-tide.desc":
    "Plants its forelegs and hauls the cold up out of the ground. It comes when this one calls it.",
  "skill.graveborn.rusted-cleave.name": "Rusted Cleave",
  "skill.graveborn.rusted-cleave.desc":
    "Brings the old iron down in one flat, practised arc. It has made this cut ten thousand times and has never once hurried it.",
  "skill.graveborn.bone-shard.name": "Bone Shard",
  "skill.graveborn.bone-shard.desc":
    "Snaps a splinter off its own forearm and flings it. The arm knits itself back together on the walk over.",
  "skill.graveborn.grave-ward.name": "Grave Ward",
  "skill.graveborn.grave-ward.desc":
    "Drives the blade into the earth and lets the cold up through it. Everything standing on that ground feels the winter of it.",
  "skill.graveborn.last-rites.name": "Last Rites",
  "skill.graveborn.last-rites.desc":
    "Raises the sword and speaks a name nobody has said aloud in two centuries. The grave-light answers in a long blue line.",
  "skill.lanternfin.glimmer-mote.name": "Glimmer Mote",
  "skill.lanternfin.glimmer-mote.desc":
    "Flicks a bead of cold lamplight off the end of its rod. It drifts, and then it does not.",
  "skill.lanternfin.abyss-bite.name": "Abyss Bite",
  "skill.lanternfin.abyss-bite.desc":
    "The lamp goes out, and by the time it comes back on the biting has finished.",
  "skill.lanternfin.lure-glow.name": "Lure Glow",
  "skill.lanternfin.lure-glow.desc":
    "Turns the lamp on its own friends for once. Everything in the light remembers how to keep going.",
  "skill.lanternfin.deep-pulse.name": "Deep Pulse",
  "skill.lanternfin.deep-pulse.desc":
    "Pours a full lamp of abyssal light down one line. Nothing that lives up here is built for it.",
  "skill.lumimoth.glimmer-dart.name": "Glimmer Dart",
  "skill.lumimoth.glimmer-dart.desc":
    "Flicks a needle of condensed moonlight from a wingtip. Travels fast, stings brighter.",
  "skill.lumimoth.prismbeam.name": "Prismbeam",
  "skill.lumimoth.prismbeam.desc":
    "Focuses lantern-light through shimmering wings into a piercing ray of dawn.",
  "skill.lumimoth.dust-waltz.name": "Dust Waltz",
  "skill.lumimoth.dust-waltz.desc":
    "A twirling blizzard of luminous wing-dust that dazzles everything nearby.",
  "skill.lumimoth.lantern-blessing.name": "Lantern Blessing",
  "skill.lumimoth.lantern-blessing.desc":
    "The abdomen-lantern flares with gentle warmth, mending wounds in its soft halo.",
  "skill.rivotter.river-dart.name": "River Dart",
  "skill.rivotter.river-dart.desc":
    "Spits a needle of river water hard enough to whistle. It practises this constantly and wants you to know.",
  "skill.rivotter.otter-roll.name": "Otter Roll",
  "skill.rivotter.otter-roll.desc":
    "A full barrel roll straight through whatever is in the way, entirely delighted about it.",
  "skill.rivotter.slick-coat.name": "Slick Coat",
  "skill.rivotter.slick-coat.desc":
    "Sheds a film of river oil over its friends. Things slide off. That is the whole trick and it works.",
  "skill.rivotter.torrent-slide.name": "Torrent Slide",
  "skill.rivotter.torrent-slide.desc":
    "Opens a chute of white water and rides it, which is somehow both an attack and the most fun anyone is having.",
  "skill.sparkit.static-zap.name": "Static Zap",
  "skill.sparkit.static-zap.desc":
    "Flicks a stinging bead of static off its cheek spots. Cheap, cheerful, and mildly rude.",
  "skill.sparkit.volt-dash.name": "Volt Dash",
  "skill.sparkit.volt-dash.desc":
    "Blinks forward in a crackle of afterimages and shoulder-checks the target at full charge.",
  "skill.sparkit.thunder-coil.name": "Thunder Coil",
  "skill.sparkit.thunder-coil.desc":
    "Winds its zigzag tail like a spring, then releases a snapping ring of lightning around itself.",
  "skill.sparkit.gigavolt-crash.name": "Gigavolt Crash",
  "skill.sparkit.gigavolt-crash.desc":
    "Every stripe on its back lights up as it fires a searing bolt-beam straight down the line.",
  "skill.snapclaw.pincer-snap.name": "Pincer Snap",
  "skill.snapclaw.pincer-snap.desc":
    "One clap of the big claw. The sound arrives slightly after the damage does.",
  "skill.snapclaw.sand-spray.name": "Sand Spray",
  "skill.snapclaw.sand-spray.desc":
    "Spins on the spot and throws up a stinging wall of wet grit in every direction at once.",
  "skill.snapclaw.shell-up.name": "Shell Up",
  "skill.snapclaw.shell-up.desc":
    "Everyone gets a moment behind the house. It is cramped, it smells of low tide, and it holds.",
  "skill.snapclaw.brine-shot.name": "Brine Shot",
  "skill.snapclaw.brine-shot.desc":
    "Fires a jet of stored seawater through a gap in the shell. Rude, accurate, and startlingly far.",
  "skill.sproutle.leaf-flick.name": "Leaf Flick",
  "skill.sproutle.leaf-flick.desc":
    "Snaps its head forward and flings a spinning razor leaf that whistles as it flies.",
  "skill.sproutle.shell-spin.name": "Shell Spin",
  "skill.sproutle.shell-spin.desc":
    "Tucks in tight and whirls like a leafy top, batting away everything within reach.",
  "skill.sproutle.verdant-veil.name": "Verdant Veil",
  "skill.sproutle.verdant-veil.desc":
    "The head-sprout spins up like a propeller, showering allies in glittering pollen that mends wounds.",
  "skill.sproutle.bramble-burst.name": "Bramble Burst",
  "skill.sproutle.bramble-burst.desc":
    "Stomps its stubby feet and erupts a ring of snapping thorn vines from the earth around it.",
  "skill.umbrakit.gloom-bolt.name": "Gloom Bolt",
  "skill.umbrakit.gloom-bolt.desc":
    "Coughs up a purring orb of night that unravels into claws on impact.",
  "skill.umbrakit.phantom-claw.name": "Phantom Claw",
  "skill.umbrakit.phantom-claw.desc":
    "Its paw never moves — the shadow of the paw does the raking.",
  "skill.umbrakit.veil-of-dusk.name": "Veil of Dusk",
  "skill.umbrakit.veil-of-dusk.desc":
    "Pulls the evening over itself like a blanket and dares the world to find it.",
  "skill.umbrakit.midnight-bloom.name": "Midnight Bloom",
  "skill.umbrakit.midnight-bloom.desc":
    "Plants a seed of midnight underfoot; it blooms into a garden of grasping shadows.",

  // ---- wild enemies --------------------------------------------------------
  // Keyed by the EnemySpeciesId in src/combat/enemies.ts. Nothing renders these
  // yet — the kill is reported on the bus and only the XP is read — so they are
  // here so that whatever renders one FIRST is already translated.
  "enemy.gloopling.name": "Gloopling",
  "enemy.snortle.name": "Snortle",
  "enemy.peckit.name": "Peckit",
  // Not wild at all, which is the point of it: the knot the red thread is wound
  // onto at the Hold's floor (issue #150), and the first thing in the game that
  // was PUT somewhere by somebody.
  "enemy.threadAnchor.name": "Thread Anchor",

  // ---- biomes --------------------------------------------------------------
  // Keyed by the BiomeId in src/world/terrain.ts, which is also the AREA key
  // vegetation densities are set per (src/world/nature.ts) and the id of a
  // `biome:` content asset. As with the enemies above, nothing renders these in
  // the game yet — a debug readout and the content editor are what read them
  // first — so they are here to keep the rule that content never carries a
  // display string the base table has not seen.
  //
  // Two of the seven are not weather and read that way on purpose: 'trampled'
  // is the worn yard of a settlement, and 'underwater' is a column below the
  // water line rather than a climate. Both carry a "synthetic" tag in
  // src/content/data/core.json for the same reason.
  "biome.plains.name": "Plains",
  "biome.forest.name": "Forest",
  "biome.beach.name": "Shore",
  "biome.desert.name": "Desert",
  "biome.snow.name": "Snowfield",
  "biome.underwater.name": "Lakebed",
  "biome.deepwater.name": "Deep Sea",

  // ---- locomotion ----------------------------------------------------------
  // The second half of a beast's type: what the HUD badge's corner pip draws
  // and what the inventory row spells out. See LOCOMOTION_NAME_KEYS.
  "loco.ground.name": "Ground",
  "loco.flying.name": "Flying",
  "loco.swimming.name": "Aquatic",
  "loco.amphibious.name": "Amphibious",
  "biome.trampled.name": "Trodden Ground",

  // ---- mount kinds ---------------------------------------------------------
  // THREE, against the four gaits above — the acts hand out one mount each and
  // the water act's covers both aquatic gaits. See MountKind in core/types.ts.
  //
  // The descriptions say what the unlock IS FOR rather than what the animal is,
  // because that is the question a locked badge raises: not "what is a water
  // beast" but "what would riding one get me".
  "mount.kind.ground.name": "Ground mount",
  "mount.kind.ground.desc": "Ride a land beast at a gallop — faster than a sprint you can hold.",
  "mount.kind.water.name": "Water mount",
  "mount.kind.water.desc":
    "Swim and dive where the water is too deep and too cold to cross on foot.",
  "mount.kind.flying.name": "Flying mount",
  "mount.kind.flying.desc": "Take to the air and reach what has no road to it.",

  // ---- HUD ---------------------------------------------------------------
  "hud.hp": "HP",
  "hud.level": "Lv {n}",
  "hud.levelUp": "LEVEL UP",
  "hud.levelUpReached": "{beast} reached Lv {level}!",
  // {skill} arrives already wrapped in its own emphasis markup, so the
  // translation decides where in the sentence the skill name lands.
  "hud.levelUpLearned": "{beast} reached Lv {level} — learned {skill}!",
  "hud.mountHold": "HOLD {key} TO MOUNT",
  /**
   * The burger button in the HUD's top-left corner. Never SHOWN — the button is
   * an icon and its key cap — this is its tooltip and what a screen reader
   * reads, so it is a name and not a sentence.
   */
  "hud.menu": "Menu",
  "hud.riding": "RIDING {beast} · tap {dismount} to dismount",
  "hud.ridingFlying": "RIDING {beast} · {altitude} altitude · tap {dismount} to dismount",
  // The third badge, and the reason there are three: the keys are the SAME two
  // keys, but "altitude" is the wrong word for what they do in a lake, and this
  // badge is the only place a player is ever told a water beast dives at all.
  "hud.ridingSwimming": "RIDING {beast} · {altitude} depth · tap {dismount} to dismount",

  // ---- hints -------------------------------------------------------------
  // The hint pill is HTML, and `{key}` arrives already wrapped in `<kbd>` — the
  // same shape the riding badge and the shop footer use. It used to be plain
  // text that the HUD then ran `/\bPress (\S+)/` over to find the key cap in,
  // which worked in English and produced an unstyled key in every other
  // language. A translation puts `{key}` wherever its own grammar wants it.
  "hint.skillDen": "Press {key} — Skill Den",
  // {name} is an NPC's display name. Composed once per NPC and cached, not
  // rebuilt per frame — see the hint cache in main.ts.
  "hint.npcTalk": "Press {key} — Talk to {name}",
  // The gateway countdown. ONE key each rather than "Entering " + name + "… " +
  // pct + "%": Swedish wants the verb and the destination in the other order,
  // and there is nowhere in a concatenation for a translator to stand.
  "hint.zoneEntering": "Entering {zone}… {pct}%",
  "hint.zoneStand": "Stand in the gateway — {zone}",

  // ---- dialogue ------------------------------------------------------------
  // The talk panel's footer. `{key}` arrives already wrapped in <kbd>, like
  // every other key cap since the `Press (\S+)` regex went away.
  "npc.dialogue.close": "{key} to leave",

  // ---- controls sheet (F1) -------------------------------------------------
  // The panel's own words. The KEYS it prints are not here and are not meant to
  // be: `Space`, `Shift`, `Esc` and the pad's faces are moulded into hardware
  // and read the same in every language — see the device-label note in
  // src/ui/keybinds.ts, which is also where the rows themselves live.
  "keys.title": "Controls",
  // `{key}` and `{esc}` arrive already wrapped in <kbd>, like every other cap.
  "keys.foot": "{key} or {esc} to close",
  // Column headings, printed once per section. Both have a hard-ish width in
  // the panel (see .bs-keyrow in styles.ts) — keep them to about 12 characters.
  "keys.col.kbm": "Keyboard",
  "keys.col.pad": "Controller",
  // The chips. HOLD is the highlighted one, because tapping a key that wants to
  // be leaned on is the mistake this whole sheet exists to prevent.
  "keys.mode.hold": "HOLD",
  "keys.mode.press": "PRESS",
  /** Printed in the controller column for a binding a pad does not have. */
  "keys.none": "—",
  "keys.section.movement": "Movement",
  "keys.section.combat": "Combat",
  "keys.section.beasts": "Beasts",
  "keys.section.world": "World & interface",
  "keys.move": "Move",
  "keys.look": "Look",
  "keys.sprint": "Sprint",
  "keys.climb": "Grip a wall",
  "keys.climb.note": "The sprint key again — push into a climbable face and it grips.",
  "keys.jump": "Jump",
  "keys.swim": "Swim upward",
  "keys.zoom": "Zoom the camera",
  "keys.attack": "Attack",
  "keys.attack.note": "Tap again mid-swing to chain the combo.",
  "keys.skills": "Cast skill 1–4",
  "keys.mount": "Mount your lead beast",
  "keys.dismount": "Dismount",
  "keys.ascend": "Fly higher",
  // One key, two places it means "go down": a flying mount descends and a
  // swimmer dives. Named for the action rather than for either context, so the
  // row does not have to be split in two.
  "keys.descend": "Fly lower · dive",
  "keys.swap": "Swap lead and support",
  "keys.cycleLead": "Next lead beast",
  "keys.cycleSupport": "Next support beast",
  "keys.throwOrb": "Throw taming orb",
  "keys.throwOrb.note": "Ready an orb in the inventory first. Weaken the beast, then throw.",
  "keys.interact": "Talk · open a skill den",
  "keys.inventory": "Inventory",
  "keys.journal": "Quest journal",
  /**
   * THE MENU KEY, which is F10 and no longer Escape. The two rows are separate
   * because the keys are: this one opens and closes the in-game menu, and the
   * one below dismisses whatever is on top of it.
   */
  "keys.menu": "In-game menu",
  /**
   * Listed by what it does in priority order — it backs out of a conversation
   * and dismisses whatever is open. Written as a list rather than as one word
   * because a player reading this sheet has usually just had it close
   * something. It no longer says "menu": the browser spends this key on leaving
   * fullscreen and dropping the mouse, which is why the menu moved to F10.
   */
  "keys.cancel": "Close · cancel",
  "keys.controls": "This sheet",
  "keys.debugOverlay": "Performance overlay",
  "keys.perfPanel": "Debug panel",
  // Named for what it GIVES you rather than for what it costs. "Release mouse"
  // is the accurate description and reads as a warning; the player is reaching
  // for this because they want to click something. The HOLD is carried by the
  // mode column beside it, not by the words.
  "keys.cursor": "Hold to free the mouse cursor",
  // One row covering the keys that steer whatever panel is open — see the note
  // in ui/keybinds.ts for why they are not six rows.
  "keys.panelNav": "Move / change / reset in a panel",

  // ---- shop --------------------------------------------------------------
  "shop.skillDen.title": "Skill Den",
  "shop.forBeast": "for {beast}",
  "shop.learned": "Learned",
  "shop.buy": "BUY",
  "shop.stat.power": "PWR",
  "shop.stat.cooldown": "CD",
  "shop.foot.move": "{key} move",
  "shop.foot.jump": "{key} jump",
  "shop.foot.attack": "{key} attack",
  "shop.foot.skills": "{key} skills",
  "shop.foot.swap": "{key} swap beast",
  "shop.foot.interact": "{key} interact",

  // ---- toasts ------------------------------------------------------------
  // "Click to play" until New Game started taking the pointer itself (see
  // `beginPlay`) — at which point the one instruction this toast carried was an
  // instruction to do something already done. It says what is true now: the
  // mouse is the camera, no click required. A player whose lock request was
  // refused (a boot slow enough to outlast the click's activation) moves the
  // mouse, sees a cursor, and clicks — which is the old behaviour, unprompted.
  "toast.welcome.desktop": "Welcome to Beast Story! Move the mouse to look around.",
  "toast.welcome.touch": "Welcome to Beast Story! Left stick moves, right stick looks.",
  // Ends on F1, which is the only entry that is not a control but the way to
  // find the other thirty: this toast shows once, and the sheet is there for the
  // rest of the session.
  "toast.controls.desktop":
    "WASD move · Space jump · LMB attack · 1-4 skills · hold F to ride · Tab swap · E shop · F1 all controls",
  "toast.controls.touch":
    "Left stick moves · right stick looks · ATK / JUMP / USE · 1-4 skills · SWAP",
  // Face names rather than the {key} placeholder the HUD prompts use, because
  // this is one flat sentence and threading eight glyph substitutions through it
  // would cost every translator eight chances to lose one. The pad's own glyph
  // table (core/gamepad.ts) is what the HUD prints where the layout matters.
  "toast.controls.gamepad":
    "Left stick moves · right stick looks · A jump · RT attack · D-pad skills · hold Y to ride · L3 swap · X shop",
  "toast.enteredZone": "Entered {zone}",
  "toast.beastLeads": "{lead} leads · {support} supports",
  "toast.beastTakesLead": "{beast} takes the lead!",
  "toast.dismountFirst": "Dismount first (tap F).",
  "toast.fetched": "{beast} fetched {item} ({n})",
  "toast.learnedSkill": "{beast} learned {skill}!",
  "toast.fainted": "You fainted!",
  "toast.revived": "Back on your feet!",
  // The deep sea, and it names the FIX rather than the refusal. The water going
  // dark already said "not this way"; what a player cannot work out on his own
  // is that the answer is an animal he already owns.
  "toast.deepWater": "The water goes black here — ride a water beast to cross.",
  "toast.mount.refuse.deepGround": "{beast} will not swim that. Ride something that does.",

  // ---- mounting ------------------------------------------------------------
  // The beast's name lands INSIDE each of these, which is the whole reason they
  // are one key apiece with a `{beast}` placeholder rather than a name glued to a
  // fixed tail. These surfaced with the species rename: `mount.ts` was building
  // them out of `species.name`.
  "toast.mount.flying": "{beast} spreads its wings — hold on!",
  "toast.mount.ground": "{beast} kneels — you're in the saddle!",
  "toast.dismounted": "Dismounted {beast}",
  "toast.mount.beastDown": "{beast} is down!",
  "toast.mount.refuse.swimming": "Too deep to mount — get out of the water first.",
  "toast.mount.refuse.climbing": "Not while you are on the wall.",
  "toast.mount.refuse.beastDead": "{beast} is in no shape to carry you.",
  // By KIND, not by beast: what is missing is the story, and naming the animal
  // would send the player looking for a different one of the same sort.
  "toast.mount.refuse.locked": "You have not learned to ride yet — {kind} is locked.",
  "toast.mount.refuse.noBeast": "No beast to ride.",
  "toast.mount.refuse.other": "Not now.",

  // ---- touch overlay buttons -----------------------------------------------
  // Thumb-sized caps: 3-5 characters is what the button geometry in
  // src/core/touch.ts leaves room for, and a longer word will overflow rather
  // than resize the button. Abbreviate rather than translate literally.
  "touch.move": "MOVE",
  "touch.look": "LOOK",
  "touch.attack": "ATK",
  "touch.jump": "JUMP",
  "touch.interact": "USE",
  "touch.swap": "SWAP",
  /** Top-left corner button: opens the in-game menu, which a phone cannot Escape into. */
  "touch.menu": "MENU",

  // ---- start menu ----------------------------------------------------------
  // The title screen in src/ui/menu.ts. The game's own name is deliberately NOT
  // here: it is the logo artwork (src/ui/menu-logo.webp), which is a picture of
  // the words and cannot be translated by editing this file. `menu.title` is the
  // logo's alt text, which is all a screen reader gets of it.
  "menu.title": "Beast Story: Bonds of Red",
  "menu.pressStart": "Press start...",
  "menu.newGame": "New Game",
  /** The key is the STEP; the label is what a returning player calls it. */
  "menu.load": "Continue",
  "menu.settings": "Settings",
  "menu.back": "Back",
  "menu.settings.title": "Settings",

  // ---- saved characters ----------------------------------------------------
  // The name step and the character list on the title screen, and the autosave
  // row in the settings list. Issue #171.
  //
  // A CHARACTER IS NAMED, NOT NUMBERED. The list says who you were rather than
  // which slot they are in, which is why there is no "Slot 1" string here: the
  // id is a database key and never reaches a player's eyes.
  "saves.namePrompt": "What is your name?",
  /** Used when the field is left empty — including by every pad player. */
  "saves.nameDefault": "Hero",
  "saves.begin": "Begin",
  /** `{n}` is the sum of every bonded beast's level. */
  "saves.power": "Power {n}",
  "saves.delete": "Delete",
  /** The same button after one press. Two presses delete; see `pressDelete`. */
  "saves.deleteConfirm": "Confirm?",
  "saves.empty": "No characters yet",
  /** Shown on the list when a character was chosen and could not be read. */
  "saves.loadFailed": "That character could not be loaded",

  // ---- about the game ------------------------------------------------------
  // The About panel (src/ui/about.ts), reached from the option list. Issue #65.
  //
  // WRITTEN SHORT ON PURPOSE, and the shape is the request rather than the word
  // count: one fact per line, the lead sentence answering "what is this" on its
  // own, and every heading a question a player actually turns up with. A
  // translator should keep the sentences separate rather than joining them into
  // a paragraph — a wall of type is exactly what this panel is written against.
  //
  // The licence block is NOT here, and must not be moved here: a package's
  // name, its SPDX id and the MIT text are the notice we are obliged to
  // reproduce, and a translated licence is not that licence. See src/ui/about.ts.
  "menu.about": "About the Game",
  "about.lead":
    "Beast Story: Bonds of Red is a small open-world game. You explore, you meet " +
    "beasts, and they fight beside you.",
  // FOUR WORDS, NOT FOUR SENTENCES. The bullets used to describe the systems —
  // the hotbar, the drops, the follow slots — which is a manual, and a manual is
  // the thing nobody reads on a title screen. What a player wants off this
  // screen is whether the game is the KIND of game they are looking for, and
  // that is answerable in a word each.
  "about.what": "What you do",
  "about.what.1": "Explore",
  "about.what.2": "Tame beasts",
  "about.what.3": "Fight",
  "about.what.4": "Grow stronger",
  "about.ai": "AI disclaimer",
  "about.ai.body":
    "This project is built with heavy use of generative AI. Code, art, music and " +
    "text were produced with AI tools and then reviewed and edited by a human. " +
    "Treat everything here as AI-assisted work.",
  // The name and nothing else. The repository is PRIVATE, so there is no link
  // to give and no invitation to read the source — saying so would be an
  // invitation to a 404.
  "about.credits": "Credits",
  "about.credits.body": "Made by Mikael Porttila.",
  "about.licenses": "Licenses",
  // The two lists differ in KIND, not in politeness: the first is a notice we
  // are required to carry, the second is a credit we choose to.
  "about.licenses.shipped": "Shipped inside the game:",
  "about.licenses.tools": "Used to build and test it, not shipped:",
  /**
   * The four SECTIONS of the settings panel, as the tabs across the top of it.
   *
   * They are the four questions a player arrives with — how the game plays, how
   * it is driven, how it looks, how loud it is — and not the four localStorage
   * groups, which are a namespace fixed on the day each setting shipped. Two
   * settings sit under a group that no longer matches their tab (see the note in
   * core/prefs.ts); renaming those keys would silently reset the choice of every
   * player who already made one, which is a worse thing than a name.
   */
  "menu.settings.tab.gameplay": "Gameplay",
  "menu.settings.tab.controls": "Controls",
  "menu.settings.tab.graphics": "Graphics",
  "menu.settings.tab.sound": "Sound",
  /**
   * The GRAPHICS tab's six rows. They drive exactly what the F3 performance
   * panel's rows of the same name switch — one model, core/gfx.ts — and they are
   * deliberately their OWN strings rather than a reuse of the `gfx.*` labels
   * below.
   *
   * Two reasons, and the second is the one that decided it. The F3 panel is a
   * DIAGNOSTIC: every row there names the geometry a switch deletes and carries
   * a measured draw count, because it is read beside F2 by somebody hunting a
   * frame. A settings menu is asked a different question — what does the game
   * look like — which is why `gfx.grass`'s "Grass & ground cover" is "Foliage"
   * here, the one word that covers the grass, the flowers and the low scatter
   * that come and go together. And the F3 panel is a developer instrument that
   * ships untranslated (see the exemptions in AGENTS.md), so a player-facing row
   * pointed at those keys would have been an English word in a Swedish menu.
   */
  "menu.settings.ao": "Ambient occlusion",
  "menu.settings.bloom": "Glow",
  "menu.settings.aa": "Antialiasing",
  "menu.settings.shadows": "Shadows",
  "menu.settings.terrainDistance": "View distance",
  "menu.settings.foliage": "Foliage",
  "menu.settings.foliageDistance": "Foliage distance",
  /**
   * Says "controller" rather than "haptics" or "rumble" on purpose: it is the
   * word on the box, and the row has to be recognisable by someone who opened
   * Settings because their pad keeps buzzing.
   */
  "menu.settings.hapticFeedback": "Enable Controller Vibration",
  "menu.settings.invertX": "Invert look X",
  "menu.settings.invertY": "Invert look Y",
  /** Both toggles are pad-only, and saying so stops them reading as mouse bugs. */
  "menu.settings.controllerNote": "Controller only — the mouse is never inverted.",
  /**
   * The switch in front of the fullscreen the game takes on New Game. Worded as
   * what it DOES rather than as "auto fullscreen", because the player never saw
   * anything called that — they saw the game fill the screen when they started.
   */
  "menu.settings.autoFullscreen": "Fullscreen on start",
  /**
   * Under that switch, and only where the switch is shown disabled: a browser
   * that will not give the game the Escape key (issue #83). Says what the
   * BROWSER does rather than "unsupported", because the player's own experience
   * of it is a screen that shrank when they closed a panel — and it names
   * Escape so somebody who wants fullscreen anyway knows to press F11.
   */
  "menu.settings.fullscreenEscape":
    "This browser leaves fullscreen when you press Escape, so the game starts in a window.",
  /**
   * The volume strip: OFF · 20 · 40 · 60 · 80 · 100. Says "Music" and not
   * "Volume" because it is not the only sound the game will ever make — the SFX
   * channel is a seam with a level of its own to come (src/feedback/audio.ts) —
   * and a row labelled "Volume" would have to be renamed on the day it lands,
   * by which time players will have learned where it is. The numbers on the
   * chips are per cent and carry no unit: a `%` on six chips is six times the
   * width for a fact the shape of the row already tells you. OFF is `menu.off`,
   * the same word the toggles' pills use.
   */
  "menu.settings.music": "Music",
  "menu.settings.autosave": "Autosave",
  /**
   * The interval chips. The UNIT is in the chip rather than in the label,
   * because "5" beside a row called Autosave is a number a player can read as
   * seconds. `{n}` is the interval in minutes.
   */
  "menu.settings.autosave.minutes": "{n} min",
  "menu.settings.language": "Language",
  /**
   * Under the language picker, and ONLY when Settings was opened from inside a
   * game, where the chips are shown disabled.
   *
   * Says where the setting is rather than that it is unavailable, because the
   * player asking is standing two button presses from the place it works. The
   * reason it cannot change here is that a fingerpost's letters are voxel
   * geometry carved once at world creation — see ui/settings.ts.
   */
  "menu.settings.languageInGame": "Change the language from the title screen.",

  // ---- F3 performance panel ------------------------------------------------
  // src/ui/perf-panel.ts, driven by the list in src/core/gfx.ts.
  //
  // EVERY `.cost` STRING IS A MEASUREMENT and none of them is an estimate —
  // walking, 1280x800, frame capped at 120 on a 165 Hz display. They are here
  // rather than in the code because they are what the player is choosing
  // between: a row of switches with no numbers on it asks somebody to guess.
  // Re-measure them when the renderer changes, the same way a tuned constant's
  // comment is re-measured; a stale number here is worse than none.
  // The panel holds two tools now — the renderer switches below and the
  // spawner under `spawn.*` — so the title names the panel rather than the
  // half of it that came first. The `gfx.*` prefix stays: it is the id space
  // `/gfx`, `__dbgGfx` and tools/test-gfx.mjs all share, and renaming a key
  // space to match a heading is churn with a test suite attached.
  "gfx.title": "Debug",
  "gfx.section.render": "Rendering",
  "gfx.hint": "↑↓ move · ← → or Enter change · R defaults · F3 closes",
  "gfx.timeOfDay": "Time of day",
  "gfx.timeOfDay.cost": "debug override — Clear resumes the story clock",
  "gfx.time.auto": "Clear",
  "gfx.time.dawn": "Dawn",
  "gfx.time.noon": "Noon",
  "gfx.time.dusk": "Dusk",
  "gfx.time.midnight": "Midnight",
  "gfx.reset": "All back to defaults.",
  "gfx.on": "on",
  "gfx.off": "off",
  "gfx.uncapped": "display",
  "gfx.fpsCap": "Frame rate cap",
  "gfx.fpsCap.cost": "the biggest lever — 80% of a core at 165 fps, 55% at 120",
  "gfx.bloom": "Glow (bloom)",
  "gfx.bloom.cost": "23 draw calls and a chain of blurs",
  "gfx.grass": "Grass & ground cover",
  "gfx.grass.cost": "44 draw calls, and the heaviest geometry in the world",
  "gfx.terrainDistance": "Terrain view distance",
  "gfx.terrainDistance.cost": "High: a 9x denser far mesh, without more cube chunks",
  "gfx.foliageDistance": "Foliage distance",
  "gfx.foliageDistance.cost": "shorter ranges cull whole grass and prop chunks",
  "gfx.distance.low": "Low",
  "gfx.distance.medium": "Medium",
  "gfx.distance.high": "High",
  "gfx.ao": "Ambient occlusion",
  "gfx.ao.cost": "47 draw calls — it re-renders the scene to measure depth",
  "gfx.shadows": "Shadows",
  "gfx.shadows.cost": "a whole render pass — but the world floats without them",
  "gfx.props": "Trees & rocks",
  "gfx.props.cost": "70 draw calls — the most of any row, and the most missed",
  "gfx.aa": "Antialiasing",
  "gfx.aa.cost": "three fullscreen passes; edges go jagged",
  "gfx.clouds": "Clouds",
  "gfx.clouds.cost": "small — a few draws overhead",
  "gfx.water": "Water surface",
  "gfx.water.cost": "small unless you are looking at a lake",

  // ---- F3 appearance -------------------------------------------------------
  // The hero's hair: src/player/hair.ts holds the styles, ui/perf-panel.ts the
  // two rows. Style names are DESCRIPTIVE rather than the characters they nod
  // at — the shapes are homages, the strings are not, and a name in this table
  // is a name the player reads.
  "hair.section": "Appearance",
  "hair.style": "Hairstyle",
  "hair.style.cost": "← → to try them on",
  "hair.colour": "Hair colour",
  "hair.colour.cost": "← → for a swatch, or click the well for any colour",
  // The path editor (issue #142 §12). A developer instrument like everything
  // else in this panel, so it is exempt from the 16px floor — but not from
  // going through `t()`, because every string in this file does.
  "path.section": "Lay a path",
  "path.profile": "Kind",
  "path.profile.cost": "← → to pick one",
  "path.profile.road": "Cart road",
  "path.profile.footpath": "Footpath",
  "path.length": "Length",
  "path.length.cost": "world units, laid along your facing",
  "path.crossing": "Where it meets a path",
  "path.crossing.merge": "Cross and merge",
  "path.crossing.avoid": "Give way",
  "path.crossing.cost": "merging splits both and makes a junction",
  "path.lay": "Lay it from here",
  "path.lay.go": "Enter",
  "path.lay.cost": "rebuilds every chunk — a second or two",
  // The mount rows. A developer instrument standing in for three quests that do
  // not exist yet (game-story.md §5), so the last column names the quest each
  // one is waiting on rather than a measured cost.
  "mount.section": "Mounts",
  "mount.ground.quest": "Act 1 · The Mill Road",
  "mount.water.quest": "Act 2 · Dark Water",
  "mount.flying.quest": "Act 3 · Wingbroken",
  "hair.classic": "Adventurer",
  "hair.buzz": "Buzz cut",
  "hair.bowl": "Shaggy bowl",
  "hair.curtain": "Curtain fringe",
  "hair.ponytail": "Warrior's tail",
  "hair.emo": "Sidecut sweep",
  "hair.cloud": "Mercenary spikes",
  "hair.mohawk": "Mohawk",
  "hair.saiyan": "Battle flare",

  // ---- F3 spawner ----------------------------------------------------------
  // src/ui/perf-panel.ts's lower half, driven by the catalogue main.ts builds
  // against core/spawn.ts. The ROWS are not here: an item's name, a beast's
  // name and an enemy's name already have keys of their own, and the host looks
  // each one up on its way into the tree so a language switch carries them.
  // Only the furniture — headings, notes, results — is spelled out below.
  "spawn.section": "Spawn",
  "spawn.search": "search items, beasts, enemies, quests, parts…",
  "spawn.noMatch": "nothing matches",
  "spawn.items": "Items",
  "spawn.items.note": "into the bag",
  "spawn.beasts": "Beasts",
  "spawn.beasts.note": "bonded to the party",
  "spawn.enemies": "Enemies",
  "spawn.enemies.note": "into the world, where the crosshair points",
  // The quest rows are a DEVELOPER instrument and say so: this hands a quest in
  // from the panel, rewards and all, so an act can be tested from its middle.
  "spawn.quests": "Quests",
  "spawn.quests.note": "driven from here — click to accept, click again to hand in",
  "spawn.questTaken": "accepted",
  "spawn.questDone": "handed in",
  "spawn.structures": "Structures",
  "spawn.structures.note": "built on the ground, where the crosshair points",
  "spawn.clear": "Clear spawned structures",
  "spawn.unknown": "nothing named that",
  "spawn.owned": "already bonded",
  "spawn.placed": "placed",
  "spawn.noStructures": "this zone builds nothing — see World.debugSpawn",

  // ---- in-game menu --------------------------------------------------------
  // src/ui/pause.ts, on Escape / Start / the touch overlay's menu button.
  // Settings is the SAME list the title screen shows.
  /**
   * NOT "Paused", which is what this said and what it is not. The HERO is
   * frozen while the menu is up — he reads no input and takes no slice — but the
   * world behind him is not: chunks stream, beasts follow, wild spawns move and
   * the clock runs. Labelling that "Paused" tells a player they can walk away
   * from the screen, which is the one thing it does not mean.
   */
  "pause.title": "Menu",
  "pause.continue": "Continue",
  "pause.settings": "Settings",
  /**
   * Back to the title screen, not out of the browser. "Exit" alone reads as
   * quitting the application on desktop, and there is nothing to quit to.
   */
  "pause.exit": "Exit to title",

  // ---- boot progress -------------------------------------------------------
  // The corner chip while the title screen is up, and the loading screen the
  // game is handed over behind (src/ui/loading.ts). They name the WORK, not a
  // mood: a player watching a bar wants to know what is taking the time, and
  // these are the four phases main.ts actually runs, in order.
  "load.world": "Building the world",
  "load.actors": "Waking the beasts",
  "load.shaders": "Compiling shaders",
  "load.terrain": "Growing the forest",
  "load.ready": "Ready",
  "menu.on": "ON",
  "menu.off": "OFF",
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
