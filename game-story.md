# Beast Story: Bonds of Red — story design

Issue #72. This is the campaign written down so it can be **authored as content**:
the acts, the towns they happen in, the people who carry them, and the twenty main
quests, each already shaped like a `quest:` asset. Nothing here is code. The target
is a set of packages under [src/content/data/](src/content/data/) that the runtime in
[src/content/](src/content/) loads — see [src/content/types.ts](src/content/types.ts)
for the contract and [src/content/types/quest.ts](src/content/types/quest.ts) for the
quest shape this document is written against.

Read [§1](#1-the-rules-the-story-obeys) before writing any of it. Half the decisions
below are the engine's, not the fiction's, and a story that ignores them is a story
that cannot be built without changing the world generator.

---

## Core plot

Long ago, humans and beasts were connected through natural bonds. A force called the
**Red Bond** has begun corrupting those connections, forcing beasts to turn aggressive
and to obey a master nobody has seen.

It is not a curse and it is not a plague. It is a **machine**, built by the floating
cities to hold dangerous beasts at a safe distance, and it has been running unattended
for longer than anyone alive can remember. What it is straining against is not the
world's beasts — it is **one** beast, the first thing that was ever bonded, caught
between the land, the sea and the sky, and every animal wearing a red thread is a rope
in that tug of war.

The player walks that chain backwards: from a valley where the livestock has turned,
to an archipelago where a rival order is collecting the same evidence for the opposite
reason, to the cities that built the thing, to the seam between all three where the
first bond is still being held. The last quest is not a fight the player wins. It is a
choice about what a bond between a human and a beast should be, and all three answers
are honest.

---

## 1. The rules the story obeys

These are engine facts. Each one changed something in the design above it.

1. **Progress is a set of quest ids, never a position in a line.** No
   `mainQuestProgress`. A quest's place in the story is its `prerequisites` plus its
   `available` condition, recomputed from `ContentState`. That is what lets Act 2 ship
   before Act 3 exists, and lets a quest be inserted between two shipped ones without
   moving anybody backwards. Every ordering in this document is expressed that way.
2. **`arc` is a label, not an order.** The journal headings below (`land`, `sea`,
   `sky`, `seam`) group quests; nothing may derive "what is next" from them.
3. **Exactly one town in the whole registry may be `start: true`**, and it is
   `town:encampment`. Every town this document adds says `start: false`.
4. **The road planner is a hub with one trunk and two spurs — three sited ground towns
   per zone, and a fourth is reported and left unbuilt** (see the towns note in
   [AGENTS.md](AGENTS.md)). Act 1 therefore uses the three towns that already exist
   and adds none, and Act 2's archipelago is capped at three settlements plus
   landmarks. Act 3 is exempt: a `carried: true` town is skipped by `planSettlements`
   entirely, which is why the sky can hold four.
5. **A town's sign is at most 10 upper-case characters** in the 3×5 voxel font, and is
   a separate string from the display name — `Redbriar Mill` signs as `REDBRIAR`.
   Every sign below is inside that budget.
6. **Content selects a behaviour by name; it never carries one.** `"layout": "camp"`,
   `"body": "gain"`, `"model": "gloopling"` are lookups into factories the engine
   registers. Every new body, layout, model and enemy in this document is therefore a
   TypeScript builder as well as an asset — [§7](#7-what-the-engine-still-needs) is
   the list.
7. **Shipped text uses `{ "key": … }`**, checked at build time against
   [src/i18n/en.ts](src/i18n/en.ts). The inline `{ "text": { "en": … } }` form is for
   content that arrives after a build; the story packages ship with the game, so they
   use keys and every line below implies an `en.ts` entry.
8. **A quest's `rewards` are counts only** (`xp`, `shard`). Anything a reward _does_ —
   unlock a mount, open a region, set a flag — is an `onComplete` action naming a
   registered handler. Actions that do not exist yet are marked ⚙ below.
9. **The example package stays an example.** `src/content/data/example-quest.json` and
   its `quest:encampment/first-steps` are the loader demonstration; the story uses the
   `quest:land/…` line and does not reference them.

---

## 2. The recurring cast

The ask was that people follow the player through the story rather than being handed
out one per region. Five characters do, and three of them already exist in
`core.json`.

**One character, several placements.** An `npc:` asset names exactly one `town`, so a
character who appears in three hubs is three assets sharing one `body` factory, one
display-name key, and a `talk` list gated on quest flags. That is not a workaround —
it is what `body` being a factory name is for, and it keeps "which Gain is standing
here" a content question. Ids carry the placement: `npc:gain` (the Encampment, already
shipped), `npc:gain/saltrest`, `npc:gain/skyhaven`.

| Character                            | Id family                                                          | Role                                                                                                                                                                                                | Appears   |
| ------------------------------------ | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| **Deckard Gains Armstrong** ("Gain") | `npc:gain`, `npc:gain/saltrest`, `npc:gain/skyhaven`               | The trainer. Teaches taming, then each mount in turn. Goes ahead of the player each act and is always already there when they arrive, which is his joke and, by Act 4, the thing that worries them. | Acts 1–4  |
| **Warden Sela Coil**                 | `npc:coil/stonewatch`, `npc:coil/kelphold`, `npc:coil/orrery`      | The Bridle order. A cameo in Act 1, the rival in Act 2, an uneasy ally in Act 3, and one of the three voices in the Act 4 choice. She is not wrong, which is the point of her.                      | Acts 1–4  |
| **Corwin Vane**                      | `npc:sky-pilot` (shipped), `npc:sky-pilot/gullspire`               | The balloonist. Found wrecked on a sea-stack in Act 2 — the first proof anything lives above the weather — and the ferry up in Act 3.                                                               | Acts 2–4  |
| **Mother Pell**                      | `npc:sky-gardener` (shipped)                                       | Keeps the sky city's bond-garden and remembers what the cities did. The only character who can name the First Bond.                                                                                 | Acts 3–4  |
| **Tobin Ashgrove**                   | `npc:sky-lamplighter` (shipped), `npc:sky-lamplighter/lanternfall` | Lamplighter. His sister Mera runs Redbriar Mill in Act 1 and neither of them knows the other is alive; the player is who tells them.                                                                | Acts 1, 3 |

Local colour, one or two per act, not recurring: **Mera Ashgrove** (`npc:mera`, Redbriar
Mill), **Brack Tulley** (`npc:brack`, Saltrest boatwright), **Archivist Marran Vess**
(`npc:vess`, the Orrery — the apparent villain of Act 3).

**Kettle** is the one thread this document asks for and cannot specify as an asset: a
Sproutle the player frees in `quest:land/the-red-thread` who rejoins the party and is
present at every later story beat. A beast that is a _character_ — with a fixed name,
a fixed slot and dialogue reacting to it — needs engine support that does not exist
(`BeastActor` has no identity beyond its species). It is listed in
[§7](#7-what-the-engine-still-needs) and every quest below works without it.

---

## 3. Quest types

Seven shapes, chosen so that no act is five of the same thing. ✓ means the engine can
already produce the trigger; ⚙ means [§7](#7-what-the-engine-still-needs) has an entry.

| Type        | What the player does                                 | Objective counted by            |
| ----------- | ---------------------------------------------------- | ------------------------------- |
| **talk**    | Reach a person and hear them out                     | `NpcTalk` action ✓              |
| **travel**  | Cross to a place that is far, or gated on a mount    | `discover` on arrival ⚙         |
| **tame**    | Bond a named species in the wild                     | taming trigger ⚙                |
| **collect** | Bring back N of a thing (drops, salvage, components) | `progress.add` on pickup ⚙      |
| **cull**    | Put down N corrupted beasts of a species             | `progress.add` on enemy death ⚙ |
| **dungeon** | Enter a zone, reach its floor, come back out         | zone arrival ⚙ + `discover`     |
| **boss**    | One named enemy, one arena, usually mount-gated      | enemy death ⚙                   |

Two rules about the mix, both learned from what this world is good at. **A travel quest
is only interesting the moment before a mount is unlocked** — it is what makes the
mount land — so each act spends its travel quest early and never again. And **a tame
quest is the act's mount tutorial**, not a side errand: the animal you bond in quest 2
of each act is the animal you ride for the rest of it.

---

## 4. The acts

Each act is a **zone** ([src/world/zones.ts](src/world/zones.ts)), which is what makes
"the sea" and "the sky" buildable at all: a zone is created, streamed and disposed on
its own, and the player crosses between them at a gateway. `overworld` and `hold` ship
today; `brine`, `cirrus` and `seam` are new.

| Act | Zone id     | Zone name        | Theme                       | Mount unlocked | Towns           |
| --- | ----------- | ---------------- | --------------------------- | -------------- | --------------- |
| 1   | `overworld` | Embervale        | Pastoral frontier           | Ground         | 3 (all shipped) |
| 2   | `brine`     | The Brine Reach  | Tide-worn archipelago       | Water          | 3 + 2 landmarks |
| 3   | `cirrus`    | The Cirran Shelf | Cloud-borne cities          | Flying         | 4 (all carried) |
| 4   | `seam`      | The Seam         | The three horizons stitched | — (all three)  | 0               |

---

### Act 1 — Land

**Theme.** A green working valley: mills, drove roads, fingerposts, a walled camp and a
watchtower. The trouble is agricultural before it is supernatural — the herds turn, the
mill's oxen turn, and nobody has a word for it yet. Everything the player learns in Act
1 they learn from someone whose living depends on animals.

**Zone.** `overworld` (Embervale), shipped. The Sunken Hold (`hold`) is its dungeon and
is used as-is.

**Towns.** All three already exist and none is added, per rule 4.

| Town           | Id                | Sign         | Layout   | Role                                                                   |
| -------------- | ----------------- | ------------ | -------- | ---------------------------------------------------------------------- |
| The Encampment | `town:encampment` | `ENCAMPMENT` | `camp`   | Start. Gain's forge-fire; the act's hub and Act 4's staging ground.    |
| Redbriar Mill  | `town:redbriar`   | `REDBRIAR`   | `hamlet` | Waterside. Mera Ashgrove's mill; where the red thread is first _seen_. |
| Stonewatch     | `town:stonewatch` | `STONEWATCH` | `hamlet` | The drove-road watchtower. Warden Coil's cameo and the act's boss.     |

**Quests.** Arc `land`.

| #   | Id                          | Type          | Giver                 | Location          | Prerequisites |
| --- | --------------------------- | ------------- | --------------------- | ----------------- | ------------- |
| 1   | `quest:land/first-light`    | talk          | `npc:gain`            | `town:encampment` | —             |
| 2   | `quest:land/the-first-bond` | tame          | `npc:gain`            | `town:encampment` | 1             |
| 3   | `quest:land/the-mill-road`  | travel + cull | `npc:gain`            | `town:redbriar`   | 2             |
| 4   | `quest:land/the-red-thread` | dungeon       | `npc:mera`            | `town:redbriar`   | 3             |
| 5   | `quest:land/the-bellwether` | boss          | `npc:coil/stonewatch` | `town:stonewatch` | 4             |

**1 · First Light.** Gain has been waiting at the fire since before the player woke up
beside it. Objectives: `talk-to-gain`, then `bond-practice` (three casts on a docile
Sproutle he has penned). `onComplete`: `flag.set taming-learned`, `flag.set met-gain`,
`discover town:encampment`. Rewards 25 xp, 10 shard.

**2 · The First Bond.** Leave the walls and bond a beast that has not been penned for
you. Objective: `tame-wild` ×1, any ground species. This is the taming tutorial's real
half — the first animal that can refuse. `onComplete`: `flag.set first-bond`.
Rewards 60 xp, 25 shard.

**3 · The Mill Road.** Mera has sent word that her oxen have turned and the drove road
is not safe. Objectives: `reach-redbriar` (travel — deliberately on foot and
deliberately long), `cull-corrupted` ×6 along the way. `onComplete`:
`mount.unlock ground` ⚙, `flag.set mount-ground`, `discover town:redbriar`.
**The ground mount is the reward for
walking**, which is the only arrangement in which the player feels it. Rewards 120 xp,
40 shard.

**4 · The Red Thread.** What turned the oxen came up out of the millrace. The Sunken
Hold, entered through the existing gateway; at its floor a penned Sproutle with a red
thread wound through its bond, and a shard of something manufactured. Objectives:
`enter-the-hold`, `free-the-sproutle`, `recover-shard` ×1. `onComplete`:
`flag.set red-thread-seen`, `discover zone:hold`. Rewards 200 xp, 60 shard.
_(If Kettle ships, this is where Kettle joins.)_

**5 · The Bellwether.** Stonewatch's drove herd has one animal leading it and the rest
of the valley is following that one. Warden Sela Coil is already at the tower, already
holds three shards like the player's, and wants the fourth. The boss is
`enemy:bellwether`, a corrupted herd-beast, fought across open drove ground where the
ground mount is the difference between reaching it and not. Objectives:
`meet-the-warden`, `defeat-bellwether`. `onComplete`: `flag.set sea-revealed`,
`flag.set act-1-complete`, `discover town:stonewatch`. Rewards 400 xp, 120 shard.

**Act closes on:** the shards are pieces of an instrument, they are not from this
valley, and the salt on them says where they came from. Coil leaves for the coast
first. Gain leaves second and does not say why.

**New content:** `enemy:bellwether` (model ⚙), `npc:mera` (body ⚙),
`npc:coil/stonewatch` (body ⚙), music `music:overworld` (shipped).

---

### Act 2 — Sea

**Theme.** A tide-worn archipelago of working harbours: rope walks, salt lofts, whalebone
sheds, lantern buoys, and market floors that flood twice a day. It is a **voyage**
structure — a chain of islands, one component each, a rival crew always one tide ahead
— told with ordinary maritime craft rather than adventure-fantasy piracy. Deep water is
rendered dark and reads as _unswimmable_, which is what makes the water mount feel like
a key rather than an upgrade.

**Region.** "The Brine Reach" (`region:brine`) is **part of the open world** —
decided in review of #227's zone-based first cut, superseding the zone design
this section first shipped with. Seaward of Embervale's coastline the landform
blends into an island sea (`SEA_DIR`/`SEA_START`/`SEA_FULL` in
`world/terrain.ts`); there is no gateway and no second world instance. The first
crossing is the FERRY — a scripted sail between Embervale's pier and Saltrest's
quay, moored by `sea-revealed` — and the water mount later makes the whole sea
free-roam. Deep water refusing the hero on foot is the act gate.

**Towns.** Three `island: true` settlements — sited by the island placer, which
takes no road-hub slot — plus two landmark islands with no
settlement on them.

| Place          | Id                        | Sign        | Layout      | Role                                                                                                                          |
| -------------- | ------------------------- | ----------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Saltrest       | `town:saltrest`           | `SALTREST`  | `harbour` ⚙ | Hub. Waterside. Brack Tulley's yard, Gain's second appearance, the boat.                                                      |
| Kelphold       | `town:kelphold`           | `KELPHOLD`  | `hamlet`    | The drowned market — a town whose ground floor is under water at every high tide. Component 1. Coil's crew are already in it. |
| Gullspire      | `town:gullspire`          | `GULLSPIRE` | `hamlet`    | A lighthouse and a rookery on one stack. Component 2. Corwin Vane's wreck.                                                    |
| Maw's Rest     | `landmark:maws-rest`      | —           | —           | No settlement. A reef ring with something sleeping in it. Component 3 and the act's boss.                                     |
| The Dark Water | `landmark:the-dark-water` | —           | —           | No settlement. The deep trench between the islands, and the reason for the water mount.                                       |

**Quests.** Arc `sea`.

| #   | Id                             | Type              | Giver                     | Location             | Prerequisites               |
| --- | ------------------------------ | ----------------- | ------------------------- | -------------------- | --------------------------- |
| 1   | `quest:sea/salt-and-rope`      | travel + talk     | `npc:gain/saltrest`       | `town:saltrest`      | `quest:land/the-bellwether` |
| 2   | `quest:sea/dark-water`         | tame              | `npc:gain/saltrest`       | `town:saltrest`      | 1                           |
| 3   | `quest:sea/the-drowned-market` | collect + dungeon | `npc:brack`               | `town:kelphold`      | 2                           |
| 4   | `quest:sea/the-rookery`        | tame + escort     | `npc:sky-pilot/gullspire` | `town:gullspire`     | 2                           |
| 5   | `quest:sea/what-the-tide-kept` | boss              | `npc:coil/kelphold`       | `landmark:maws-rest` | 3, 4                        |

Note quests 3 and 4 both hang off 2 and neither requires the other: two islands, two
components, either order. That is the archipelago's whole structure expressed as
prerequisites, and it is the first place the id-based design earns itself.

**1 · Salt and Rope.** Cross to the Brine Reach and find the harbour. Gain is on the
quay with a boat already bought. Objectives: `reach-saltrest`, `talk-to-gain`,
`take-the-boat`. `onComplete`: `flag.set has-boat`, `discover town:saltrest`. Rewards
250 xp, 60 shard.

**2 · Dark Water.** The channels between the islands are too deep and too cold to swim
and the boat cannot follow a thing that dives. Objectives: `find-the-aquaxol`,
`tame-aquaxol` ×1. `onComplete`: `mount.unlock water` ⚙, `flag.set mount-water`,
`flag.set dark-water-open`.
**Touching dark water auto-mounts the water beast** — an engine mechanic, not a quest
step; see [§7](#7-what-the-engine-still-needs). Rewards 300 xp, 80 shard.

**3 · The Drowned Market.** Kelphold's market floor is only walkable at low tide, and
the component is under it. The Bridle crew got there first and have already leashed
what was guarding it; the player arrives to find the guardian wearing a collar. This is
where Coil states her case, and it is a good one: a leashed beast hurts nobody.
Objectives: `dive-the-market`, `collect-salvage` ×8, `recover-component` ×1.
`onComplete`: `flag.set component-lens`, `discover town:kelphold`. Rewards 350 xp,
100 shard.

**4 · The Rookery.** Gullspire's flock has turned and the lighthouse keeper cannot get
up the stack. Halfway up is a wrecked balloon nobody in the Reach believes came from
anywhere, and a man beside it who has been drinking rain for a week. Objectives:
`calm-the-flock` (tame ×1 of the rookery species), `escort-vane` (get Corwin down the
stack alive), `recover-component` ×1. `onComplete`: `flag.set component-vane`,
`flag.set knows-the-sky`, `discover town:gullspire`. Rewards 350 xp, 100 shard.

**5 · What the Tide Kept.** Maw's Rest holds the third component and the thing that has
been holding it. Coil is there for the same reason and, for one fight, on the same
side. The boss is `enemy:brineholder`, fought in and under water, which is what the
whole act has been teaching. Objectives: `reach-maws-rest`, `defeat-brineholder`,
`assemble-the-device`. `onComplete`: `flag.set device-built`, `flag.set sky-revealed`,
`flag.set act-2-complete`. Rewards 700 xp, 200 shard.

**Act closes on:** the assembled instrument points, steadily and stupidly, _up_. Corwin
Vane says he can get them there and that they will not like it. Coil says she is coming
whether they like it or not.

**New content:** zone `brine`; town layout `harbour` ⚙; towns `saltrest`, `kelphold`,
`gullspire`; landmarks `maws-rest`, `the-dark-water`; `npc:gain/saltrest`, `npc:brack`
(body ⚙), `npc:coil/kelphold`, `npc:sky-pilot/gullspire`; `enemy:brineholder` (model ⚙),
`enemy:bridle-hound` (model ⚙); biome `biome:reef` ⚙; `music:brine` ⚙.

---

### Act 3 — Sky

**Theme.** Cloud-borne cities on floating rock: cable stays, ballast gardens, lamp
galleries, and an observatory full of brass. The register is **civic** rather than
wondrous — these places have drainage and rotas and a shortage of lamp oil — because
the reveal is that the polite, well-run cities up here built the thing eating the world
below, and have been quietly maintaining it ever since.

**Zone.** `cirrus`, "The Cirran Shelf". Reached by balloon, which is a transition
between two balloon models rather than a flight (the player's craft is not simulated).

**Towns.** All four are `carried: true` and therefore exempt from the road planner
(rule 4), which is why the sky can afford more settlements than the sea. Skyhaven and
its three residents already ship.

| Town        | Id                 | Sign         | Layout      | Role                                                                                                       |
| ----------- | ------------------ | ------------ | ----------- | ---------------------------------------------------------------------------------------------------------- |
| Skyhaven    | `town:skyhaven`    | `SKYHAVEN`   | `skyhaven`  | Hub. Shipped. Gain, Corwin Vane, Mother Pell, Tobin Ashgrove.                                              |
| Lanternfall | `town:lanternfall` | `LANTERNS`   | `gallery` ⚙ | A shelf of lamp galleries whose light is what keeps the Bond Engine's overflow dim. The lamps are failing. |
| Cinderhelm  | `town:cinderhelm`  | `CINDERHELM` | `gallery` ⚙ | A shelf that already burned. Half a town, evacuated, with the engine's exhaust vented under it.            |
| The Orrery  | `town:orrery`      | `ORRERY`     | `orrery` ⚙  | The Bond Engine itself, kept by Archivist Marran Vess. Act 3's finale.                                     |

**Quests.** Arc `sky`.

| #   | Id                          | Type           | Giver                             | Location           | Prerequisites                  |
| --- | --------------------------- | -------------- | --------------------------------- | ------------------ | ------------------------------ |
| 1   | `quest:sky/the-long-ascent` | travel         | `npc:sky-pilot`                   | `town:skyhaven`    | `quest:sea/what-the-tide-kept` |
| 2   | `quest:sky/wingbroken`      | tame           | `npc:gain/skyhaven`               | `town:skyhaven`    | 1                              |
| 3   | `quest:sky/lanternfall`     | collect        | `npc:sky-lamplighter/lanternfall` | `town:lanternfall` | 2                              |
| 4   | `quest:sky/cinderhelm`      | dungeon + boss | `npc:sky-gardener`                | `town:cinderhelm`  | 2                              |
| 5   | `quest:sky/the-orrery`      | boss + reveal  | `npc:vess`                        | `town:orrery`      | 3, 4                           |

Same fork as Act 2: two islands off one prerequisite, either order, both required for
the finale.

**1 · The Long Ascent.** The balloon. Objectives: `board-the-balloon`,
`reach-skyhaven`. Gain is on the mooring deck with a cup of something hot, and this
time the player asks him how. `onComplete`: `discover town:skyhaven`,
`flag.set act-3-open`. Rewards 400 xp, 100 shard.

**2 · Wingbroken.** A Galebird with a fouled wing in Skyhaven's ballast garden. Mother
Pell will not let anyone near it and the player is the first person she allows.
Objectives: `free-the-galebird`, `tame-galebird` ×1. `onComplete`:
`mount.unlock flying` ⚙, `flag.set mount-flying`. Rewards 450 xp, 120 shard.
_(A flying mount reaches every remaining island, so from here Act 3 is open.)_

**3 · Lanternfall.** The gallery lamps are the only thing dimming the engine's
overflow, and they are going out one shelf at a time because nobody has flown oil up
since the road stopped. Objectives: `carry-oil` ×6 (a haul quest, and the reason the
flying mount has cargo weight ⚙), `relight-galleries` ×4. Tobin's sister comes up in
conversation and the player is holding the answer. `onComplete`:
`flag.set component-lantern`, `flag.set ashgrove-reunited`, `discover town:lanternfall`.
Rewards 500 xp, 140 shard.

**4 · Cinderhelm.** What happens when a gallery goes dark: the shelf below is a burnt
half-town with the engine's exhaust vented under it, and something down there has been
in the red for a century. A dungeon dive into the rock, ending at
`enemy:cinderguard` — a guardian beast that is not hostile so much as _unable to
stop_. Objectives: `descend-the-vent`, `defeat-cinderguard`, `recover-the-record` ×1.
The record is the cities' own minutes: they built it, it worked, and then it did not.
`onComplete`: `flag.set knows-the-cities-built-it`, `discover town:cinderhelm`.
Rewards 550 xp, 160 shard.

**5 · The Orrery.** Marran Vess has been the villain of this act for four quests: she
sealed Cinderhelm, she stopped the oil flights, she has been hoarding the record. The
fight happens — `enemy:choirguard`, the engine's own defence, which she does not call
off — and when it is over she explains what she is actually doing, which is holding the
Red Bond _in_. It has a source and the source is not the engine, and every hand she has
taken off it in a hundred years has cost a region below. Objectives:
`reach-the-orrery`, `defeat-choirguard`, `hear-vess-out`. `onComplete`:
`flag.set vess-truth`, `flag.set act-3-complete`, `discover town:orrery`. Rewards
900 xp, 250 shard.

**Act closes on:** the instrument, the record and the engine agree. The source is not
above and it is not below. It is _between_ — and Mother Pell knows what it is, because
her garden was grown from a cutting of it.

**New content:** zone `cirrus`; carried layouts `gallery` ⚙, `orrery` ⚙; towns
`lanternfall`, `cinderhelm`, `orrery`; `npc:gain/skyhaven`,
`npc:sky-lamplighter/lanternfall`, `npc:vess` (body ⚙), `npc:coil/orrery`;
`enemy:cinderguard` (model ⚙), `enemy:choirguard` (model ⚙); `music:cirrus` ⚙.

---

### Act 4 — The Seam

**Theme.** Not a fourth region so much as the other three seen from inside the stitch:
a place where a meadow's horizon runs into a tide line runs into a cloud deck, all
three lit at once and none of them agreeing about where down is. The visual language is
**recombination** — the assets of Acts 1–3 in one sky — which is also what makes it
cheap to build.

**Zone.** `seam`, "The Seam". Its gateway is opened by the player rather than found,
which is the one thing this act needs that no earlier gateway does.

**Structure.** Act 4 has **no new towns**. Its three guardian quests happen in the three
existing zones and are staged out of the Encampment — the cast comes home, which is
worth more than a fourth hub and costs no geometry. The finale is one arena:
`landmark:the-seam`.

**Quests.** Arc `seam`.

| #   | Id                          | Type          | Giver               | Location             | Prerequisites          |
| --- | --------------------------- | ------------- | ------------------- | -------------------- | ---------------------- |
| 1   | `quest:seam/three-roads`    | talk          | `npc:gain`          | `town:encampment`    | `quest:sky/the-orrery` |
| 2   | `quest:seam/guardian-land`  | boss          | `npc:gain`          | `town:stonewatch`    | 1                      |
| 3   | `quest:seam/guardian-sea`   | boss          | `npc:coil/kelphold` | `landmark:maws-rest` | 1                      |
| 4   | `quest:seam/guardian-sky`   | boss          | `npc:sky-gardener`  | `town:orrery`        | 1                      |
| 5   | `quest:seam/the-first-bond` | boss + choice | `npc:sky-gardener`  | `landmark:the-seam`  | 2, 3, 4                |

Three parallel prerequisites converging on one — the whole cast reassembles at the
Encampment and the player picks their own order. Each guardian quest is **gated on the
mount its region taught**, which is the mechanical statement of "revisit all three
regions using every mount type": `quest:seam/guardian-land` requires
`{ "test": "flag", "flag": "mount-ground" }` and so on, and the fight is built so the
mount is not optional.

**1 · Three Roads.** Everyone the player has met is at the Encampment fire, including
Coil, and they do not agree about anything except that the three guardians have to be
let go. Objectives: `hear-them-out`, `choose-a-road` (×1 — starting any of 2–4 satisfies
it). `onComplete`: `flag.set seam-known`. Rewards 500 xp, 150 shard.

**2 · The Land Guardian.** `enemy:guardian/land` on Stonewatch's drove ground, where
the Bellwether died. Ground mount. `onComplete`: `flag.set guardian-land-freed`.
**3 · The Sea Guardian.** `enemy:guardian/sea` in the Maw's Rest trench. Water mount.
`onComplete`: `flag.set guardian-sea-freed`.
**4 · The Sky Guardian.** `enemy:guardian/sky` in the Orrery's open frame. Flying
mount. `onComplete`: `flag.set guardian-sky-freed`.
Each 800 xp, 200 shard. Each ends the same way: the guardian stops fighting and the red
thread goes slack, and something a long way off notices.

**5 · The First Bond.** Three slack threads open the Seam. Inside it is **Rhune**, the
first thing that was ever bonded — not a monster and not innocent, held for an age
between the three worlds by a machine built by people who were also not wrong. The
fight is real (`enemy:rhune`, three phases, one per mount). What follows is the choice,
and all three endings are honest:

- **Sever** — cut every bond, human and beast, for good. Nobody is ever compelled
  again and nobody is ever companioned again. `flag.set ending-severed`.
- **Hold** — repair the engine and keep holding, as Vess has. The world stays as it is
  and someone must always be at the lever. `flag.set ending-held`.
- **Share** — let Rhune loose and bond it, taking on what the machine was carrying.
  The Red Bond ends; what replaces it is unproven. `flag.set ending-shared`.

Objectives: `open-the-seam`, `defeat-rhune`, `decide` ×1. `onComplete`:
`flag.set act-4-complete` plus exactly one ending flag. Rewards 1500 xp, 500 shard.

**New content:** zone `seam`; `landmark:the-seam`; `enemy:guardian/land`,
`enemy:guardian/sea`, `enemy:guardian/sky`, `enemy:rhune` (models ⚙); `music:seam` ⚙.

---

## 5. Packaging

One package per act, plus a small always-resident one. Load order is the `requires`
chain; nothing here loads at boot except `core`.

| Package      | File                   | Requires | Loaded when                                                                                                 |
| ------------ | ---------------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `core`       | `data/core.json`       | —        | Imported. Ships in the main chunk.                                                                          |
| `story`      | `data/story.json`      | `core`   | At boot, after `core`. The hub every act's package requires. Small — see the two corrections below.         |
| `story-land` | `data/story-land.json` | `story`  | At boot, after `story` — see the correction below                                                           |
| `story-sea`  | `data/story-sea.json`  | `story`  | At boot — Act 2 is part of the open world (issue #144), so its islands must exist when the world is planned |
| `story-sky`  | `data/story-sky.json`  | `story`  | On `sky-revealed` — the flag Act 2's closer sets (issue #157). Skyhaven itself ships in `core`              |
| `story-seam` | `data/story-seam.json` | `story`  | On entering `seam`                                                                                          |

**Act 1's towns stay in `core`** — they are the shipped world and moving them would
make the starting world depend on a package. `story-land` adds only quests and the two
new NPCs.

**Two corrections, made when Act 1 was built (issue #143).** Both are about `core`
being a package like any other rather than a special case, and both were found by the
loader refusing what this section described.

- **`npc:gain`'s gated `talk` list lives in `core.json`, not in `story`.** An asset id
  is global and the loader reports a second definition of one as `duplicate-id`, so a
  later package cannot extend an NPC that `core` shipped — and `npc:gain` may not leave
  `core`, for the reason the towns may not. His rows therefore sit beside him and name
  `quest:land/…` ids that `core` does not ship, which is legal and checked: a quest id
  inside a condition or an action is a parameter to a registered handler, not a
  reference, and a row whose quest is not loaded never matches. `story` is left holding
  what genuinely is shared, which today is a `requires` edge and a note.
- **`story` and `story-land` load at boot, not at the zone edge.** `overworld` is the
  zone the game boots into and `ZoneManager` builds its starting zone directly, so an
  arrival hook would never fire on a fresh game — the only time it matters. The dungeon
  makes the point from the other side: quest 4 runs inside `hold`, and the objective
  router reads the active quest's own objectives, so the definitions have to be
  resident there too. `BootstrapOptions.packages` loads them under the `boot` lease and
  inside the cross-asset validation pass. Acts 2–4 are genuinely lazy and keep the
  table's "on entering" column.

**A zone's own package holds its towns**, so the sea's three settlements arrive with
the sea. This is what the lazy path in `src/content/storage/` was built for and the
first real use of it.

**An unloaded package does not unload progress.** Completed quest ids, flags and
discoveries live in `ContentState` and survive a package leaving; the definitions come
back when the player returns to the zone. That is already true of the runtime — it is
noted here because it is why per-zone packaging is safe.

---

## 6. Flag ledger

Every flag the story sets, in the order it can first be set. Flags are the story's
public API: a side quest, a shop, a piece of dialogue or a later act may test any of
them.

| Flag                                               | Set by                         | Means                                |
| -------------------------------------------------- | ------------------------------ | ------------------------------------ |
| `met-gain`                                         | `quest:land/first-light`       | Has spoken to Gain                   |
| `taming-learned`                                   | `quest:land/first-light`       | Taming is unlocked                   |
| `first-bond`                                       | `quest:land/the-first-bond`    | Has bonded a wild beast              |
| `mount-ground`                                     | `quest:land/the-mill-road`     | Ground mount unlocked                |
| `red-thread-seen`                                  | `quest:land/the-red-thread`    | Knows the corruption is manufactured |
| `sea-revealed`                                     | `quest:land/the-bellwether`    | Act 2 may begin                      |
| `act-1-complete`                                   | `quest:land/the-bellwether`    | —                                    |
| `has-boat`                                         | `quest:sea/salt-and-rope`      | Island travel available              |
| `mount-water`                                      | `quest:sea/dark-water`         | Water mount + dark-water auto-mount  |
| `dark-water-open`                                  | `quest:sea/dark-water`         | The trench is passable               |
| `component-lens`                                   | `quest:sea/the-drowned-market` | Device part 1                        |
| `component-vane`                                   | `quest:sea/the-rookery`        | Device part 2                        |
| `knows-the-sky`                                    | `quest:sea/the-rookery`        | Has met someone from above           |
| `device-built`                                     | `quest:sea/what-the-tide-kept` | The instrument works                 |
| `sky-revealed`                                     | `quest:sea/what-the-tide-kept` | Act 3 may begin                      |
| `act-2-complete`                                   | `quest:sea/what-the-tide-kept` | —                                    |
| `act-3-open`                                       | `quest:sky/the-long-ascent`    | Reached the Shelf                    |
| `mount-flying`                                     | `quest:sky/wingbroken`         | Flying mount unlocked                |
| `component-lantern`                                | `quest:sky/lanternfall`        | —                                    |
| `ashgrove-reunited`                                | `quest:sky/lanternfall`        | Tobin knows Mera is alive            |
| `knows-the-cities-built-it`                        | `quest:sky/cinderhelm`         | The reveal                           |
| `vess-truth`                                       | `quest:sky/the-orrery`         | The villain was holding it back      |
| `act-3-complete`                                   | `quest:sky/the-orrery`         | —                                    |
| `seam-known`                                       | `quest:seam/three-roads`       | Act 4 open                           |
| `guardian-land-freed`                              | `quest:seam/guardian-land`     | —                                    |
| `guardian-sea-freed`                               | `quest:seam/guardian-sea`      | —                                    |
| `guardian-sky-freed`                               | `quest:seam/guardian-sky`      | —                                    |
| `act-4-complete`                                   | `quest:seam/the-first-bond`    | —                                    |
| `ending-severed` / `ending-held` / `ending-shared` | `quest:seam/the-first-bond`    | Exactly one is set                   |

**Mount flags are set alongside the `mount.unlock` action, not instead of it.** The
action changes what the player can do; the flag is what content is allowed to test.
Keeping them separate is what lets a quest be gated on a mount without content reaching
into the mount system.

---

## 7. What the engine still needs

Everything marked ⚙ above, grouped by what kind of work it is. This is the build order
as much as the list: the top group blocks every quest, the bottom group blocks one act.

**Quest plumbing** — blocks all twenty quests. Most of it landed with quest 1
(issue #147); what is left is marked.

- ~~A **journal / quest UI**~~ — shipped as issue #98 (`src/ui/journal.ts`). Offering
  and turning in a quest is data after all: an `NpcData.talk` row gated on quest status
  with `quest.start` / `quest.complete` in its `actions`, first match wins. A dialogue
  with an accept/decline CHOICE is still a UI that does not exist; today the first
  conversation accepts.
- ~~**A quest lifecycle**~~ — `onStart`, `onComplete` and `rewards` are run from a
  `ContentState.onChange` subscriber in `main.ts`, so every path that changes a status
  gets them. It was on nobody's list and nothing ran them.
- **Objective triggers**: an objective declares `trigger: { kind, … }` and one router
  in `main.ts` joins the engine's events to it — so a kind is engine work and a quest
  that uses one is data. `orb-thrown` is wired; `tamed`, `enemy-killed`, `item-picked`,
  `town-arrival` and `zone-arrival` are declared and land with the quests that need
  them (#148 – #151).
- **`mount.unlock`** action (`kind: 'ground' | 'water' | 'flying'`), plus a mount gate
  that reads it — with #149.
- **`discover`-on-arrival**: the action exists; nothing calls it when a player walks
  into a town — with #149.

**Traversal** — blocks Act 2 and Act 3.

- **Water mounting**, and **auto-mount on contact with deep water**. Diving exists
  (`KeyC`, `src/world/underwater.ts`); the mount does not.
- **Deep water rendered dark and refused on foot** — the visual grammar the act
  depends on.
- **Balloon transition**: a gateway variant whose two ends are balloon models. Closest
  existing thing is `src/world/portal.ts`.
- **Cargo weight on a flying mount** — only `quest:sky/lanternfall` needs it; if it is
  cut, the quest becomes a plain collect.

**World builders** — one per act.

- Town layouts: `harbour` (Act 2), `gallery` and `orrery` as **carried** layouts (Act 3).
  Note carried layouts come from a different factory kind than ground ones.
- Zones `brine`, `cirrus`, `seam`, each with a terrain/water/sky character of its own.
- `biome:reef`.

**Bodies and models.**

- NPC bodies: `coil`, `vess`, `miller` (Mera), `boatwright` (Brack).
- Enemy models: `bellwether`, `bridle-hound`, `brineholder`, `cinderguard`,
  `choirguard`, `guardian-land`, `guardian-sea`, `guardian-sky`, `rhune`.
- Every new rig needs `bun tools/test-zfight.mjs` run and its offsets **measured, not
  reasoned about** — see the z-fighting note in [AGENTS.md](AGENTS.md).

**Music.** `music:brine`, `music:cirrus`, `music:seam` — three composed tracks, and
three `SHIPPED` credits entries in [src/ui/about.ts](src/ui/about.ts) _in the same
commit_, per the licence rule in [AGENTS.md](AGENTS.md).

**Nice to have, specified nowhere else.** **Kettle**, the named companion beast
(§2): needs a `BeastActor` that can carry an identity — a stable id, a fixed party
slot, and a name the HUD and dialogue can use. Every quest above is written to work
without it.

---

## 8. Originality

The three act themes are genre archetypes, deliberately built from ordinary craft
rather than from any particular work: a **pastoral frontier valley** (mills, drove
roads, watchtowers), a **working archipelago** (harbours, rope walks, salt lofts, tidal
markets), and **cloud-borne cities** (ballast gardens, lamp galleries, cable stays).
Sea voyages between islands, floating cities and bonded animals are all long-standing
public-domain furniture of the adventure genre; what is not reused is anything
identifiable from a specific work — no borrowed character, place, faction or coined
term, and no plot beat that only makes sense as a reference. Where an act's structure
resembles a well-known one, the resemblance is at the level of "a voyage with an island
per chapter", which is Homer before it is anyone else.

Names in this document were checked for the same reason: `Saltrest`, `Kelphold`,
`Gullspire`, `Lanternfall`, `Cinderhelm`, `Rhune`, `the Bridle` are constructed from
plain English roots and are not lifted. If a name later turns out to collide with
something notable, it is a string-table edit and an id rename — which is exactly why
[§1](#1-the-rules-the-story-obeys) insists the id is never the display name.
