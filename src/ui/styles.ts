/**
 * All HUD / shop CSS, injected once as a <style> tag.
 * Glassy panels, element-tinted accents, springy transitions.
 */

const CSS = `
/* ---- THE 16px FLOOR ------------------------------------------------------
   Issue #17: "No text should be below 16px." The report is a TV — a player far
   enough back that this HUD's smallest labels, which were 8.5px, are not small
   type but absent type — and the three it names are the mount prompt (10.5), the
   hotbar's key numbers (10) and the NPC interact pill (13.5).

   THE SCALE IS COMPRESSED, NOT MULTIPLIED, and that is the whole design of this
   change. Scaling the sheet by 16/8.5 to lift the floor would have taken the
   party panel to 540px and the hotbar to 109px slots — a HUD that eats the frame
   in order to be readable, which trades one accessibility problem for another.
   What the old sheet spent on SIZE this one spends on the axes it was already
   using: weight (600 to 900), colour, letter-spacing and the glass itself carry
   the hierarchy, so the type range closes from 8.5–19 to 16–22 and the
   containers grow by about a third rather than by double.

   16 IS A FLOOR, NOT A SIZE. A quiet label sits exactly on it; the thing beside
   it that used to be 3px larger is now 17, not 19. Read any pair of rules below
   as "these two are still different" — at this range one point is a real
   difference and three is a shout.

   EXEMPT: the developer instruments at the bottom of this file — the § console
   and the F3 panel — plus the F2 overlay. They are monospace readouts for
   whoever is building the game, deliberately dense so F3 can be read beside F2
   without either covering the world, and no player opens them.
   tools/test-textsize.mjs holds everything else to the floor, in the stylesheet
   AND on screen. */

/* inset:0 is the layout viewport, which on a phone is not the same box as what
   is on screen — it excludes nothing the browser's chrome is covering, and on an
   Android device in fullscreen it was measured at 110 px taller than the display
   (issue #16, see src/core/viewport.ts). Everything bottom-anchored here — the
   hotbar, the interact pill, the dialogue panel — hangs off the same edge the
   touch sticks fell through, so the HUD is sized from the same measurement, with
   inset:0 left underneath as the fallback. */
/* ON :root, NOT ON .bs-root, and that is a bug fix rather than tidying. The
   bag, the journal and the pause menu are appended to document.body — they are
   SIBLINGS of the HUD root, not children of it (see ui/journal.ts) — so a custom
   property declared on .bs-root never reached the one class that most wanted it:
   .bs-glass on a panel resolved --glass to nothing, the background declaration
   was dropped as invalid, and the panel was transparent. Nobody saw it because
   the scrim behind it was doing the darkening. Take the scrim's paint away and
   the world shows through the journal, which is how this was found.

   --pane is THE SAME TWO COLOURS AT FULL ALPHA. A panel is opaque and a chip is
   not: a shard pill or a hint floats over the world and wants to show it
   through, a drawer you opened to read has replaced the world for as long as it
   is up. Keeping the hues identical is what stops the two reading as two
   themes. */
:root{
  --glass:linear-gradient(165deg,rgba(30,38,54,.72),rgba(14,18,28,.82));
  --pane:linear-gradient(165deg,#1e2636,#0e121c);
  --stroke:rgba(255,255,255,.14);
}
.bs-root{position:fixed;inset:0;width:var(--bs-vw,auto);height:var(--bs-vh,auto);
  pointer-events:none;z-index:20;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  color:#eef2f8;user-select:none;-webkit-user-select:none;
}
/* .bs-journal is on this one because it is a SIBLING of the HUD root (see
   ui/journal.ts) and it is the one panel here built out of real document
   elements — a <ul> of objectives, <h3>, <p>. Without the reset the browser's
   own 40px list indent walks every objective line in off the left margin, which
   is exactly what it did. .bs-inv gets by without it only because it has no
   list and states a margin on each of its three paragraphs. */
.bs-root *,.bs-journal *{box-sizing:border-box;margin:0;padding:0}
.bs-root svg{display:block}
/* .bs-inv and .bs-journal are on the selector because those panels are SIBLINGS
   of the HUD root rather than children of it (see ui/inventory.ts) and both
   print the same caps in their headers. One rule with three hosts rather than
   three copies of the arithmetic below — a keycap that is 16px in one panel and
   13.75px in another is exactly the drift issue #17 is about. */
.bs-root kbd,.bs-inv kbd,.bs-journal kbd{display:inline-block;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.28);
  border-bottom-width:2px;border-radius:5px;padding:0 6px;font:inherit;font-weight:700;
  /* A cap is a QUIET fraction of the sentence it sits in — .86em — right up
     until the sentence is itself at the floor, at which point the fraction is
     under it. max() keeps both readings: the cap shrinks relative to a large
     line and stops at 16 (issue #17). Written this way rather than as a flat
     16px because a <kbd> in the 19px dialogue line should still read as a cap
     inside a sentence rather than as the same size as it. */
  font-size:max(16px,.86em);
  line-height:1.5;vertical-align:baseline}
/* Controller faces are round, and the shape alone tells the player which device
   the HUD is describing. The flat bottom border goes with it: a keycap has depth
   because a key travels, and a pad face reads as a printed circle. */
.bs-root kbd.pad{border-radius:50%;border-bottom-width:1px;padding:0;min-width:1.5em;
  text-align:center;margin:0 1px}
/* A face that is a WORD — Start, Options. See padKey in ui/index.ts: a circle
   sized for one character clips them, so those get a pill. */
.bs-root kbd.pad.wide{border-radius:999px;padding:0 7px}
.bs-glass{background:var(--glass);border:1px solid var(--stroke);border-radius:14px;
  box-shadow:0 8px 24px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.08);
  backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}
/* A PANEL IS NOT A CHIP. The four surfaces you open — the bag, the journal, the
   shop, the controls sheet — wear .bs-glass for its border and shadow and then
   take the glass back out of it: opaque, unblurred, square. Chips keep it. The
   rule is one selector list rather than an edit to .bs-glass because that class
   is worn by ten HUD readouts as well, and the world showing through a hint pill
   is the point of the pill. */
.bs-inv .pane,.bs-journal .pane,.bs-shop,.bs-keys{background:var(--pane);
  backdrop-filter:none;-webkit-backdrop-filter:none}

/* ---- title chip -------------------------------------------------------- */
.bs-title{position:absolute;top:14px;left:16px;display:flex;align-items:baseline;gap:8px;
  padding:8px 14px 9px;border-radius:12px}
.bs-title b{font-weight:900;font-size:17px;letter-spacing:.18em;
  background:linear-gradient(92deg,#ffd23f 10%,#ff8b4a 55%,#ff6b35 90%);
  -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent}
.bs-title span{font-size:16px;font-weight:600;color:rgba(238,242,248,.5);letter-spacing:.05em}

/* ---- menu button -------------------------------------------------------- */
/* TOP-LEFT, which is where a burger lives in everything else a player uses, and
   the one corner of this HUD that was empty in a normal run (the title chip
   above it is debug-only, and shifts this down when it is there).

   IT IS A REAL BUTTON in a layer that is otherwise pointer-events:none, so it
   opts itself back in. That is the only element in .bs-root that does — every
   other clickable thing here lives inside a panel which turns the whole layer
   on while it is up.

   The cap beside the icon is the binding, printed rather than hidden in the F1
   sheet: F10 is a key nobody presses by accident, which also makes it a key
   nobody finds by accident. It is hidden on a phone (the touch overlay has its
   own MENU button, and there is no key to name) by the same query that hides the
   hotbar — see the responsive section. */
.bs-menubtn{position:absolute;top:14px;left:16px;display:flex;align-items:center;gap:8px;
  padding:7px 12px;border-radius:12px;cursor:pointer;pointer-events:auto;
  color:rgba(238,242,248,.9);font:inherit;
  transition:filter .12s ease,transform .12s ease}
.bs-menubtn svg{width:20px;height:20px;display:block}
.bs-menubtn .cap{display:flex;gap:4px}
.bs-menubtn:hover{filter:brightness(1.22)}
.bs-menubtn:active{transform:translateY(1px)}
/* The debug title chip owns this corner when it is up, so the button steps
   below it rather than under it. Debug runs only — see the HUD constructor. */
.bs-root:has(.bs-title) .bs-menubtn{top:58px}

/* ---- currency counter --------------------------------------------------- */
/* The pill names the money as well as counting it (see src/i18n): the number is
   the loud part, the name a quieter chip-sized label beside it — same weight
   relationship the bag chips below already use for name vs count. */
.bs-shards{position:absolute;top:14px;right:16px;display:flex;align-items:center;gap:8px;
  padding:8px 14px;border-radius:999px}
.bs-shards .ic{width:21px;height:21px;color:#69d9ff;filter:drop-shadow(0 0 5px rgba(105,217,255,.55))}
.bs-shards .ic svg{width:100%;height:100%}
.bs-shards .num{font-variant-numeric:tabular-nums;font-weight:800;font-size:19px;letter-spacing:.02em;
  color:#dff5ff;text-shadow:0 1px 2px rgba(0,0,0,.5)}
.bs-shards .lbl{margin-left:-2px;font-size:16px;font-weight:700;letter-spacing:.04em;
  color:rgba(223,245,255,.72);text-shadow:0 1px 2px rgba(0,0,0,.5)}
/* ---- bag (stackable items) --------------------------------------------- */
/* Sits directly under the shard pill: money on top, stuff below it, both in
   the same corner. Empty until the first pickup, so a fresh save shows nothing. */
.bs-bag{position:absolute;top:64px;right:16px;display:flex;flex-direction:column;
  align-items:flex-end;gap:6px;transform-origin:100% 0}
.bs-bag .chip{display:flex;align-items:center;gap:8px;padding:5px 12px;border-radius:999px}
.bs-bag .sw{width:12px;height:12px;border-radius:3px;box-shadow:0 0 9px currentColor}
.bs-bag .nm{font-size:16px;font-weight:700;color:rgba(238,242,248,.82)}
.bs-bag .n{font-variant-numeric:tabular-nums;font-weight:800;font-size:17px;color:#fff;
  text-shadow:0 1px 2px rgba(0,0,0,.5)}
/* ---- readied taming orb -------------------------------------------------- */
/* BOTTOM RIGHT, and not under the bag chips with the rest of what you own: the
   bag is a readout you glance at between fights, and this is a control you use
   during one. Down here it is in the same corner of the eye as the hotbar. */
.bs-orb{position:absolute;right:16px;bottom:104px;display:flex;justify-content:flex-end;
  transform-origin:100% 100%}
.bs-orb .chip{display:flex;align-items:center;gap:8px;padding:5px 10px 5px 8px;
  border-radius:999px;border:1px solid color-mix(in srgb,var(--el) 55%,transparent);
  box-shadow:0 0 18px -8px var(--el)}
.bs-orb .oi{width:22px;height:22px;color:var(--el);display:block;
  filter:drop-shadow(0 0 5px color-mix(in srgb,var(--el) 70%,transparent))}
.bs-orb .oi svg{width:100%;height:100%;display:block}
.bs-orb .nm{font-size:16px;font-weight:700;color:rgba(238,242,248,.82)}
.bs-orb .n{font-variant-numeric:tabular-nums;font-weight:800;font-size:17px;color:#fff;
  text-shadow:0 1px 2px rgba(0,0,0,.5)}
.bs-orb .k{opacity:.85}

.bs-pop{animation:bsPop .38s cubic-bezier(.34,1.8,.64,1)}
@keyframes bsPop{0%{transform:scale(1)}45%{transform:scale(1.28)}100%{transform:scale(1)}}

/* ---- tracked quests ------------------------------------------------------ */
/* src/ui/journal.ts fills this through HUD.setQuests. THE RIGHT EDGE, IN THE
   VERTICAL MIDDLE, and the vertical part is the load-bearing half.

   The right column is already money (.bs-shards, top 14), the bag under it
   (.bs-bag, top 64, GROWS DOWNWARD as you pick things up) and the readied orb
   (.bs-orb, bottom 104). A tracker docked under the bag would have to guess how
   tall the bag is today, and a guess that is wrong once is two readouts on top
   of each other. Anchored at 38% of the height it clears all three whatever
   they are holding, and it stays clear of the crosshair because it is a
   right-aligned column 320px wide at most.

   RIGHT-ALIGNED TEXT, which is the other half of the move: a left-aligned block
   hanging off the right edge reads as something that failed to lay out. The
   objective indent flips with it.

   NO PANEL AROUND IT. Every other cluster on the HUD wears .bs-glass because
   each is a readout with edges — a bar, a count, a row of cards. This is prose,
   it is only on screen while the player asked for it to be, and a box around it
   would make the quietest thing here the loudest. The text-shadow is what keeps
   it legible over snow instead.

   IT IS OPT-OUT, PER QUEST, from the journal — see hudFlag in main.ts. A
   player running six quests at once is not being helped by six of them here.

   NOTHING STACKS ON IT ANY MORE. It used to step down under the menu button and
   the debug title plate, which is why those two :has() rules existed; on this
   edge it is alone, so the offsets are gone rather than mirrored. */
.bs-quests{position:absolute;top:38%;right:16px;left:auto;max-width:min(320px,42vw);
  display:flex;flex-direction:column;align-items:flex-end;text-align:right;gap:9px;
  transition:opacity .2s ease;
  text-shadow:0 1px 3px rgba(0,0,0,.75),0 0 10px rgba(0,0,0,.55)}
.bs-quests .q{display:flex;flex-direction:column;align-items:flex-end}
.bs-quests .qt-n{display:flex;align-items:baseline;flex-direction:row-reverse;gap:7px;
  font-size:16px;font-weight:800;letter-spacing:.02em;color:#fff}
.bs-quests .qt-n i{flex:none;width:7px;height:7px;border-radius:50%;
  background:rgba(238,242,248,.5);font-style:normal}
.bs-quests .q.c-main .qt-n i{background:#ffc44d;box-shadow:0 0 8px rgba(255,196,77,.9)}
.bs-quests .qt-s{margin-top:2px;padding-right:14px;display:flex;flex-direction:column;
  align-items:flex-end;gap:2px}
.bs-quests .qt-s span{font-size:16px;font-weight:600;line-height:1.35;
  color:rgba(238,242,248,.82)}
.bs-quests .qt-s span.ok{color:rgba(238,242,248,.45);text-decoration:line-through}
.bs-quests .qt-s b{font-weight:800;font-variant-numeric:tabular-nums}
/* The tracker is a distraction while a panel is up, and it is in the one corner
   the pause menu does not cover. Same idiom the compass already uses. */
.bs-root.shop-open .bs-quests,.bs-root.keys-open .bs-quests{opacity:0}

/* ---- compass ------------------------------------------------------------ */
/* Horizontal heading tape across the top centre, the Skyrim/Far Cry idiom: the
   direction the CAMERA looks sits under the amber pointer and the letters slide
   past as you turn.

   Styled against the rest of the HUD on purpose. Everything else here is soft
   rounded glass, which a critic filed as sharing no visual language with the
   chunky voxel world, so the compass is the opposite: zero border-radius, no
   blur, flat fills, 2px rules, and letters carried by a hard 1px black outline
   in four directions rather than a soft shadow. That outline is also what keeps
   it readable over both bright sand and dark canopy — the same failure mode the
   crosshair was filed for.

   Geometry, top down: pointer 0..10, band 10..46. The riding badge, level-up
   banner and toast stack below it were each pushed down by 34px to make room
   (they used to start at 18/58/96), and by a further 11 when the band grew for
   the 16px floor.

   THE BAND IS SIZED BY ITS LETTERS, which is why the floor (issue #17) moved
   every number in this block. Cardinals were 12px and ordinals 8.5 in a 26px
   window; at 17 and 16 the same row of type plus the tick band under it wants a
   36px window, which is where the widget's own 46 comes from. The WIDTH follows
   too — the tape is letters at fixed bearings, so wider letters over the same
   span means fewer of them legible at once, and min(420px,44vw) had room for
   barely three cardinals.

   WHAT THE FLOOR COSTS HERE, stated because it is real and was measured rather
   than guessed: a marker chip sized for a four-character tag at 16px is 60px
   wide where it was about 34, and markers are drawn OVER the tape by design (see
   .mk), so more of the strip is covered by a badge at any moment. Captured, a
   560px window shows four labels and a two-marker zone hides one of them. The
   alternatives are worse — shrinking the tag is the thing the issue forbids, and
   moving the chips out of the band costs the widget another 20px of height for a
   readout that already spans the top of the screen. */
.bs-compass{position:absolute;left:50%;top:10px;transform:translateX(-50%);
  width:min(560px,52vw);height:46px;transition:opacity .2s ease}
.bs-root.shop-open .bs-compass,.bs-root.keys-open .bs-compass{opacity:0}
/* The window clips the tape. The 16px mask fade at each end is the one soft
   edge in the widget and it earns its place: without it letters pop in and out
   at full opacity mid-glyph, which reads as a rendering fault.
   Fill alpha .6, up from a first pass at .52: captured facing south over open
   water the band read fine, but facing north into the canopy it disappeared
   into the dark green and only the two white rules were left holding the shape.
   Much past .6 and it starts to read as an opaque letterbox bar. */
.bs-compass .win{position:absolute;left:0;right:0;top:10px;height:36px;overflow:hidden;
  background:rgba(6,10,17,.6);
  border-top:2px solid rgba(238,242,248,.9);border-bottom:2px solid rgba(238,242,248,.9);
  -webkit-mask:linear-gradient(90deg,transparent 0,#000 16px,#000 calc(100% - 16px),transparent 100%);
  mask:linear-gradient(90deg,transparent 0,#000 16px,#000 calc(100% - 16px),transparent 100%)}
/* Centre rule, drawn last so it sits over tape AND markers: the pointer has to
   be unambiguous about which pixel column it is reading. */
.bs-compass .win::after{content:"";position:absolute;left:50%;top:0;bottom:0;width:2px;
  margin-left:-1px;background:rgba(255,210,63,.5)}
.bs-compass .tape{position:absolute;left:0;top:0;height:100%;will-change:transform}
.bs-compass .t{position:absolute;bottom:2px;width:2px;height:6px;margin-left:-1px;
  background:rgba(238,242,248,.62)}
.bs-compass .t.maj{height:9px;background:#eef2f8}
.bs-compass .lb{position:absolute;top:0;transform:translateX(-50%);font-weight:900;line-height:1;
  color:#fff;white-space:nowrap;
  text-shadow:1px 1px 0 #05070c,-1px 1px 0 #05070c,1px -1px 0 #05070c,-1px -1px 0 #05070c}
.bs-compass .lb.card{font-size:17px;top:2px;letter-spacing:.06em}
/* One point off the floor and not two: an ordinal is a two-letter word beside a
   one-letter one, so it is already the wider mark, and the tape reads as one row
   of type with a quiet half rather than as two sizes. The colour and the offset
   carry the difference the size used to. */
.bs-compass .lb.ord{font-size:16px;top:3px;letter-spacing:.06em;color:rgba(238,242,248,.7)}
/* Markers ride OVER the tape — a marker occluding the letter behind it is the
   correct priority, and it is what keeps the widget one band tall. */
.bs-compass .marks{position:absolute;inset:0}
.bs-compass .mk{position:absolute;left:50%;top:0;height:22px;min-width:20px;
  display:flex;align-items:center;justify-content:center;padding:0 5px;
  background:var(--mc);border:2px solid #05070c;
  font-size:16px;font-weight:900;letter-spacing:.04em;color:#05070c;
  will-change:transform}
/* A LABEL-LESS MARKER IS A PLAIN SQUARE (see CompassMarker.label in ui/index.ts)
   and must not inherit the box a four-character tag needs. Sized for 16px text
   the chip is 20x22, and captured at that size an unlabelled one read as a
   yellow slab across the tape rather than as a pin — so it keeps roughly the
   11x13 it had, centred on the labelled chips' band. */
.bs-compass .mk:empty{min-width:0;width:12px;height:14px;padding:0;top:4px}
/* Behind you: the chip parks at the end of the strip and turns into an arrow
   pointing the short way round to it. */
.bs-compass .mk.edge{padding:0;min-width:0;width:0;height:0;border:0;
  border-top:9px solid transparent;border-bottom:9px solid transparent;
  background:transparent;overflow:hidden;color:transparent;
  filter:drop-shadow(0 0 1px #05070c)}
.bs-compass .mk.edge.l{border-right:13px solid var(--mc)}
.bs-compass .mk.edge.r{border-left:13px solid var(--mc)}
.bs-compass .ptr{position:absolute;left:50%;top:0;width:0;height:0;margin-left:-7px;
  border-left:7px solid transparent;border-right:7px solid transparent;
  border-top:10px solid #ffd23f;filter:drop-shadow(0 1px 0 rgba(0,0,0,.85))}

/* ---- crosshair --------------------------------------------------------- */
/* Pure white voxel-style reticle: a centre pip plus four ticks.
   Centring is done with a transform on a zero-size box, NOT negative margins
   plus box-shadow offsets — the shadow construction made true centre depend on
   the element's own width, which is exactly the kind of thing that drifts a
   pixel or two off axis. With width/height 0 the element IS the centre point
   and every tick is a symmetric shadow around it, so it cannot be off-axis.
   A subtle drop-shadow keeps it legible on bright terrain without tinting it. */
.bs-cross{position:absolute;left:50%;top:50%;width:0;height:0;margin:0;
  transform:translate(-50%,-50%);border-radius:50%;
  background:#fff;
  box-shadow:
    0 0 0 1.5px #fff,
    0 -8px 0 1px #fff, 0 8px 0 1px #fff,
    -8px 0 0 1px #fff, 8px 0 0 1px #fff;
  filter:drop-shadow(0 0 1.5px rgba(0,0,0,.65));
  transition:opacity .2s ease}
.bs-root.shop-open .bs-cross,.bs-root.keys-open .bs-cross{opacity:0}

/* ---- hold-to-mount ring ------------------------------------------------ */
/* An annulus around the reticle, filled by a conic-gradient sweep — the same
   construction as the hotbar's cooldown, read the other way round (filling, not
   draining). The hole is punched with a radial mask rather than an opaque inner
   disc, because the HUD is a transparent overlay and there is no background
   colour to fake a hole with. Inner radius 19px clears the crosshair's 8px
   ticks with room to spare. */
/* Zero-size box AT the reticle, children hung off it — the same trick the
   crosshair uses, so the ring cannot drift off axis as the label changes width. */
.bs-mounthold{position:absolute;left:50%;top:50%;width:0;height:0;
  opacity:0;transition:opacity .18s ease}
.bs-mounthold.show{opacity:1}
.bs-mounthold .ring{position:absolute;left:-27px;top:-27px;width:54px;height:54px;border-radius:50%;
  background:conic-gradient(#8ef0ff 0deg,rgba(255,255,255,.16) 0deg);
  filter:drop-shadow(0 0 6px rgba(142,240,255,.45));
  -webkit-mask:radial-gradient(circle,transparent 19px,#000 20px);
  mask:radial-gradient(circle,transparent 19px,#000 20px)}
/* "HOLD F TO MOUNT", named in issue #17 and the worst case of the three: it is
   printed at the RETICLE, i.e. over whatever the player is aiming at, so it had
   the least contrast of any label in the HUD as well as the second-smallest
   size. Letter-spacing drops from .22em to .12em with the size — at 16px the old
   tracking pushed the phrase past the ring on both sides. */
.bs-mounthold .lbl{position:absolute;top:40px;left:50%;transform:translateX(-50%);
  font-size:16px;font-weight:900;letter-spacing:.12em;white-space:nowrap;
  color:rgba(238,242,248,.92);text-shadow:0 1px 3px rgba(0,0,0,.85)}

/* ---- riding badge ------------------------------------------------------ */
/* Top centre, NOT bottom centre. While the fill ring is a thing you are DOING
   at the reticle, this is a state you are in — and the bottom middle of the
   frame is exactly where the mount itself is drawn, so a badge there printed a
   label across the animal it was labelling (captured; that is why it moved).
   Above the toast stack and clear of the shard pill on the right.
   top was 18px before the compass took the top band, then 52px; see
   .bs-compass, whose band grew again for the 16px floor. */
.bs-riding{position:absolute;left:50%;top:64px;transform:translateX(-50%) translateY(-8px);
  padding:7px 16px;border-radius:999px;font-size:17px;font-weight:800;letter-spacing:.04em;
  color:#dff5ff;white-space:nowrap;opacity:0;
  box-shadow:0 8px 24px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.08),
    inset 3px 0 0 #8ef0ff;
  transition:opacity .28s ease,transform .28s cubic-bezier(.34,1.56,.64,1)}
.bs-riding.show{opacity:1;transform:translateX(-50%) translateY(0)}

/* ---- left cluster: one party panel (beasts + player hp) ----------------- */
/* Single continuous glass slab. The beast rows and the player HP block are
   sections inside it, not free-floating cards with a gap between them. */
/* 288px before the 16px floor (issue #17). A beast row is a name, a level chip
   and two bars, and the name is the part that ellipses — at 17px "Emberfox" and
   a "Lv 12" chip want 340 to sit on one line without the name being cut. */
.bs-left{position:absolute;left:16px;bottom:16px;display:flex;flex-direction:column;width:340px;
  padding:7px;border-radius:16px;background:var(--glass);border:1px solid var(--stroke);
  box-shadow:0 10px 28px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.09);
  backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}
.bs-beasts{display:flex;flex-direction:column-reverse;gap:2px}

.bs-beast{border-radius:11px;padding:8px 10px;position:relative;background:transparent;border:0;
  transition:background .35s ease,opacity .35s ease,box-shadow .35s ease,filter .35s ease}
.bs-beast.hidden{display:none}
.bs-beast.primary{background:linear-gradient(92deg,rgba(255,255,255,.11),rgba(255,255,255,.02));
  box-shadow:inset 3px 0 0 var(--el),inset 0 0 24px -12px var(--el)}
.bs-beast.support{opacity:.62;filter:saturate(.7)}
.bs-beast.support .badge{width:30px;height:30px}
.bs-beast.support .badge svg{width:17px;height:17px}
.bs-beast.support .nm{font-size:16px}
.bs-beast .bs-beast-in{display:flex;align-items:center;gap:10px}
.bs-beast .bs-beast-in.bs-swap{animation:bsSwap .5s cubic-bezier(.34,1.56,.64,1)}
@keyframes bsSwap{0%{transform:translateY(12px) scale(.9);opacity:.15}
  60%{transform:translateY(-3px) scale(1.04);opacity:1}100%{transform:none;opacity:1}}
.bs-beast .badge{width:38px;height:38px;border-radius:50%;flex:none;display:grid;place-items:center;
  position:relative;
  background:radial-gradient(circle at 34% 28%,rgba(255,255,255,.42),rgba(255,255,255,0) 46%),var(--el);
  color:rgba(255,255,255,.96);
  box-shadow:inset 0 -4px 8px rgba(0,0,0,.28),0 2px 8px rgba(0,0,0,.35)}
.bs-beast .badge svg{width:21px;height:21px;filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.4))}
/* The LOCOMOTION pip: where a beast can go, hung on the corner of what it
   hits with. A pip on the badge rather than a second badge in the row, because
   the row is already name / level / two bars in a 38px band and a second full
   badge pushed the name into an ellipsis on a phone. Dark disc under a light
   glyph, so it separates from the element colour behind it whatever that
   colour is — the badge fill is var(--el) and runs from #fff3c4 to #7a5fa8. */
.bs-beast .badge .loco{position:absolute;right:-3px;bottom:-3px;width:17px;height:17px;
  border-radius:50%;display:grid;place-items:center;
  background:rgba(10,14,22,.92);border:1.5px solid rgba(255,255,255,.42);
  color:rgba(255,255,255,.95);box-shadow:0 1px 3px rgba(0,0,0,.5)}
.bs-beast .badge .loco svg{width:11px;height:11px;filter:none}
.bs-beast.support .badge .loco{width:14px;height:14px;border-width:1.2px}
.bs-beast.support .badge .loco svg{width:9px;height:9px}
.bs-beast .meta{flex:1;min-width:0}
.bs-beast .row{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:4px}
.bs-beast .nm{font-weight:800;font-size:17px;letter-spacing:.02em;white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis;text-shadow:0 1px 2px rgba(0,0,0,.45)}
.bs-beast .lv{font-size:16px;font-weight:800;color:var(--el);background:rgba(255,255,255,.09);
  padding:1px 8px 2px;border-radius:999px;flex:none;filter:saturate(1.3) brightness(1.35)}
.bs-micro{height:5px;border-radius:3px;background:rgba(0,0,0,.42);overflow:hidden;
  box-shadow:inset 0 1px 2px rgba(0,0,0,.5)}
.bs-micro+.bs-micro{margin-top:3px}
.bs-micro>i{display:block;height:100%;border-radius:3px;transition:width .3s cubic-bezier(.22,1,.36,1)}
.bs-micro.hp>i{background:linear-gradient(90deg,#4fb548,#7ed465)}
/* The XP track keeps a faint amber wash of its own so a near-empty bar still
   reads as "no progress yet" instead of a widget that failed to render. */
.bs-micro.xp{background:linear-gradient(90deg,rgba(245,166,35,.2),rgba(255,210,63,.09)),rgba(0,0,0,.42)}
.bs-micro.xp>i{background:linear-gradient(90deg,#f5a623,#ffd23f)}

/* player hp: bottom section of the party panel, hairline divider instead of a gap */
.bs-hp{padding:9px 10px 4px;margin-top:5px;border-top:1px solid rgba(255,255,255,.1)}
.bs-hp .row{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:6px}
.bs-hp .lbl{font-size:16px;font-weight:900;letter-spacing:.18em;color:rgba(238,242,248,.72)}
.bs-hp .val{font-size:17px;font-weight:800;font-variant-numeric:tabular-nums;
  text-shadow:0 1px 2px rgba(0,0,0,.5)}
.bs-hp .track{position:relative;height:15px;border-radius:9px;background:rgba(0,0,0,.5);overflow:hidden;
  box-shadow:inset 0 2px 5px rgba(0,0,0,.55),inset 0 0 0 1px rgba(255,255,255,.07)}
.bs-hp .ghost{position:absolute;top:0;bottom:0;left:0;border-radius:9px;background:rgba(255,246,238,.85)}
.bs-hp .fill{position:absolute;top:0;bottom:0;left:0;border-radius:9px;transition:width .12s ease;
  filter:saturate(.8)}
.bs-hp .fill::after{content:"";position:absolute;left:0;right:0;top:0;height:46%;
  border-radius:9px 9px 0 0;background:linear-gradient(rgba(255,255,255,.4),rgba(255,255,255,.04))}

/* ---- hotbar ------------------------------------------------------------ */
.bs-hotbar{position:absolute;left:50%;bottom:38px;transform:translateX(-50%);display:flex;gap:11px}
/* 58px before the 16px floor (issue #17). The slot holds three things at once —
   a corner key cap, a centred icon and a cooldown numeral over both — and the
   key cap is the one the issue names. At 16px in a 58px box it touched the
   icon; 66 puts it back in its own corner without the row growing past what the
   dialogue panel above it already spans. */
.bs-slot{width:66px;height:66px;border-radius:15px;position:relative;display:grid;place-items:center;
  background:var(--glass);border:1px solid var(--stroke);
  box-shadow:0 6px 16px rgba(0,0,0,.32),inset 0 1px 0 rgba(255,255,255,.08);
  backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
  transition:transform .16s ease,box-shadow .25s ease;pointer-events:auto}
.bs-slot:hover{transform:translateY(-3px)}
/* Unearned slot: a solid-bordered slab with a padlock. The old dashed box with
   a big grey numeral read as an unimplemented placeholder rather than content
   the player has yet to unlock. */
.bs-slot.empty{border-style:solid;border-color:rgba(255,255,255,.13);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.05);opacity:.72}
.bs-slot.empty .key{color:rgba(255,255,255,.4)}
.bs-slot.empty .lock{width:22px;height:22px;color:#eef2f8;opacity:.45}
.bs-slot.empty .lock svg{width:100%;height:100%}
.bs-slot.filled{border-color:transparent;
  box-shadow:inset 0 0 0 1.5px var(--el2),0 6px 16px rgba(0,0,0,.32)}
/* THE NUMBER ON THE SLOT — issue #17's second named case. It was 10px at 62%
   white, which is a watermark rather than a label: the one thing the row exists
   to tell you is which key fires which skill. At the floor, and brighter, since
   the size is no longer doing the work of pushing it into the background. */
.bs-slot .key{position:absolute;top:3px;left:8px;font-size:16px;font-weight:800;
  color:rgba(255,255,255,.78);text-shadow:0 1px 2px rgba(0,0,0,.75)}
.bs-slot .ic{width:28px;height:28px;color:var(--el);transition:opacity .2s ease,filter .3s ease;
  filter:saturate(1.25) brightness(1.3) drop-shadow(0 1px 2px rgba(0,0,0,.5))}
.bs-slot .ic svg{width:100%;height:100%}
.bs-slot.ready .ic{animation:bsReadyGlow 2.4s ease-in-out infinite}
@keyframes bsReadyGlow{0%,100%{filter:saturate(1.25) brightness(1.3) drop-shadow(0 0 2px var(--el))}
  50%{filter:saturate(1.4) brightness(1.55) drop-shadow(0 0 8px var(--el))}}
.bs-slot.cooling .ic{opacity:.38;animation:none}
.bs-slot .cd{position:absolute;inset:2px;border-radius:12px;pointer-events:none}
.bs-slot .cdnum{position:absolute;inset:0;display:grid;place-items:center;font-size:20px;font-weight:900;
  font-variant-numeric:tabular-nums;color:#fff;text-shadow:0 1px 4px rgba(0,0,0,.85);pointer-events:none}
.bs-slot .nm{position:absolute;bottom:-22px;left:50%;transform:translateX(-50%);font-size:16px;
  font-weight:700;letter-spacing:.03em;white-space:nowrap;color:#e8e2d8;
  text-shadow:0 1px 3px rgba(0,0,0,.8)}
.bs-slot.bs-flash{animation:bsFlash .55s cubic-bezier(.34,1.56,.64,1)}
@keyframes bsFlash{0%{box-shadow:0 0 0 0 var(--el),inset 0 0 0 1.5px var(--el2);transform:scale(1)}
  40%{box-shadow:0 0 24px 6px var(--el),inset 0 0 14px var(--el2);transform:scale(1.14)}
  100%{box-shadow:inset 0 0 0 1.5px var(--el2),0 6px 16px rgba(0,0,0,.32);transform:scale(1)}}

/* ---- hint pill --------------------------------------------------------- */
/* "Press E — Talk to …", issue #17's third named case, and the one a player
   meets first: it is how the game says an NPC or a den can be used at all.
   118px before the hotbar's slots grew for the floor. */
.bs-hint{position:absolute;left:50%;bottom:128px;transform:translateX(-50%) translateY(8px);
  padding:9px 20px;border-radius:999px;font-size:18px;font-weight:700;letter-spacing:.02em;
  opacity:0;transition:opacity .28s ease,transform .28s cubic-bezier(.34,1.56,.64,1);white-space:nowrap}
.bs-hint.show{opacity:1;transform:translateX(-50%) translateY(0)}

/* ---- dialogue panel ---------------------------------------------------- */
/* Above the hint pill's 118px rather than in place of it: talking is not a
   modal, so a gateway countdown can still be running underneath while someone
   is mid-sentence. The accent bar is the toast's, in the amber this HUD already
   uses for "something wants your attention". */
.bs-dialogue{position:absolute;left:50%;bottom:174px;transform:translateX(-50%) translateY(10px);
  width:min(620px,86vw);padding:12px 18px 13px;border-radius:14px;text-align:left;
  box-shadow:0 14px 34px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.09),
    inset 3px 0 0 #ffd23f;
  opacity:0;transition:opacity .26s ease,transform .3s cubic-bezier(.34,1.5,.64,1)}
.bs-dialogue.show{opacity:1;transform:translateX(-50%) translateY(0)}
.bs-dialogue .who{font-size:16px;font-weight:900;letter-spacing:.16em;color:#ffd23f;
  text-transform:uppercase;text-shadow:0 0 10px rgba(255,210,63,.45);margin-bottom:4px}
.bs-dialogue .line{font-size:19px;font-weight:700;line-height:1.35;color:#f2f5fa;
  text-shadow:0 1px 3px rgba(0,0,0,.55)}
.bs-dialogue .foot{margin-top:8px;font-size:16px;font-weight:700;letter-spacing:.02em;
  color:rgba(230,236,245,.55)}

/* ---- level-up banner --------------------------------------------------- */
/* top was 58px before the compass took the top band, then 92px; see
   .bs-compass, whose band grew again for the 16px floor. */
.bs-banner{position:absolute;top:104px;left:50%;transform:translateX(-50%) translateY(-26px) scale(.94);
  opacity:0;padding:11px 30px 13px;border-radius:16px;text-align:center;
  transition:transform .45s cubic-bezier(.34,1.56,.64,1),opacity .35s ease}
.bs-banner.show{transform:translateX(-50%) translateY(0) scale(1);opacity:1}
.bs-banner .eyebrow{font-size:16px;font-weight:900;letter-spacing:.26em;color:#ffd23f;
  text-shadow:0 0 10px rgba(255,210,63,.6);margin-bottom:2px}
.bs-banner .txt{font-size:22px;font-weight:800;text-shadow:0 1px 3px rgba(0,0,0,.5)}
.bs-banner .txt em{font-style:normal;color:var(--el,#ffd23f);filter:saturate(1.3) brightness(1.35)}

/* ---- toasts ------------------------------------------------------------ */
/* top was 96px before the compass took the top band, then 130px; see
   .bs-compass, whose band grew again for the 16px floor.

   184 CLEARS THE LEVEL-UP BANNER, which 130 did not: the banner is 57px tall and
   started at 92, so a toast arriving while one was up was printed across its
   bottom edge — captured, and it is the only place two panels in this HUD were
   ever drawn over each other. The floor made the banner 71px, which turned a
   19px overlap into a 41px one, so the stack is now placed BELOW the banner's
   full height rather than at a number that predates it. */
.bs-toasts{position:absolute;top:184px;left:50%;transform:translateX(-50%);display:flex;
  flex-direction:column;gap:8px;align-items:center}
/* Same glass slab + accent-bar treatment as the party panel, so a toast never
   reads as an unstyled browser box dropped on top of a custom UI. */
.bs-toast{padding:9px 15px 10px;border-radius:12px;font-size:17px;font-weight:700;letter-spacing:.01em;
  max-width:410px;text-align:left;color:#eef2f8;text-shadow:0 1px 2px rgba(0,0,0,.5);
  background:var(--glass);border:1px solid var(--stroke);
  box-shadow:0 10px 26px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.09),inset 3px 0 0 #ffd23f;
  backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
  opacity:0;transform:translateY(-12px);
  transition:opacity .3s ease,transform .35s cubic-bezier(.34,1.56,.64,1)}
.bs-toast.show{opacity:1;transform:translateY(0)}
.bs-toast.hide{opacity:0;transform:translateY(-8px)}

/* ---- shop -------------------------------------------------------------- */
.bs-shopwrap{position:absolute;inset:0;display:grid;place-items:center;pointer-events:none}
/* THE SCRIM IS INVISIBLE AND STILL THERE, and both halves are deliberate.
   It no longer dims or blurs anything: a panel is opaque now, so darkening the
   half of the screen it does not cover was dimming the GAME to make a panel
   that needs no help stand out. But the element is load-bearing — it is the
   click-to-close target for the bag, the journal, the shop and the controls
   sheet, and it is the drop target that throws an item into the world
   (dropTarget in ui/inventory.ts). An opacity:0 element still takes
   clicks, so the reveal rules below go on animating nothing, harmlessly. */
.bs-scrim{position:absolute;inset:0;background:transparent;opacity:0;
  transition:opacity .28s ease}
.bs-shop{position:relative;width:min(1000px,94vw);max-height:84vh;display:flex;flex-direction:column;
  border-radius:0;opacity:0;transform:translateY(16px) scale(.96);
  transition:opacity .3s ease,transform .34s cubic-bezier(.34,1.45,.64,1);
  box-shadow:0 24px 64px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.1)}
.bs-shopwrap.open{pointer-events:auto}
.bs-shopwrap.open .bs-scrim{opacity:1}
.bs-shopwrap.open .bs-shop{opacity:1;transform:translateY(0) scale(1)}
.bs-shop-head{display:flex;align-items:center;gap:14px;padding:16px 20px 14px;
  border-bottom:1px solid rgba(255,255,255,.1)}
.bs-shop-head h2{font-size:22px;font-weight:900;letter-spacing:.04em;flex:1;
  text-shadow:0 1px 3px rgba(0,0,0,.5)}
.bs-shop-head .bal{display:flex;align-items:center;gap:7px;padding:6px 13px;border-radius:999px;
  background:rgba(105,217,255,.1);border:1px solid rgba(105,217,255,.28)}
.bs-shop-head .bal .ic{width:17px;height:17px;color:#69d9ff}
.bs-shop-head .bal .ic svg{width:100%;height:100%}
.bs-shop-head .bal b{font-size:17px;font-weight:800;font-variant-numeric:tabular-nums;color:#dff5ff}
.bs-shop-x{width:34px;height:34px;border-radius:10px;border:1px solid rgba(255,255,255,.16);
  background:rgba(255,255,255,.07);color:rgba(238,242,248,.8);display:grid;place-items:center;
  cursor:pointer;transition:background .15s,transform .15s;pointer-events:auto}
.bs-shop-x:hover{background:rgba(255,90,80,.28);transform:scale(1.06);color:#fff}
.bs-shop-x svg{width:15px;height:15px}
/* 244px before the 16px floor: an offer card is a title, a two-line description
   and a row of stat chips, and at 16px the chips wrapped to three rows in a
   244px column. 296 holds the same card in two rows again. */
.bs-offers{display:grid;grid-template-columns:repeat(auto-fill,minmax(296px,1fr));gap:12px;
  padding:16px 20px;overflow-y:auto;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.25) transparent}
.bs-offer{position:relative;border-radius:14px;padding:15px 14px 13px;overflow:hidden;
  background:rgba(255,255,255,.055);border:1px solid rgba(255,255,255,.1);
  transition:transform .16s ease,box-shadow .22s ease,border-color .22s ease}
.bs-offer:hover{transform:translateY(-2px);border-color:var(--el2);
  box-shadow:0 8px 22px rgba(0,0,0,.35),0 0 16px -6px var(--el)}
.bs-offer.locked{opacity:.55;filter:saturate(.6)}
.bs-offer.locked:hover{transform:none;box-shadow:none;border-color:rgba(255,255,255,.1)}
.bs-offer .accent{position:absolute;top:0;left:0;right:0;height:4px}
.bs-offer .top{display:flex;align-items:center;gap:9px;margin-bottom:6px}
.bs-offer .oic{width:34px;height:34px;border-radius:9px;flex:none;display:grid;place-items:center;
  background:var(--el2);color:var(--el);filter:saturate(1.2) brightness(1.25)}
.bs-offer .oic svg{width:19px;height:19px}
.bs-offer h3{font-size:17px;font-weight:800;letter-spacing:.01em}
.bs-offer .beast{font-size:16px;font-weight:600;color:rgba(238,242,248,.55);margin-top:1px}
/* min-height is THREE lines of the new size, not two. It exists so every card in
   a row ends its buy button on the same baseline, and the longest description in
   the game went from two lines to three at 16px — captured, Tailwind's card sat
   24px taller than the two beside it. */
.bs-offer p{font-size:16px;line-height:1.45;color:rgba(238,242,248,.78);min-height:70px;margin-bottom:8px}
.bs-chips{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:10px}
.bs-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 9px 3px;border-radius:999px;
  background:rgba(255,255,255,.09);font-size:16px;font-weight:700;color:rgba(238,242,248,.85)}
.bs-chip b{color:#fff}
.bs-offer .foot{display:flex;align-items:center;gap:10px}
.bs-price{display:flex;align-items:center;gap:5px;font-weight:800;font-size:17px;
  font-variant-numeric:tabular-nums;color:#dff5ff}
.bs-price .ic{width:16px;height:16px;color:#69d9ff}
.bs-price .ic svg{width:100%;height:100%}
.bs-price.no{color:#ff8d84}
.bs-price.no .ic{color:#ff8d84}
.bs-buy{flex:1;padding:8px 0 9px;border-radius:10px;border:none;font-family:inherit;font-weight:800;
  font-size:17px;letter-spacing:.05em;cursor:pointer;color:#3a2703;
  background:linear-gradient(180deg,#ffd94f,#f5a623);
  box-shadow:0 3px 8px rgba(0,0,0,.3),inset 0 1px 0 rgba(255,255,255,.45);
  transition:transform .12s ease,filter .15s ease;pointer-events:auto}
.bs-buy:hover{filter:brightness(1.1);transform:translateY(-1px)}
.bs-buy:active{transform:translateY(1px) scale(.98)}
.bs-buy:disabled{cursor:default;background:rgba(255,255,255,.1);color:rgba(238,242,248,.4);
  box-shadow:none;transform:none;filter:none}
.bs-buy.owned{background:rgba(109,191,75,.18);color:#8fe06b;border:1px solid rgba(109,191,75,.4);
  display:flex;align-items:center;justify-content:center;gap:6px;cursor:default;box-shadow:none}
.bs-buy.owned svg{width:15px;height:15px}
.bs-shop-foot{border-top:1px solid rgba(255,255,255,.1);padding:11px 20px;display:flex;gap:16px;
  flex-wrap:wrap;justify-content:center;font-size:16px;font-weight:600;color:rgba(238,242,248,.7)}
.bs-shop-foot span{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}

/* ---- controls sheet (F1) ------------------------------------------------ */
/* Same wrapper/scrim/panel construction as the shop above, and deliberately so:
   it is the second modal in the game and a player who has opened one has
   already learned how this one dismisses. It reuses .bs-scrim and .bs-shop-x
   outright for that reason.

   The BODY is auto-fit columns rather than one long list. Twenty rows in a
   single column is 900px of panel, which at 1080 needs the sheet to scroll
   before the player has read the first section; in two columns of ~360px the
   whole thing fits on screen at once and the sections reflow to one column on a
   narrow window without a breakpoint. Each section is its own grid, so a wider
   heading in one cannot push another's key columns out of line.

   The key columns are FIXED widths, not auto: they are the same handful of caps
   in every row, and letting them size to content made the ']' row's columns
   half the width of the WASD row's, which reads as a broken table. 118/104 is
   measured off the widest cell each has to hold: the Space cap in the keyboard
   column, and the four D-pad arrows in the controller one. (96/86 before the
   16px floor took the caps from 10.75 to 16 — see the .bs-root kbd rule.) */
.bs-keyswrap{position:absolute;inset:0;display:grid;place-items:center;pointer-events:none}
.bs-keys{position:relative;width:min(1120px,96vw);max-height:88vh;display:flex;flex-direction:column;
  border-radius:0;opacity:0;transform:translateY(16px) scale(.96);
  transition:opacity .3s ease,transform .34s cubic-bezier(.34,1.45,.64,1);
  box-shadow:0 24px 64px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.1)}
.bs-keyswrap.open{pointer-events:auto}
.bs-keyswrap.open .bs-scrim{opacity:1}
.bs-keyswrap.open .bs-keys{opacity:1;transform:translateY(0) scale(1)}
.bs-keys-head{display:flex;align-items:center;gap:14px;padding:16px 20px 14px;
  border-bottom:1px solid rgba(255,255,255,.1)}
.bs-keys-head h2{font-size:22px;font-weight:900;letter-spacing:.04em;flex:1;
  text-shadow:0 1px 3px rgba(0,0,0,.5)}
.bs-keys-body{display:grid;grid-template-columns:repeat(auto-fit,minmax(440px,1fr));
  gap:4px 28px;padding:12px 20px 2px;overflow-y:auto;
  scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.25) transparent}
.bs-keys-sec{align-content:start;padding-bottom:5px}
/* Row padding 3px, where it was 5. The sheet is meant to be read WITHOUT
   scrolling at 1080 (see the note above), and thirty rows at the 16px floor are
   about 120px taller than they were — so the space comes back out of the gaps
   between rows rather than out of the rows themselves. */
.bs-keyrow{display:grid;grid-template-columns:minmax(0,1fr) 118px 104px 68px;align-items:center;
  gap:8px;padding:3px 8px;border-radius:9px;font-size:17px}
.bs-keyrow:not(.head):nth-child(even){background:rgba(255,255,255,.04)}
.bs-keyrow .nm{display:flex;flex-direction:column;gap:1px;font-weight:700;
  color:rgba(238,242,248,.92)}
/* The caveat under a row — the climb note, the combo note. Quiet on purpose:
   it is the second thing the row says, and a player scanning for a key should
   scan past it. */
.bs-keyrow .nm em{font-style:normal;font-size:16px;font-weight:600;line-height:1.35;
  color:rgba(238,242,248,.5)}
.bs-keyrow .kbm,.bs-keyrow .pad{text-align:right;white-space:nowrap;
  color:rgba(238,242,248,.9)}
.bs-keyrow .pad .none{color:rgba(238,242,248,.32);font-weight:700}
/* HOLD vs PRESS, and the whole reason the sheet is a table rather than a list.
   HOLD is the loud one — amber fill, dark text, the hotbar's own "this is
   ready" colour — because tapping a key that wants to be leaned on is the
   mistake a player blames the game for. PRESS is deliberately almost invisible:
   it is the default, and printing it as quietly as possible is what makes the
   handful of HOLD rows jump off the page. */
.bs-keyrow .mode{justify-self:end;padding:2px 8px 3px;border-radius:999px;
  font-size:16px;font-weight:800;letter-spacing:.04em}
.bs-keyrow .mode.hold{background:linear-gradient(180deg,#ffd94f,#f5a623);color:#3a2703;
  box-shadow:0 1px 5px rgba(245,166,35,.35)}
.bs-keyrow .mode.press{background:rgba(255,255,255,.07);color:rgba(238,242,248,.45)}
.bs-keyrow.head{margin-top:3px;padding-bottom:5px;border-bottom:1px solid rgba(255,255,255,.1);
  border-radius:0}
.bs-keyrow.head .nm{font-size:17px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;
  color:#ffd23f}
.bs-keyrow.head .kbm,.bs-keyrow.head .pad{font-size:16px;font-weight:800;letter-spacing:.02em;
  text-transform:uppercase;color:rgba(238,242,248,.42)}
.bs-keys-foot{border-top:1px solid rgba(255,255,255,.1);padding:11px 20px;text-align:center;
  font-size:16px;font-weight:600;color:rgba(238,242,248,.7)}

/* ---- inventory (I) ------------------------------------------------------ */
/* src/ui/inventory.ts. It wears the HUD's glass rather than the pause menu's
   wood, because it is a view of things you own in the world rather than of the
   session — the same line ui/pause.ts's header draws — so it reuses .bs-scrim,
   .bs-glass, .bs-shop-x, .bs-chip and .bs-buy outright.

   A RIGHT-HAND DOCK, FULL HEIGHT, and the reason is the stage at the top of it.
   Three figures standing over their own gear slots only reads as a party if
   there is height to stand in, and a centred box tall and wide enough for that
   covers the world it is a view of. Docked, half the frame is still the place
   you are standing in — and the panel gets the one axis it actually needs,
   since a slot wall grows downward and a description does not exist any more.

   z-index 40, alongside .bs-pause: over the HUD (20) and the touch overlay
   (30), under the title screen (50).

   MEASURED IN --bs-vh, NOT dvh, for issue #16's reason: on a phone in
   fullscreen those disagreed by 110 px, and here that lands as a footer below
   the bottom of the screen. See core/viewport.ts.

   IT SLIDES IN FROM THE EDGE IT IS ATTACHED TO. A dock that fades in place
   reads as a dialog that happened to be over there; one that comes in from the
   right reads as a drawer, which is what it is. */
.bs-inv{position:fixed;inset:0;z-index:40;display:flex;justify-content:flex-end;
  pointer-events:auto;touch-action:manipulation;-webkit-tap-highlight-color:transparent;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  color:#eef2f8;user-select:none;-webkit-user-select:none}
.bs-inv .bs-scrim{opacity:0}
.bs-inv.open .bs-scrim{opacity:1}
/* ELEVEN COLUMNS WIDE, which is what sets this number rather than a taste: at
   a 52px slot and a 9px gap the wall alone is 662px, and the dock is that plus
   its own padding. It is still a dock and not a full-screen sheet — the world
   is meant to stay visible beside it — so on anything narrower than about
   1100px it is simply most of the window, which is the honest outcome. */
.bs-inv .pane{position:relative;width:min(710px,100vw);height:var(--bs-vh,100dvh);
  display:flex;flex-direction:column;min-height:0;
  border-radius:0;border-right:none;
  opacity:0;transform:translateX(26px);
  transition:opacity .24s ease,transform .3s cubic-bezier(.22,1,.36,1);
  box-shadow:-24px 0 64px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.1)}
.bs-inv.open .pane{opacity:1;transform:translateX(0)}
.bs-inv .head{display:flex;align-items:center;gap:14px;padding:14px 18px 12px;
  border-bottom:1px solid rgba(255,255,255,.1)}
.bs-inv .head h2{font-size:22px;font-weight:900;letter-spacing:.04em;flex:1;
  text-shadow:0 1px 3px rgba(0,0,0,.5)}
/* The keys that close it, printed beside the X instead of spelled out along the
   bottom of the panel. .cap is the class every "this control is bound to
   that" glyph in here wears, so the phone rule can hide all of them at once. */
.bs-inv .head .cap{display:flex;gap:5px;opacity:.62}

/* THE STAGE. A live WebGL canvas (ui/inventory-stage.ts) showing the hero with
   his two beasts, each standing over the gear slot that holds it.

   It is given a FIXED share of the panel's height rather than an aspect ratio:
   the slot wall below it is what has to grow when the window does, and a stage
   sized off its own width would eat the wall on a tall narrow dock. 210px is
   two heads and a wingspan at this width; below 620px of viewport height the
   media query at the bottom of this file takes it down to 150.

   pointer-events:none on the canvas — there is nothing to click on it, and
   leaving it live meant a drag that crossed it lost the drop. */
.bs-inv .stage{position:relative;height:230px;flex:none;
  background:radial-gradient(120% 90% at 50% 12%,rgba(120,170,255,.14),transparent 70%)}
.bs-inv .stage-gl{position:absolute;inset:0;width:100%;height:100%;
  display:block;pointer-events:none}

/* THE THREE GEAR SLOTS, in the wireframe's order: lead beast, weapon, support
   beast — the order the three figures stand in on the stage directly above.
   Equal thirds, so the middle one lines up with the hero. */
/* Four now: lead beast, weapon, support beast, taming orb. Still one equal
   track each rather than a narrower fourth — a slot you drag onto has to be the
   same size as the ones beside it, or it reads as a status pip. */
.bs-inv .gear{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;
  padding:0 18px 12px;border-bottom:1px solid rgba(255,255,255,.08)}
.bs-inv .gs{position:relative;display:flex;flex-direction:column;align-items:center;gap:2px;
  padding:7px 6px 6px;border-radius:14px;font-family:inherit;color:inherit;
  border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);
  transition:transform .14s ease,border-color .18s ease,box-shadow .2s ease}
.bs-inv .gs.full{cursor:grab;border-color:var(--el);box-shadow:0 0 20px -10px var(--el)}
.bs-inv .gs.full:hover{transform:translateY(-2px);box-shadow:0 0 22px -6px var(--el)}
.bs-inv .gs.full:active{cursor:grabbing}
.bs-inv .gs:focus-visible{outline:2px solid #ffd23f;outline-offset:-2px}
/* The same ring the wall's selected cell wears, and it means the same thing:
   the footer's buttons are pointed at this. A gear slot is now the ONLY place
   an equipped row can be selected from — it is no longer on the wall as well. */
.bs-inv .gs.sel{outline:2px solid #69d9ff;outline-offset:-2px}
.bs-inv .gs.r-rare{border-color:rgba(105,217,255,.5)}
.bs-inv .gs.r-legendary{border-color:rgba(255,190,80,.62)}
.bs-inv .gs-ic{width:52px;height:52px;display:block}
/* The slot's ROLE only — see the note in gearHtml. There is no element for the
   item's NAME here on purpose, which is also what keeps the three slots the
   same width whatever is standing in them. */
.bs-inv .gs-l{font-size:16px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;
  color:rgba(238,242,248,.42);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  max-width:100%}
/* A legal drop target, while something is being dragged over it. */
.bs-inv .drop-ok{border-color:#8fe06b;box-shadow:0 0 0 2px rgba(143,224,107,.35) inset,
  0 0 22px -6px rgba(143,224,107,.9)}

/* THE THREE MOUNT BADGES — ground, water, flying, in the order the story hands
   them out. A ROW OF PIPS AND NOT FOUR MORE GEAR SLOTS, deliberately: a slot in
   the strip above is something you drag onto, and these take no gesture at all
   (see mountsHtml). Small, centred and unlabelled is what says "a readout" —
   the words are in the tooltip and in aria-label, which is also why nothing here
   needs the 16px type floor. */
.bs-inv .mounts{display:flex;justify-content:center;gap:10px;padding:10px 18px;
  border-bottom:1px solid rgba(255,255,255,.08)}
.bs-inv .mt{width:38px;height:32px;display:flex;align-items:center;justify-content:center;
  border-radius:10px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);
  color:var(--el);opacity:.4;cursor:help;transition:opacity .18s ease,border-color .18s ease,
  box-shadow .2s ease}
/* UNLOCKED IS THE LIT ONE. The locked state is the same badge at 40% rather than
   a padlock over it: the glyph is the thing worth recognising, and a second
   symbol on top of it would be the panel shouting about what you cannot do. */
.bs-inv .mt.on{opacity:1;border-color:var(--el);box-shadow:0 0 18px -8px var(--el)}
.bs-inv .mt:hover{opacity:1}
/* Square and fixed, overriding the 70%-of-the-box .ic.glyph sizing further
   down: that rule is written for a gear slot, whose box is already square, and
   70% of a 38x32 pip is an oblong the SVG then letterboxes itself inside. Four
   classes so it wins on specificity rather than on being later in the file. */
.bs-inv .mt .ic.glyph{width:20px;height:20px;margin:0}

.bs-inv .tabs{display:flex;gap:6px;flex-wrap:wrap;padding:11px 18px 0}
.bs-inv .chip{padding:5px 12px 6px;border-radius:999px;border:1px solid rgba(255,255,255,.14);
  background:rgba(255,255,255,.05);color:rgba(238,242,248,.72);font-family:inherit;
  font-size:16px;font-weight:700;cursor:pointer;transition:background .15s,color .15s,border-color .15s}
.bs-inv .chip:hover{background:rgba(255,255,255,.12);color:#fff}
.bs-inv .chip.on{background:rgba(105,217,255,.16);border-color:rgba(105,217,255,.5);color:#dff5ff}

/* THE WALL. INV_COLS in ui/inventory.ts is the same 5 the keyboard's up/down
   steps by, handed here through --cols; auto-fill would let the two disagree
   about what "the row below" means, and a media query that narrowed one without
   the other would leave arrow-down skipping slots with nothing failing.
   minmax(0,1fr) and not 1fr — a grid item's automatic minimum size is its
   CONTENT, so a plain 1fr refuses to shrink and the wall overflows its column.
   THE WALL SCROLLS AND THE PANEL DOES NOT: it is the one part with no natural
   length, and a panel that scrolled as a whole would move the footer's Salvage
   button every time the player picked up a flower. */
.bs-inv .grid{display:grid;grid-template-columns:repeat(var(--cols,5),minmax(0,1fr));
  gap:9px;align-content:start;overflow-y:auto;min-height:0;min-width:0;flex:1;
  padding:12px 18px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.25) transparent}
.bs-inv .slot{position:relative;aspect-ratio:1;border-radius:13px;cursor:grab;
  display:grid;place-items:center;padding:5px;font-family:inherit;color:inherit;
  border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);
  transition:transform .14s ease,border-color .18s ease,box-shadow .2s ease}
.bs-inv .slot:hover{transform:translateY(-2px);border-color:var(--el);
  box-shadow:0 8px 20px rgba(0,0,0,.35),0 0 16px -6px var(--el)}
.bs-inv .slot:active{cursor:grabbing}
/* The selection ring is an OUTLINE rather than a border so it cannot change the
   slot's box and reflow the wall as the cursor walks it. */
/* AN EMPTY CELL IS A REAL CELL — see INV_COLS in ui/inventory.ts. Quieter than
   a filled one, and a <div> rather than a <button> so a keyboard walks the
   things you own rather than the holes between them. It IS in the drag
   machinery, which is the change issue #116 made: an empty cell is where a
   dragged box lands, so it has to be something elementFromPoint can see —
   which rules out pointer-events:none. It still lifts for nothing on hover.
   A .held cell is one whose row the tab filter is hiding: no landing, because
   a swap with a box that is not on screen is a move nobody made. */
.bs-inv .slot.empty{background:rgba(255,255,255,.035);border-color:rgba(255,255,255,.09);
  cursor:default}
.bs-inv .slot.empty:hover{transform:none;border-color:rgba(255,255,255,.09);box-shadow:none}
.bs-inv .slot.empty.held{background:rgba(255,255,255,.02);border-style:dashed}
.bs-inv .slot.sel{outline:2px solid #69d9ff;outline-offset:-2px;background:rgba(105,217,255,.1)}
.bs-inv .slot:focus-visible{outline:2px solid #ffd23f;outline-offset:-2px}
/* Rarity is the slot's EDGE, not its fill: a legendary item still has to read
   as the same kind of box as the one beside it. */
.bs-inv .slot.r-rare{border-color:rgba(105,217,255,.45)}
.bs-inv .slot.r-legendary{border-color:rgba(255,190,80,.6);
  box-shadow:inset 0 0 22px -10px rgba(255,190,80,.9)}
/* Equipped: a corner dot, which survives every rarity border above it because
   it is a separate corner. */
.bs-inv .slot.on::after{content:'';position:absolute;top:5px;right:5px;width:8px;height:8px;
  border-radius:50%;background:#8fe06b;box-shadow:0 0 8px rgba(143,224,107,.9)}
/* Every picture in the panel is one element with a background: an atlas tile
   (weapon-icons.ts), a baked 3D portrait (inventory-stage.ts), or the lozenge
   below when there is neither. */
.bs-inv .ic{width:100%;height:100%;display:block;background-repeat:no-repeat;
  background-position:center;background-size:contain}
.bs-inv .ic.blob{background-image:none;
  background:radial-gradient(circle at 38% 32%,#fff2,transparent 60%),var(--el);
  border-radius:26% 26% 30% 30%/30%;box-shadow:0 0 14px -4px var(--el);
  width:62%;height:62%;margin:auto}
/* A fourth picture: an INLINE SVG glyph, tinted by the item's own colour through
   currentColor (ui/icons.ts). The drop shadow is what keeps a Master Orb —
   near-black on a dark panel — from vanishing into its slot. */
.bs-inv .ic.glyph{background:none;width:70%;height:70%;margin:auto;color:var(--el);
  filter:drop-shadow(0 0 6px rgba(255,255,255,.28))}
.bs-inv .ic.glyph svg{width:100%;height:100%;display:block}
.bs-inv .slot .n{position:absolute;top:4px;left:7px;font-size:16px;font-weight:800;
  font-variant-numeric:tabular-nums;color:#fff;text-shadow:0 1px 3px #000,0 0 6px #000}
/* Everything else fades while a drag is in flight, so the legal targets are the
   only lit things on the panel. */
.bs-inv.dragging .slot,.bs-inv.dragging .gs{opacity:.55}
.bs-inv.dragging .drop-ok{opacity:1}
/* THE BOX IN THE AIR (issue #116). The panel drives its own drag off pointer
   events, so it draws its own cursor freight: one cell-sized tile carrying the
   row's picture, parked under the pointer by a transform. It must not be a
   drop target of its own — the drag reads the wall through
   document.elementFromPoint, which would otherwise find nothing but this. */
.bs-inv .drag-ghost{position:fixed;top:0;left:0;z-index:2;width:56px;height:56px;
  margin:-28px 0 0 -28px;padding:5px;border-radius:13px;pointer-events:none;
  display:grid;place-items:center;
  border:1px solid var(--el);background:rgba(10,14,22,.85);
  box-shadow:0 10px 26px rgba(0,0,0,.5),0 0 20px -6px var(--el)}

/* THE FOOTER STRIP: what is selected, and the two things that destroy it. The
   constructive action is a right-click and is only NAMED here — see the header
   of ui/inventory.ts for why nothing destructive is one click from anything. */
.bs-inv .sel{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:26px;
  padding:10px 18px;border-top:1px solid rgba(255,255,255,.1)}
.bs-inv .sel .nm{font-size:17px;font-weight:800;flex:1;min-width:0;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bs-inv .sel .bs-buy{flex:none;display:inline-flex;align-items:center;gap:7px;
  padding:5px 12px 6px;font-size:16px}
/* The BINDING, as a picture on the button it belongs to. See footHtml: an
   action with no bound control simply has no icon, which is the rule working. */
.bs-inv .sel .cap{display:block;width:17px;height:17px;opacity:.85}
.bs-inv .sel .cap svg{width:100%;height:100%}
/* The primary action, shown as a button only where there is no pointer to
   right-click with — see footHtml. Quieter than the danger pair beside it. */
.bs-inv .sel .bs-buy.ghost{background:rgba(255,255,255,.1);color:#eef2f8;
  border:1px solid rgba(255,255,255,.18);box-shadow:none}
.bs-inv .sel .bs-buy.ghost:hover{background:rgba(255,255,255,.18)}
.bs-inv .sel .bs-buy.danger{background:rgba(255,90,80,.12);color:#ff9d95;
  border:1px solid rgba(255,90,80,.34);box-shadow:none}
.bs-inv .sel .bs-buy.danger:hover{background:rgba(255,90,80,.24);color:#fff}

/* THE TOOLTIP. Positioned by transform against the VIEWPORT rather than by
   top/left inside the panel, because it has to be able to leave the panel: the
   dock is against the right edge, so a tooltip beside a slot is nearly always
   to the LEFT of it and over the world. See moveTip for the clamping. */
.bs-inv .tip{position:fixed;top:0;left:0;z-index:1;max-width:290px;
  padding:11px 13px 12px;border-radius:13px;pointer-events:none;
  background:linear-gradient(165deg,rgba(24,31,45,.97),rgba(12,16,25,.98));
  border:1px solid rgba(255,255,255,.16);
  box-shadow:0 18px 44px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.08);
  backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
  opacity:0;transition:opacity .12s ease}
.bs-inv .tip.on{opacity:1}
.bs-inv .tip h3{font-size:18px;font-weight:800;line-height:1.2;color:#fff}
.bs-inv .tip .rar{display:inline-block;margin-top:2px;font-size:16px;font-weight:800;
  letter-spacing:.05em;text-transform:uppercase;color:rgba(238,242,248,.55)}
.bs-inv .tip .rar.r-rare{color:#7fd8ff}
.bs-inv .tip .rar.r-legendary{color:#ffc44d;text-shadow:0 0 12px rgba(255,196,77,.5)}
.bs-inv .tip p{font-size:16px;line-height:1.4;color:rgba(238,242,248,.78);margin:7px 0 8px}
.bs-inv .tip .note{font-size:16px;color:rgba(238,242,248,.5);font-style:italic;margin:7px 0 0}
.bs-inv .tip .bs-chips{margin-bottom:0}
@media (prefers-reduced-motion:reduce){
  .bs-inv .bs-scrim,.bs-inv .pane,.bs-inv .slot,.bs-inv .tip{transition:none}
}
/* A SHORT WINDOW pays for the wall out of the stage rather than out of the type
   (issue #17's rule for this whole stylesheet). At 620px the stage still holds
   three whole figures; below 520 it goes entirely, because two rows of slots
   and a footer is what the panel is FOR and a 90px stage is a smear. */
@media (max-height:620px){
  .bs-inv .stage{height:150px}
  .bs-inv .gs-ic{width:36px;height:36px}
}
@media (max-height:520px){
  .bs-inv .stage{display:none}
}

/* ---- quest journal (J) --------------------------------------------------- */
/* src/ui/journal.ts. THE SAME DOCK THE INVENTORY IS, deliberately: these are the
   two panels a player opens with one key while standing in the world, and a
   journal that slid in from a different edge with a different corner would read
   as a different program. Same z-index 40, same --bs-vh measurement, same
   .bs-glass / .bs-scrim / .bs-shop-x / .bs-chip / .bs-buy borrowings.

   NARROWER THAN THE INVENTORY — 520px against 710 — because what sets that
   panel's width is a wall eleven slots across and what sets this one's is a line
   of prose. Past about 60 characters a measure gets harder to read rather than
   easier, so the extra 190px would be spent making the panel worse.

   FULL SCREEN BELOW 720px, which the inventory does not do. A dock is a dock
   because there is a world worth leaving visible beside it; on a phone there is
   not, and a 520px drawer on a 390px screen is a full-screen sheet already —
   this only stops it pretending otherwise with a corner radius and a scrim
   stripe nobody can tap. */
.bs-journal{position:fixed;inset:0;z-index:40;display:flex;justify-content:flex-end;
  pointer-events:auto;touch-action:manipulation;-webkit-tap-highlight-color:transparent;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  color:#eef2f8;user-select:none;-webkit-user-select:none}
.bs-journal .bs-scrim{opacity:0}
.bs-journal.open .bs-scrim{opacity:1}
.bs-journal .pane{position:relative;width:min(520px,100vw);height:var(--bs-vh,100dvh);
  display:flex;flex-direction:column;min-height:0;
  border-radius:0;border-right:none;
  opacity:0;transform:translateX(26px);
  transition:opacity .24s ease,transform .3s cubic-bezier(.22,1,.36,1);
  box-shadow:-24px 0 64px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.1)}
.bs-journal.open .pane{opacity:1;transform:translateX(0)}
.bs-journal .head{display:flex;align-items:center;gap:14px;padding:14px 18px 12px;
  border-bottom:1px solid rgba(255,255,255,.1)}
.bs-journal .head h2{font-size:22px;font-weight:900;letter-spacing:.04em;flex:1;
  text-shadow:0 1px 3px rgba(0,0,0,.5)}
.bs-journal .head .cap{display:flex;gap:5px;opacity:.62}
/* The shelves, each carrying its count — see tabsHtml. The <b> is the number and
   is deliberately not a badge: a pill on a pill is two borders saying one thing. */
.bs-journal .tabs{display:flex;gap:6px;flex-wrap:wrap;padding:11px 18px 0}
.bs-journal .chip{display:inline-flex;align-items:baseline;gap:6px;
  padding:5px 12px 6px;border-radius:999px;border:1px solid rgba(255,255,255,.14);
  background:rgba(255,255,255,.05);color:rgba(238,242,248,.72);font-family:inherit;
  font-size:16px;font-weight:700;cursor:pointer;transition:background .15s,color .15s,border-color .15s}
.bs-journal .chip:hover{background:rgba(255,255,255,.12);color:#fff}
.bs-journal .chip.on{background:rgba(105,217,255,.16);border-color:rgba(105,217,255,.5);color:#dff5ff}
.bs-journal .chip b{font-size:16px;font-weight:800;font-variant-numeric:tabular-nums;
  opacity:.7}
.bs-journal .chip:focus-visible{outline:2px solid #ffd23f;outline-offset:-2px}
/* THE COLUMN SCROLLS AND THE PANEL DOES NOT — the inventory's rule, and here it
   is what keeps the tabs on screen with a hundred completed quests behind them. */
.bs-journal .list{flex:1;min-height:0;overflow-y:auto;padding:12px 18px 18px;
  display:flex;flex-direction:column;gap:11px;
  scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.25) transparent}
.bs-journal .none{font-size:16px;line-height:1.5;color:rgba(238,242,248,.55);
  padding:26px 4px;text-align:center}
/* A CARD, with its category as a left EDGE rather than a fill: a main quest and
   a side quest have to read as the same kind of object, or a player learns to
   skip one of them. */
.bs-journal .q{position:relative;padding:12px 14px 13px 16px;border-radius:14px;
  border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05)}
.bs-journal .q::before{content:'';position:absolute;left:0;top:12px;bottom:12px;width:3px;
  border-radius:0 3px 3px 0;background:rgba(238,242,248,.28)}
.bs-journal .q.c-main::before{background:#ffc44d;box-shadow:0 0 12px rgba(255,196,77,.6)}
.bs-journal .q-h{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap}
.bs-journal .q-h h3{font-size:18px;font-weight:800;line-height:1.25;flex:1;min-width:0}
.bs-journal .badge{font-size:16px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;
  color:rgba(238,242,248,.5)}
.bs-journal .q.c-main .badge{color:#ffc44d}
/* Arc, giver and place, on one quiet line. Three separate labelled rows was the
   first shape and it made the metadata louder than the objectives. */
.bs-journal .q-m{margin-top:3px;font-size:16px;font-weight:600;color:rgba(238,242,248,.5)}
.bs-journal .q-d{margin-top:7px;font-size:16px;line-height:1.45;color:rgba(238,242,248,.8)}
.bs-journal .steps{list-style:none;margin-top:9px;display:flex;flex-direction:column;gap:5px}
.bs-journal .steps li{display:flex;align-items:flex-start;gap:8px;font-size:16px;line-height:1.4;
  color:rgba(238,242,248,.9)}
.bs-journal .steps li.ok{color:rgba(238,242,248,.5);text-decoration:line-through}
.bs-journal .steps li b{margin-left:auto;font-weight:800;font-variant-numeric:tabular-nums;
  color:rgba(238,242,248,.7)}
/* The tick box is drawn whether or not the step is done, so a list does not
   shift sideways one line at a time as the player works through it. */
.bs-journal .tk{flex:none;width:17px;height:17px;margin-top:2px;border-radius:5px;
  border:1px solid rgba(255,255,255,.22);color:#8fe06b}
.bs-journal .steps li.ok .tk{border-color:rgba(143,224,107,.55);background:rgba(143,224,107,.14)}
.bs-journal .tk svg{width:100%;height:100%}
.bs-journal .bs-chips{margin-top:10px;margin-bottom:0}
.bs-journal .q-f{margin-top:11px}
.bs-journal .q-f .bs-buy{display:inline-flex;align-items:center;gap:7px;padding:5px 12px 6px;
  font-size:16px;background:rgba(255,255,255,.1);color:rgba(238,242,248,.72);
  border:1px solid rgba(255,255,255,.18);box-shadow:none}
.bs-journal .q-f .bs-buy:hover{background:rgba(255,255,255,.18);color:#fff}
/* PRESSED, and it says so with a colour rather than only with its label: the
   button is a switch, and the state of a switch should survive being read at a
   glance in a language the player half knows. */
.bs-journal .q-f .bs-buy.on{background:rgba(105,217,255,.16);color:#dff5ff;
  border-color:rgba(105,217,255,.5)}
.bs-journal .q-f .bs-buy:focus-visible{outline:2px solid #ffd23f;outline-offset:2px}
@media (prefers-reduced-motion:reduce){
  .bs-journal .bs-scrim,.bs-journal .pane{transition:none}
}
@media (max-width:720px){
  .bs-journal .pane{width:100vw;border-radius:0;border-left:none}
}


/* ---- in-game menu (Escape / Start / the touch overlay's MENU) ------------ */
/* src/ui/pause.ts. It borrows the TITLE SCREEN's controls rather than the HUD's
   panels — .bs-menu-btn for the rows, .bs-opts for the column — because it does
   the title screen's job (settings, and ending the session) and a player
   arriving here should recognise where they are. What it borrows from the HUD is
   only .bs-scrim and .bs-glass, i.e. the way a modal sits over the world.

   z-index 40 is the load-bearing number: over the HUD (20) and the touch overlay
   (30), so nothing behind it can be tapped, and UNDER the title screen (50), so
   that Exit's new poster covers this one during the frame between them.

   The pane is WIDTH-CAPPED rather than sized to the viewport. A settings list is
   the same list on a phone and on a 32-inch monitor, and letting it stretch put
   an ON pill a third of a metre from the label it belongs to. */
.bs-pause{position:fixed;inset:0;z-index:40;display:grid;place-items:center;
  pointer-events:auto;touch-action:manipulation;-webkit-tap-highlight-color:transparent;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  color:#fff;user-select:none;-webkit-user-select:none}
.bs-pause .bs-scrim{position:absolute;inset:0;background:transparent;opacity:0;
  transition:opacity .22s ease}
.bs-pause.open .bs-scrim{opacity:1}
.bs-pause .pane{position:relative;width:min(420px,90vw);max-height:88vh;overflow-y:auto;
  padding:22px 20px;border-radius:0;
  /* Warm, so the wooden buttons sit on something related to them rather than on
     the HUD's blue-grey. Same construction as .bs-glass, a different tint. */
  background:linear-gradient(180deg,#261a0f,#140e08);
  border:1px solid rgba(255,214,140,.22);
  box-shadow:0 24px 64px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,226,170,.14);
  opacity:0;transform:translateY(14px) scale(.97);
  transition:opacity .24s ease,transform .28s cubic-bezier(.34,1.45,.64,1);
  scrollbar-width:thin;scrollbar-color:rgba(255,214,140,.3) transparent}
.bs-pause.open .pane{opacity:1;transform:translateY(0) scale(1)}
/* The disabled language row, and the note under it. Greyed as a whole rather
   than only its chips, so it reads as "this row is not available here" instead
   of as three broken buttons beside a live label. */
.bs-opts .row.lang.off{opacity:.45}
@media (prefers-reduced-motion:reduce){
  .bs-pause .bs-scrim,.bs-pause .pane{transition:none}
}

/* ---- fullscreen offer (touch devices only) ------------------------------- */
/* ---- start menu ---------------------------------------------------------- */
/* The title screen. Two images and CSS — see src/ui/menu.ts for what the layers
   are and why the art sits inside an explicitly sized plate.

   z-index 50 puts it over the HUD (20) and the touch overlay (30) but under the
   fullscreen pill's in-menu perch (60), which it raises itself. Unlike the rest
   of this sheet it OPTS IN to pointer events wholesale: while the title screen
   is up, nothing behind it should be clickable, and step one accepts a click
   anywhere on the poster. */
.bs-menu{position:fixed;inset:0;z-index:50;overflow:hidden;pointer-events:auto;
  touch-action:manipulation;-webkit-tap-highlight-color:transparent;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  color:#fff;user-select:none;-webkit-user-select:none;background:#0a0e14;
  opacity:0;transition:opacity .45s ease}
.bs-menu.show{opacity:1}
.bs-menu.leaving{opacity:0;transition:opacity .5s ease}
.bs-menu *{box-sizing:border-box;margin:0;padding:0}
/* photo=1&menu=1 — a staged capture of the title screen. Every animation on
   it stops, so two runs produce identical pixels; the same reason world/sway.ts
   freezes the wind clock. Also honoured for anyone who asked their OS for less
   motion, which wants exactly the same thing for a different reason. */
.bs-menu.photo *{animation-play-state:paused!important}
/* Reduced motion takes away MOVEMENT, not light.
   This used to pause every animation on the screen, which is the blunt reading
   and the wrong one: it left the fairies frozen mid-air, the lanterns stuck at
   62% and a title screen that looked broken rather than calm. What actually
   troubles someone who asks for less motion is travel — things flying across
   the frame, things sliding, things scaling. So the crossing and the bob stop
   and the logo's slide becomes a cut, while the two things that only change
   BRIGHTNESS keep going. Note the fairies hold the positions their negative
   delays put them in, so they stay scattered rather than stacking at one edge. */
@media (prefers-reduced-motion:reduce){
  .bs-menu .fly{animation-play-state:paused}
  .bs-menu .fly b{animation:bsFlyTwinkle calc(var(--bob) * .45) ease-in-out infinite alternate}
  .bs-menu .lamp{animation-name:bsLampGlow}
  /* The entrance below is deliberately NOT paused here. It is three fades, and a
     fade is light rather than travel — the same split the lanterns get. */
  .bs-menu .logo,.bs-menu .panel{transition:none}
}

/* ---- the entrance: logo, then painting, then "press start" --------------- */
/* Issue #49. The long note at INTRO in src/ui/menu.ts is the why; this is the
   whole of the WHEN. Three layers start at 0 and the sequence is three animation
   delays adding up — .55 logo, then .7 painting, then .45 for the words — so
   once menu.ts has added .intro nothing in JavaScript is involved again.

   THAT IS THE POINT OF DOING IT HERE. The boot runs behind this poster in long
   tasks, and a setTimeout(550) for the second beat was measured firing at
   4066 ms: the painting turned up four seconds after the wordmark. A compositor
   opacity animation goes on running through the same block.

   .lit is the same three layers with no sequence — the end state, the skip, and
   what photo=1 and Exit to title get instead of a run. It sits AFTER .intro so
   it wins on order at equal specificity, and it restates the press pulse because
   animation:none would otherwise take it away with the fades.

   Note what is NOT gated: .bs-menu itself still fades up on .show at the frame it
   always did, and the dark plate under all this is the element's own background.
   The poster is on screen exactly as early as it was; what these rules stage is
   what is PAINTED on it. */
.bs-menu .stage,.bs-menu .logo,.bs-menu .press{opacity:0}
.bs-menu.intro .logo{animation:bsIntroIn .55s ease both}
.bs-menu.intro .stage{animation:bsIntroIn .7s ease .55s both}
/* TWO animations on one property, which is how the words fade in and then keep
   breathing. The pulse's delay puts it past the fade with no fill of its own, so
   until 1.7 s only the first rule applies; after it, the later name in the list
   wins. Both start from full opacity, so the handover is invisible. */
.bs-menu.intro .press{animation:bsIntroIn .45s ease 1.25s both,
  bsPressPulse 1.9s ease-in-out 1.7s infinite}
.bs-menu.lit .stage,.bs-menu.lit .logo,.bs-menu.lit .press{opacity:1;animation:none}
.bs-menu.lit .press{animation:bsPressPulse 1.9s ease-in-out infinite}
@keyframes bsIntroIn{from{opacity:0}to{opacity:1}}

.bs-menu .stage{position:absolute;inset:0;overflow:hidden}
/* background-size:cover, written out, so the glows below can be positioned in
   PER CENT OF THE PICTURE and stay on their lanterns at every aspect ratio.
   1672/941 is the source art's own ratio; both axes are max()'d against the
   viewport so whichever dimension binds, the other overflows and is clipped. */
.bs-menu .plate{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
  width:max(100vw,calc(100dvh * 1672 / 941));height:max(100dvh,calc(100vw * 941 / 1672))}
.bs-menu .art{width:100%;height:100%;object-fit:fill;display:block}
/* One lantern. plus-lighter adds light rather than painting a pale disc over
   the glass — a normal-blended white circle reads as a smudge on the lens.
   The pulse is opacity AND scale together: a flame that brightens without
   growing reads as a UI fade, and one that grows without brightening reads as a
   zoom. Peak 1.0 is only ~18% above the trough, which is a lantern breathing
   rather than a light switch. */
.bs-menu .lamp{position:absolute;left:var(--x);top:var(--y);width:var(--r);aspect-ratio:1;
  transform:translate(-50%,-50%);border-radius:50%;pointer-events:none;
  mix-blend-mode:plus-lighter;
  background:radial-gradient(circle,
    rgba(255,236,170,.85) 0%,rgba(255,203,110,.45) 26%,
    rgba(255,168,66,.16) 52%,rgba(255,150,50,0) 74%);
  animation:bsLamp var(--p) ease-in-out infinite alternate}
@keyframes bsLamp{
  from{opacity:.62;transform:translate(-50%,-50%) scale(.9)}
  to{opacity:1;transform:translate(-50%,-50%) scale(1.06)}}
/* The same breath with the swell taken out, for prefers-reduced-motion. The
   flame still lives; it just stops growing. */
@keyframes bsLampGlow{from{opacity:.62}to{opacity:1}}

/* Fairies. Two nested elements so the crossing and the bobbing keep independent
   periods without any JS: the outer travels, the inner wobbles and twinkles.
   Sized off --sz with the glow scaled to match, so one number sets a sprite. */
.bs-menu .flies{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.bs-menu .fly{position:absolute;top:var(--top);left:0;width:var(--sz);height:var(--sz);
  will-change:transform;animation:bsFlyX var(--dur) linear var(--delay) infinite}
.bs-menu .fly.rev{animation-name:bsFlyXrev}
/* White CORE, coloured halo. A fairy that is amber all the way through washes
   out against a sunlit cloud; a white centre keeps a hard highlight the sky
   cannot match, and the halo does the colouring around it. */
.bs-menu .fly b{display:block;width:100%;height:100%;border-radius:50%;
  background:radial-gradient(circle,#fff 0%,#fff6d2 28%,rgba(255,214,120,.75) 52%,rgba(255,190,90,0) 76%);
  box-shadow:0 0 calc(var(--sz) * 2.6) calc(var(--sz) * .8) rgba(255,208,120,.65),
             0 0 calc(var(--sz) * .9) rgba(255,255,255,.9);
  /* The twinkle runs on its own clock at .45 of the bob — a prime-ish fraction,
     so a fairy's brightest moment lands somewhere different on every pass
     rather than always at the top of its arc. Down to 0.22 rather than the
     first pass's 0.45: at a 9px dot over a sunlit sky, halving the opacity was
     not a pulse anyone noticed, it was just a slightly dimmer dot. */
  animation:bsFlyY var(--bob) ease-in-out infinite alternate,
            bsFlyTwinkle calc(var(--bob) * .45) ease-in-out infinite alternate}
/* A minority are cool-toned, which is what stops seven identical amber dots
   reading as dust on the screen. Matches the blue beast in the artwork. */
.bs-menu .fly.cool b{
  background:radial-gradient(circle,#fff 0%,#e6fbff 28%,rgba(150,225,255,.75) 52%,rgba(110,205,255,0) 76%);
  box-shadow:0 0 calc(var(--sz) * 2.6) calc(var(--sz) * .8) rgba(150,222,255,.65),
             0 0 calc(var(--sz) * .9) rgba(255,255,255,.9)}
@keyframes bsFlyX{from{transform:translate3d(-6vw,0,0)}to{transform:translate3d(106vw,0,0)}}
@keyframes bsFlyXrev{from{transform:translate3d(106vw,0,0)}to{transform:translate3d(-6vw,0,0)}}
@keyframes bsFlyY{from{transform:translateY(calc(var(--bobY) * -1))}to{transform:translateY(var(--bobY))}}
/* Bright end FIRST, for the same reason the press pulse runs that way: paused at
   0% under photo=1, a dim-first keyframe froze all seven fairies at 35% opacity
   and the staged still came out with none of them visible. */
@keyframes bsFlyTwinkle{from{opacity:1}to{opacity:.22}}

/* The art is bright noon daylight and the type on top of it is white. This is
   what makes the words legible without dimming the painting into mud: darkened
   at top and bottom where the logo and the buttons live, untouched across the
   middle band where the castle and the characters are. */
.bs-menu .vign{position:absolute;inset:0;pointer-events:none;
  background:
    linear-gradient(180deg,rgba(6,10,18,.55) 0%,rgba(6,10,18,.12) 26%,
      rgba(6,10,18,0) 46%,rgba(6,10,18,.28) 72%,rgba(6,10,18,.72) 100%),
    radial-gradient(120% 90% at 50% 40%,rgba(6,10,18,0) 40%,rgba(6,10,18,.45) 100%)}

/* TWO ROWS MEETING AT A DIVIDER, which is what makes the gap a constant.

   The logo sits in the top row aligned to its BOTTOM, the panel in the bottom
   row aligned to its TOP, so the two edges that face each other both land on
   the line between the rows. The distance between them is then exactly --gap,
   at every window size, and they cannot overlap however tall the panel gets —
   the divider is between them.

   The previous arrangement had both boxes in ONE centred cell, each translated
   away by a percentage of viewport HEIGHT while the panel's own height was a
   fixed number of pixels. Those two do not scale together: values tuned to give
   a tight gap at 1080 put the New Game button through the middle of the logo at
   540. Shared --slide moves the pair without ever changing the distance between
   them, so the "logo slides up to make room" transition survives intact. */
/* FOUR ROWS: flexible, logo, panel, flexible. The two content rows size
   themselves and the two fr rows split whatever is left equally, so the pair is
   centred AS A GROUP and the divider between them is wherever the logo's own
   height puts it — the gap is still exactly --gap, and the panel can grow
   downward without the logo's row caring.

   It was 1fr 1fr, a divider pinned to the middle, which is right only while the
   list fits in half a screen. Adding a fourth settings row took the panel to
   397px and the Back button fell off the bottom at 720 and at 540. Sizing the
   second row minmax(auto,50%) did not fix it either — measured, the row took
   the 50% and let its content overflow, because a panel of wrappable rows has a
   min-content height well under its natural one. Rows that are simply auto
   cannot do that. */
.bs-menu .fore{position:absolute;inset:0;display:grid;
  grid-template-rows:1fr auto auto 1fr;justify-items:center;
  padding:max(16px,env(safe-area-inset-top)) 16px max(16px,env(safe-area-inset-bottom))}
/* Sized against BOTH dimensions, and the max-height is the load-bearing half.
   Width alone (min(560px,74vw)) gave a 960x540 window the same 560px logo a
   1920x1080 one gets while every offset around it halved.

   It does NOT change size between steps. An earlier pass shrank it to 72% once
   the options appeared, on the theory that it had to get out of their way; it
   does not, now that the gap is a constant, and the wordmark is the one thing
   on this screen that should never look like it is retreating. */
.bs-menu .logo{grid-row:2;align-self:end;margin-bottom:var(--gap,13vh);
  width:min(560px,74vw);height:auto;max-height:34vh;
  filter:drop-shadow(0 14px 34px rgba(0,0,0,.55));
  transform:translateY(var(--slide,7vh));
  transition:transform .55s cubic-bezier(.3,.9,.28,1),
             margin-bottom .55s cubic-bezier(.3,.9,.28,1)}
.bs-menu .panel{grid-row:3;align-self:start;position:relative;
  width:min(400px,86vw);
  transform:translateY(var(--slide,7vh));
  transition:transform .55s cubic-bezier(.3,.9,.28,1)}
/* Once there is a list to read, the pair rises to the middle and the gap closes
   to something you can take in as one group — 44px, not a slab of sky. */
.bs-menu[data-step="fullscreen"],
.bs-menu[data-step="options"],
.bs-menu[data-step="about"],
.bs-menu[data-step="settings"]{--slide:0vh;--gap:44px}
/* ABOUT is prose, and prose has a comfortable measure the option list does not.
   400px of column is about 45 characters at the 16px floor, which is a newspaper
   column and reads as one — the box is wider, and stops at 90vw so a phone held
   upright still has a margin. */
.bs-menu[data-step="about"] .panel{width:min(520px,90vw)}
/* A soft pool of shade under the list, and nothing more solid than that.
   Captured without it, the rows sat over a village, a red banner and the hero's
   arm, and every one of those read THROUGH the wood — the buttons looked
   translucent when they are not. A hard panel would have fixed it too and hidden
   the painting the screen exists to show; this darkens what is directly behind
   the type and fades out well before the frame edges. */
.bs-menu[data-step="options"] .panel::before,
.bs-menu[data-step="about"] .panel::before,
.bs-menu[data-step="settings"] .panel::before{content:"";position:absolute;
  inset:-30px -46px;border-radius:34px;pointer-events:none;
  background:radial-gradient(72% 66% at 50% 50%,
    rgba(6,10,18,.78) 0%,rgba(6,10,18,.58) 52%,rgba(6,10,18,0) 100%)}

/* "Press start..." — the one piece of type with no box around it, so it needs
   its own hard shadow to survive being over sky in one crop and over a tree in
   the next. */
/* Over the middle of the painting, which is the busiest part of it — a village,
   a path and two characters — so the type carries its own contrast rather than
   relying on the vignette, which is deliberately weakest exactly here. Four
   stacked shadows: a tight black core that separates the strokes from whatever
   is behind them, then a wide soft one, then the warm bloom that ties it to the
   lanterns.

   The pulse runs from FULL, not to it: paused at 0% under photo=1 a
   trough-first keyframe froze the words at 42% opacity and a still of the title
   screen came out looking like a bug.

   IT IS NOT DECLARED HERE. The animation lives in the entrance block above, on
   .bs-menu.lit-press .press, because these words are the last of the three
   beats — an animation on opacity beats the transition that fades them in, so
   a pulse declared on the bare element would put them on screen at full
   brightness before the painting behind them had arrived. */
.bs-menu .press{text-align:center;font-size:clamp(16px,2.4vw,23px);font-weight:900;
  letter-spacing:.16em;text-transform:uppercase;
  text-shadow:0 1px 2px rgba(0,0,0,.95),0 2px 12px rgba(0,0,0,.9),
    0 0 30px rgba(255,196,90,.5)}
@keyframes bsPressPulse{0%,100%{opacity:1}50%{opacity:.45}}

/* A COLUMN OF OPTIONS, and everything from here to the language chips is
   deliberately NOT scoped to .bs-menu. The settings list is one view shown from
   two places (ui/settings.ts) — the title screen and the in-game menu — and a
   selector naming one of its hosts is how a shared view stops being shared: the
   markup moves, the rules do not follow it, and the second host silently renders
   an unstyled list. .bs-opts is the contract instead, and both hosts emit it.
   (No backticks in this file, ever: the whole sheet is one template literal.)

   Positioned, so it paints ABOVE the title panel's absolutely-positioned shade —
   without this the ::before above would cover the buttons rather than sit
   behind them. Harmless anywhere with no such shade. */
.bs-opts{position:relative;z-index:1;--optgap:10px;
  display:flex;flex-direction:column;align-items:stretch;gap:var(--optgap)}
/* THE SETTINGS SECTIONS ARE STACKED, ONE PER GRID CELL, and that is what makes
   the panel's height CONSTANT: the cell is as tall as the tallest section, so
   swapping tabs cannot move the Back button under the player's cursor. Rendering
   only the section showing had it jumping between 111px and 327px.

   The alternative was a fixed pixel height per screen band, and it is the worse
   one for the reason this sheet keeps re-learning: a number written here has to
   be re-measured every time a row is added or a translation wraps, and nothing
   fails when it is not. This asks the browser instead.

   visibility:hidden rather than display:none — the point is that the hidden
   sections still take up space. It also means they cannot be clicked and the
   browser will not focus them; ui/settings.ts's FOCUSABLE is what keeps a pad
   cursor out of them.

   The gap is inherited through --optgap rather than restated, so the two height
   bands below go on compacting the list by changing ONE value. */
.bs-opts .rows{display:grid}
.bs-opts .sec{grid-area:1/1;display:flex;flex-direction:column;
  align-items:stretch;gap:var(--optgap)}
.bs-opts .sec.off{visibility:hidden}
.bs-opts h2{font-size:17px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;
  text-align:center;color:rgba(255,255,255,.72);text-shadow:0 2px 6px rgba(0,0,0,.8);
  margin-bottom:2px}
.bs-opts .note{font-size:16px;font-weight:600;line-height:1.35;text-align:center;
  color:rgba(255,255,255,.62);text-shadow:0 1px 4px rgba(0,0,0,.85);margin:-4px 0 2px}

/* NAMING A CHARACTER, and LOADING ONE — issue #171.

   The field is dressed as the buttons' inverse: they are lit wood, so it is the
   hole cut in it. That reads as somewhere to type without needing a caption to
   say so, and it is the same trick the settings pills use at the other end of
   the same column.

   18px matches .bs-menu-btn and is well clear of the 16px floor. It has to be
   stated: an <input> does NOT inherit the page font, so leaving it alone gets
   the browser's 13px default — which is the one control on this screen that
   would silently break the type rule in AGENTS.md. The font-family:inherit
   below is here for the same reason. */
.bs-name-input{width:100%;padding:13px 18px;border-radius:12px;
  font-family:inherit;font-size:18px;font-weight:700;letter-spacing:.04em;
  text-align:center;color:#f4e7cd;
  background:linear-gradient(180deg,#241708,#3a2712);
  border:1px solid rgba(255,214,140,.3);
  box-shadow:inset 0 2px 8px rgba(0,0,0,.55);outline:none}
.bs-name-input::placeholder{color:rgba(244,231,205,.38);font-weight:600}
.bs-name-input:focus-visible{
  box-shadow:inset 0 2px 8px rgba(0,0,0,.55),
    0 0 0 2px rgba(255,214,120,.95),0 0 22px rgba(255,196,90,.6)}

/* A character: the wide button that loads them, and the narrow one that does
   not. Delete is deliberately the smaller, quieter face of the pair — it sits
   beside the thing a player came here to press, and the two must not look
   equally inviting. */
.bs-save-row{display:flex;gap:8px;align-items:stretch}
.bs-save-row .save{flex:1;flex-direction:column;align-items:flex-start;gap:2px;
  padding:11px 16px;text-align:left}
.bs-save-row .save .nm{font-size:18px;font-weight:800;letter-spacing:.04em}
/* 16px exactly — the floor, and this is a player-facing line. */
.bs-save-row .save .meta{font-size:16px;font-weight:600;letter-spacing:.02em;
  color:rgba(244,231,205,.7)}
.bs-save-row .del{flex:none;width:auto;padding:11px 14px;font-size:16px;
  background:linear-gradient(180deg,#4a2a22,#2c1710)}
/* Armed: one press has been made and the next one deletes. Red enough that the
   change is the answer to "did that do anything", which is the question a first
   press on a delete button always raises. */
.bs-save-row .del.armed{color:#ffe0d2;border-color:rgba(255,140,110,.55);
  background:linear-gradient(180deg,#8e2f22,#5c1c12)}

/* ABOUT THE GAME — the one box on this screen that SCROLLS (ui/about.ts).
   Issue #65.

   It has to. The licence notices alone are longer than any window this will be
   read in, and the alternative to a scrollbar is type under the 16px floor
   (issue #17), which is the thing that floor exists to forbid. Everything here
   is 16 or 17: the body sits exactly on it and the headings are one step up,
   which is what the compressed scale in AGENTS.md asks for.

   MEASURED IN --bs-vh, not dvh. core/viewport.ts publishes what the player can
   actually see, and this box is the tallest element on the screen after the
   logo — sized in dvh it is the thing that would hang off the bottom of a phone
   in fullscreen, which is exactly issue #16. Half the visible height leaves the
   heading, the Back button and the logo their rows at every size the two blocks
   below do not already re-fit.

   LEFT-ALIGNED, alone among the panels here. Centred prose has a ragged left
   edge, and a ragged left edge is the one thing a reader scanning down a column
   cannot skim — every line starts somewhere new. The headings go with it.

   It is a real focus stop (tabindex=0 in the markup) so Tab reaches it and the
   browser's own PageUp/PageDown work; the arrow keys and the pad are handled by
   the host, because on this step there is no list for them to walk. See
   ABOUT_SCROLL in ui/menu.ts. */
.bs-opts .about{max-height:calc(var(--bs-vh, 100dvh) * .5);
  overflow-y:auto;overscroll-behavior:contain;
  padding:10px 14px 10px 16px;border-radius:12px;text-align:left;
  font-size:16px;font-weight:600;line-height:1.45;
  color:rgba(244,231,205,.86);text-shadow:0 1px 4px rgba(0,0,0,.9);
  /* Its own plate rather than the panel's soft pool of shade: this is a wall of
     small type over a painting, and the pool fades out well before the frame
     edges (see the ::before above) — which is fine behind five buttons and not
     behind forty lines. */
  background:rgba(6,10,18,.78);border:1px solid rgba(255,214,140,.16);
  scrollbar-width:thin;scrollbar-color:rgba(255,214,140,.42) transparent}
.bs-opts .about:focus-visible{outline:none;
  box-shadow:0 0 0 2px rgba(255,214,120,.95),0 0 22px rgba(255,196,90,.5)}
.bs-opts .about::-webkit-scrollbar{width:9px}
.bs-opts .about::-webkit-scrollbar-thumb{border-radius:999px;
  background:rgba(255,214,140,.42)}
.bs-opts .about p{margin:0 0 11px}
/* The one sentence that has to survive a player reading nothing else. */
.bs-opts .about .lead{font-size:17px;font-weight:700;color:#f4e7cd;margin-bottom:14px}
.bs-opts .about h3{font-size:17px;font-weight:800;letter-spacing:.1em;
  text-transform:uppercase;color:rgba(255,214,140,.9);margin:16px 0 7px}
.bs-opts .about h3:first-of-type{margin-top:6px}
.bs-opts .about h4{font-size:16px;font-weight:800;letter-spacing:.06em;
  color:rgba(255,214,140,.8);margin:14px 0 6px}
.bs-opts .about ul{margin:0 0 12px;padding-left:20px}
.bs-opts .about li{margin:0 0 7px}
/* A CREDIT IS A BLOCK, NOT A LINE. Package, licence, copyright, home — four
   facts that wrap independently, so they are four rows rather than one sentence
   a narrow window breaks in the middle of a URL. */
.bs-opts .about ul.credits{list-style:none;padding-left:0;margin:0 0 12px}
.bs-opts .about ul.credits li{margin:0 0 11px;padding-left:11px;
  border-left:2px solid rgba(255,214,140,.28)}
.bs-opts .about .nm{display:inline;font-weight:800;color:#f4e7cd}
.bs-opts .about .lic{display:inline-block;margin-left:8px;padding:1px 8px 2px;
  border-radius:999px;font-size:16px;font-weight:800;letter-spacing:.04em;
  color:rgba(244,231,205,.9);background:rgba(0,0,0,.42);
  border:1px solid rgba(255,214,140,.24)}
.bs-opts .about .cr,.bs-opts .about .url{display:block;
  color:rgba(255,255,255,.66);word-break:break-word}
/* THE LAST LIST HAS NO MARGIN UNDER IT. The credits used to be followed by a
   licence body, so their trailing 12px was a gap between two blocks; with the
   body gone it is a strip of empty plate at the bottom of the scroll, which
   reads as more content that failed to load. */
.bs-opts .about ul.credits:last-child{margin-bottom:0}
.bs-opts .about ul.credits:last-child li:last-child{margin-bottom:0}
/* Wood-and-gold, taken from the logo rather than from the HUD's cool glass:
   this screen belongs to the painting, not to the interface that comes after.

   THE RESTING SHADOW AND THE FOCUS RING ARE CUSTOM PROPERTIES, and exactly one
   rule below composes them into a box-shadow. That is not tidiness, it is the
   only arrangement in which a variant cannot delete the ring — and one did.
   .primary sat two lines under :focus-visible restating box-shadow, and
   .bs-menu-btn.primary and .bs-menu-btn:focus-visible are BOTH 0-2-0, so the
   later rule won: New Game, the button every player lands on first and the
   only cursor a pad has on this screen, was the one option that did not light
   up when focused (issue #19 — measured, its computed box-shadow was the
   primary's two shadows and no ring at all, while Settings beside it had the
   full four). A variant now declares --rest, never box-shadow, so it no longer
   takes part in the cascade it was winning. */
.bs-menu-btn{display:flex;align-items:center;justify-content:center;gap:10px;
  width:100%;padding:13px 18px;border-radius:12px;cursor:pointer;
  font-family:inherit;font-size:18px;font-weight:800;letter-spacing:.05em;
  color:#f4e7cd;text-shadow:0 1px 2px rgba(0,0,0,.6);
  /* OPAQUE. At 92% the red gate banner behind the settings list came through
     the wood as a pink rectangle inside the row — captured, and it read as a
     rendering fault rather than as translucency. The shade behind the panel is
     where the art is allowed to show; the buttons themselves are solid. */
  background:linear-gradient(180deg,#5b3d24,#33210f);
  border:1px solid rgba(255,214,140,.3);
  --rest:0 6px 18px rgba(0,0,0,.42),inset 0 1px 0 rgba(255,226,170,.22);
  /* The focus ring is the pad's cursor as much as the keyboard's, so it is loud
     on purpose — on a controller it is the ONLY thing saying where you are. */
  --ring:0 0 0 2px rgba(255,214,120,.95),0 0 22px rgba(255,196,90,.6);
  box-shadow:var(--rest);
  transition:transform .14s cubic-bezier(.34,1.5,.64,1),filter .14s ease,box-shadow .14s ease}
.bs-menu-btn:hover:not([disabled]){filter:brightness(1.16);transform:translateY(-1px)}
.bs-menu-btn:active:not([disabled]){transform:translateY(1px) scale(.985);filter:brightness(1.24)}
.bs-menu-btn:focus-visible{outline:none;box-shadow:var(--ring),var(--rest)}
.bs-menu-btn.primary{color:#3a2703;border-color:transparent;
  background:linear-gradient(180deg,#ffd94f,#f0a12a);
  --rest:0 6px 20px rgba(0,0,0,.42),inset 0 1px 0 rgba(255,255,255,.5)}
/* The two GOLD faces — New Game, and the language chip you are already on —
   need their own ring, because the shared one is the same gold they are. Put
   back on a wooden button it is a bright edge against dark; put on these it is
   gold touching gold, and the button reads as slightly larger rather than as
   selected. So a dark hairline goes down FIRST, against the face, and the
   bright ring sits outside that: the separation is what makes it a ring. */
.bs-menu-btn.primary,.bs-menu-btn.chip.on{
  --ring:0 0 0 2px rgba(58,39,3,.85),0 0 0 4px rgba(255,238,186,.95),
    0 0 24px rgba(255,206,104,.75)}
.bs-menu-btn[disabled]{cursor:default;opacity:.42;filter:grayscale(.5)}
/* A settings row: label left, state pill right. */
.bs-menu-btn.row{justify-content:space-between;font-size:17px;padding:12px 14px 12px 18px}
.bs-menu-btn.row .lbl{font-weight:700;letter-spacing:.02em}
.bs-menu-btn.row .pill{flex:none;min-width:56px;padding:4px 10px 5px;border-radius:999px;
  font-size:16px;font-weight:900;letter-spacing:.06em;
  background:rgba(0,0,0,.38);border:1px solid rgba(255,214,140,.24);
  color:rgba(244,231,205,.6)}
.bs-menu-btn.row[aria-pressed="true"] .pill{color:#3a2703;border-color:transparent;
  background:linear-gradient(180deg,#ffd94f,#f0a12a)}
/* THE SETTINGS TABS — Gameplay · Controls · Graphics · Sound (ui/settings.ts).
   Same chips as the language picker, because they are the same gesture and this
   screen should not grow a second vocabulary for it; the hairline under the
   strip is the only thing that says these choose a PAGE rather than a value.

   FOUR ACROSS OR TWO BY TWO, decided by the words rather than by a breakpoint.
   The column is min(400px,86vw), and four 16px labels (the floor — issue #17)
   with room to press come to about 370 of it in English: one row on a desktop
   and on a phone held sideways, two on a narrow portrait window or in a language
   with longer words. So they WRAP rather than shrink: flex 1 0 auto grows a
   short label into the spare space and never squeezes a long one, which is the
   half that matters — a shrinking strip clips whichever tab a translator gave
   the longest word to, and clipped is not a thing a player can widen. */
.bs-opts .tabs{display:flex;flex-wrap:wrap;gap:5px;
  padding-bottom:9px;margin-bottom:1px;border-bottom:1px solid rgba(255,214,140,.18)}
.bs-opts .tabs .bs-menu-btn.chip{flex:1 0 auto;justify-content:center;
  padding:8px 10px;letter-spacing:.02em;white-space:nowrap}
/* .strip carries no look of its own — it is the behavioural hook ui/settings.ts
   puts data-group on, and the ring stays on the chip because the chip IS the
   value: on a strip that is one control, the lit chip and the focused chip are
   the same element and one ring says both things. What needs a rule is the
   music row, whose two controls are the MUTE chip and the level strip beside it
   (see volumeRow), so the levels lay themselves out as a group and wrap as one
   rather than leaving OFF stranded on a line of its own. */
.bs-opts .vols .steps{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:5px}
.bs-opts .row.lang,.bs-opts .row.vol{
  display:flex;align-items:center;justify-content:space-between;gap:10px;
  padding:2px 4px 2px 18px;font-size:17px;font-weight:700;
  text-shadow:0 1px 3px rgba(0,0,0,.8)}
.bs-opts .langs{display:flex;gap:6px}
/* Six steps against two languages, so this strip is the one that can run out of
   room: the chips are narrower, the gap is tighter, and it WRAPS rather than
   pushing the label off the left edge of a phone held sideways. Wrapped lines
   stay flush RIGHT, under the strip they belong to, rather than drifting left
   into the gap under the label.

   THE CHIPS ARE NARROWER BY PADDING, NOT BY TYPE. They were 12px, which the
   16px floor (issue #17) rules out — and a volume step is a NUMBER a player
   reads to find the one they are on, so it is the last label in this panel that
   should be small. The padding comes down instead and the wrap above absorbs
   what is left: at 16px the six steps are one row on a desktop and two on a
   phone held sideways, which is exactly what this rule was written for. */
.bs-opts .vols{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:5px}
.bs-opts .vols .bs-menu-btn.chip{padding:6px 9px;font-size:16px;min-width:44px;
  justify-content:center}
.bs-menu-btn.chip{width:auto;padding:8px 13px;font-size:16px;letter-spacing:.04em;border-radius:999px}
.bs-menu-btn.chip.on{color:#3a2703;border-color:transparent;
  background:linear-gradient(180deg,#ffd94f,#f0a12a)}

/* The settings list is the tallest thing this screen ever shows, and the
   controller-vibration row is what pushed it past what half a window holds. The
   divider hands a panel the space BELOW it, so on a 1000x560 window the list
   measured 335px against 280px of room and about 25px of the Back button sat
   under the bottom edge. (Before the row: 273px, and it fitted at every height
   down to the block below.)

   So the band between that block and a full-size window gets a DENSER settings
   list — the same row padding and gap the short-screen block already uses — a
   tighter gap, and a first row that shrinks to the logo instead of holding half
   the frame. Measured after: 240px of list, clear at every height in the band.

   What it deliberately does NOT do is resize the logo or touch the press and
   option steps. The wordmark is the same size at every step by design (see the
   .bs-menu .logo rule above), and a two-button list was never the thing that
   did not fit — only the settings column is short of room, so only that is
   compacted.

   The band's top was 660px, then 760px, and is 880px. Each move is the same
   thing happening: the tallest the list can be went up, so the height at which
   it stops fitting went up with it. 760 was the 16px floor (issue #17) taking a
   row from 14px to 17px and the note under it from 11.5 to 16, about 55px of
   list. 880 is the four SECTIONS (ui/settings.ts) — GRAPHICS is the tallest of
   them. At five rows plus the tab strip, uncompacted it measured 486px of
   list against 468 of room at 1280x800, with 18px of the Back button under the
   bottom edge. Compacted it was 425 and clear; the sixth graphics row remains
   inside this same band, guarded across tabs by tools/test-pause.mjs.

   Note the tabs did not make the list taller overall — the flat list they
   replaced was 462px and it is 486 here — they moved the height that has to fit
   from "every setting there is" to "the worst single section", which is what
   stops the next row added to Controls or Sound from mattering at all. */
@media (min-height:521px) and (max-height:880px){
  .bs-menu[data-step="settings"] .fore{grid-template-rows:0 auto auto 1fr}
  .bs-menu[data-step="settings"]{--gap:20px}
  .bs-menu[data-step="settings"] .bs-opts{--optgap:7px}
  .bs-menu[data-step="settings"] .bs-menu-btn.row{padding:8px 12px 8px 16px}
}

/* Short screens — a phone held sideways, which is how this game is played on
   one. There is simply not enough height here for a 44px gap AND a logo sized
   for a desktop, so the logo gets narrower (a responsive size, the same at
   every step — it still never shrinks on pressing start) and the gap collapses
   to what is left. The divider keeps doing its job: whatever the panel grows
   to, it grows downward into its own row. */
@media (max-height:520px){
  /* The divider stops being the MIDDLE and becomes "just under the logo": row
     one is content-sized, row two takes everything left. Splitting 50/50 gave
     the settings list half of 390px to fit 217px of rows in, and captured at
     844x390 the Back button was cut off by the bottom of the screen. The logo
     does not need half a phone; the list does need all of the rest. */
  .bs-menu .fore{grid-template-rows:0 auto auto 1fr}
  .bs-menu .logo{width:min(210px,26vw);max-height:38vh}
  .bs-menu{--slide:3vh;--gap:7vh}
  .bs-menu[data-step="fullscreen"],
  .bs-menu[data-step="options"],
  .bs-menu[data-step="settings"]{--slide:0vh;--gap:14px}
  /* PADDING, not type: the 16px floor (issue #17) is a floor at every screen
     size, so a short window buys its room back from the box rather than from the
     words in it. Measured at 851x393 with the music-volume row present, the
     settings list wanted 401px of the 361 the padding leaves; the numbers below
     take 6px off every row, 2px off every gap, and — the largest single saving —
     stop the six volume chips WRAPPING to a second line, which alone was 40px.
     After: 340px, and the Back button sits 21px clear of the bottom. */
  .bs-menu-btn{padding:6px 14px;font-size:16px}
  .bs-menu-btn.row{padding:6px 12px 6px 16px;font-size:16px}
  .bs-menu .bs-opts{--optgap:5px}
  .bs-menu .bs-opts .note{margin:-2px 0 0}
  .bs-opts .vols{gap:4px}
  .bs-opts .vols .bs-menu-btn.chip{padding:5px 7px;min-width:42px}
  /* The tab strip is a fixed cost every section pays, so it is the first thing
     to give room back on a short screen — padding again, never the 16px type. */
  .bs-opts .tabs{gap:4px;padding-bottom:6px}
  .bs-opts .tabs .bs-menu-btn.chip{padding:5px 8px}
  /* AND THE SECTIONS SCROLL, on the one screen shape where the arithmetic runs
     out. This is the only band that gets it, and that is the trade rather than
     an oversight: a scroll container CLIPS the focus ring of the row at each end
     (it is a box-shadow outside the button's box), which is a real cost to pay
     on screens that do not need it. Measured at 851x393, the worst case in the
     matrix: the sections are 250px tall and there are 264 before the Back button
     leaves the screen, so the cap sits between — 257 today, which is 7px of
     slack and still 7px inside the edge. Grow a row or shrink the frame and the
     list scrolls instead of the way out falling off the bottom.

     --bs-vh, not 100dvh: on a phone in fullscreen those disagree by over a
     hundred pixels and the measured one is right. See core/viewport.ts. */
  .bs-opts .rows{overflow-y:auto;max-height:calc(var(--bs-vh, 100dvh) - 136px)}
  .bs-menu .press{font-size:16px}
}

/* Very short — a small phone in landscape, where the arithmetic simply does not
   close. Measured at 844x390: 16px of padding, a 136px logo, the gap and a
   232px settings list want 410 of the 390 there are, and the Back button fell
   off the bottom of the screen. Every way of squeezing that (a smaller logo, a
   denser list, a thinner gap) buys ten or twenty pixels and breaks again the
   day a sixth setting is added.

   So the logo stands down instead — on the OPTION steps only. It has already
   had the press screen to itself at full size, which is the moment it is doing
   its job; once a list is up, the list is what the player is here for. Row one
   collapses to nothing and the panel centres in the whole frame, which at 320px
   of height leaves it 44px of air top and bottom. */
@media (max-height:440px){
  .bs-menu[data-step="options"] .logo,
  .bs-menu[data-step="about"] .logo,
  .bs-menu[data-step="settings"] .logo{display:none}
  /* 1fr above AND below the panel, so with no logo it is centred rather than
     parked against the top with all the slack underneath it. */
  .bs-menu[data-step="options"] .fore,
  .bs-menu[data-step="about"] .fore,
  .bs-menu[data-step="settings"] .fore{grid-template-rows:0 1fr auto 1fr}
  /* The prose box gets less of a short screen than it does of a tall one: at
     390px of height half the frame is 195px, which is eleven lines with the
     heading and the Back button still on screen. Its own scrollbar absorbs the
     rest, which is what it is there for. */
  .bs-opts .about{max-height:calc(var(--bs-vh, 100dvh) * .58)}
  /* And the last twenty pixels, bought when the music row was added. Measured
     at 844x390 with the row in and this block as it was: the list came to
     376.5px and the Back button's bottom edge landed at 392.5 in a 390px frame
     — two and a half pixels off the screen, which is exactly the failure the
     block above was written for and exactly what "breaks again the day a sixth
     setting is added" predicted.

     The two CHIP STRIPS are what gives it back, because they are the only
     controls here with padding to spare: a chip is a word, not a row, and at
     this size the strips are what the list gained. 5px of gap and tighter chips
     put the Back button at 371, which is 19 clear. */
  .bs-menu[data-step="settings"] .bs-opts{--optgap:5px}
  .bs-menu[data-step="settings"] .vols .bs-menu-btn.chip{padding:5px 9px}
  .bs-menu[data-step="settings"] .langs .bs-menu-btn.chip{padding:6px 11px}
  /* AND THE LAST TEN, bought when the 16px floor (issue #17) went in on top of
     the music row: measured at 851x393 the Back button landed at 395 in a 393px
     frame. The list itself has nothing left to give that is not type, so this
     comes off the SCREEN MARGIN instead — the frame's own 16px inset, which is
     breathing room rather than layout, and the only thing here that costs
     nothing to lose. The safe-area insets still win where a device declares
     them, which is the case the 16 was there for. After: 379 of 385. */
  .bs-menu[data-step="settings"] .fore{
    padding:max(4px,env(safe-area-inset-top)) 16px max(4px,env(safe-area-inset-bottom))}
}

/* The SETTINGS step alone, on anything under 600px of height: the wordmark
   stands down and the list gets the screen.

   Settings is the tallest panel by a distance — four toggles, a note, the
   language row and Back come to 397px, where the options list is 200 — so it is
   the only step that runs out of room first, and it runs out well before a
   phone. Measured with the logo up: at 560 the Back button was 10px past the
   bottom edge and at 480 it was 20px past, on window sizes a desktop player
   really has. Compacting further would shrink type that is already at its
   floor; the wordmark has had the press screen and the options to itself, and
   once a player is reading a list of switches it is the thing that can go.
   Anything roomier keeps the logo on every step — captured at 640, where the
   panel ends 43px clear of the bottom.

   600px before the 16px floor, for the same reason the dense band above moved:
   the list is about 55px taller now, so it runs out of room 100px earlier. */
@media (max-height:700px){
  .bs-menu[data-step="settings"] .logo,
  .bs-menu[data-step="about"] .logo{display:none}
  .bs-menu[data-step="settings"] .fore,
  .bs-menu[data-step="about"] .fore{grid-template-rows:0 1fr auto 1fr}
}

/* ---- boot progress ------------------------------------------------------- */
/* One element wearing two hats — see src/ui/loading.ts for the sequence.

   The Z-INDEX INVERSION is the load-bearing part of this block. As a CHIP it
   sits at 55, over the poster (50), because it is reporting on work happening
   behind a picture that would otherwise hide it. As the COVER it drops to 45,
   UNDER the poster and over the touch overlay (30) and the HUD (20), because
   the menu's own half-second dissolve is then the transition INTO it: the
   player watches the title screen melt away and finds a loading screen, not a
   world in pieces. Nothing cross-fades and nothing is timed against anything;
   the two faces just stand on opposite sides of one element that was already
   fading. */
.bs-load{position:fixed;pointer-events:none;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  color:#eef2f8;user-select:none;-webkit-user-select:none;
  opacity:0;transition:opacity .4s ease}
.bs-load.show{opacity:1}
.bs-load.gone{opacity:0;transition:opacity .55s ease}

.bs-load.chip{right:max(16px,env(safe-area-inset-right));
  bottom:max(16px,env(safe-area-inset-bottom));z-index:55}
.bs-load.chip .box{width:min(320px,62vw);padding:9px 13px 11px;border-radius:12px;
  background:linear-gradient(165deg,rgba(30,38,54,.72),rgba(14,18,28,.84));
  border:1px solid rgba(255,255,255,.14);
  box-shadow:0 8px 24px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.08);
  backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}

/* Opaque, and the same near-black index.html paints the page with, so the seam
   between "menu gone" and "loading screen up" is invisible even if a frame is
   dropped between them. */
.bs-load.cover{inset:0;z-index:45;display:grid;place-items:center;
  background:radial-gradient(125% 95% at 50% 42%,#131c2b 0%,#0a0e14 72%)}
.bs-load.cover .box{width:min(430px,74vw)}

.bs-load .cap{display:flex;align-items:baseline;justify-content:space-between;gap:12px;
  font-size:16px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;
  color:rgba(238,242,248,.74);text-shadow:0 1px 2px rgba(0,0,0,.5)}
.bs-load.cover .cap{font-size:17px}
.bs-load .pct{font-variant-numeric:tabular-nums;font-weight:700;letter-spacing:.06em;
  color:rgba(238,242,248,.5)}
.bs-load .track{margin-top:8px;height:4px;border-radius:999px;overflow:hidden;
  background:rgba(255,255,255,.13)}
.bs-load.cover .track{height:5px;margin-top:12px}
/* The same amber the title chip and the shard prices already use, so the one
   thing on screen before the game starts is wearing the game's colour. */
.bs-load .fill{display:block;height:100%;width:0;border-radius:999px;
  background:linear-gradient(90deg,#ffd23f,#ff8b4a 62%,#ff6b35);
  box-shadow:0 0 10px rgba(255,150,70,.45);
  transition:width .18s linear}
@media (prefers-reduced-motion:reduce){
  .bs-load .fill{transition:none}
}

/* ---- responsive ---------------------------------------------------------- */
/* Respect notches/rounded corners on phones. */
.bs-left{left:max(16px,env(safe-area-inset-left))}
.bs-quests{right:max(16px,env(safe-area-inset-right))}
.bs-title{left:max(16px,env(safe-area-inset-left));top:max(14px,env(safe-area-inset-top))}
.bs-shards{right:max(16px,env(safe-area-inset-right));top:max(14px,env(safe-area-inset-top))}
.bs-compass{top:max(10px,env(safe-area-inset-top))}
.bs-bag{right:max(16px,env(safe-area-inset-right));top:calc(max(14px,env(safe-area-inset-top)) + 44px)}

/* Tablet / large phone: shrink the party panel and hotbar. */
/* Everything narrowed here is a BOX — panel width, badge, slot, padding. The
   type is not, because the 16px floor (issue #17) does not have a wide-screen
   clause: a small window is not a player sitting closer. */
@media (max-width: 900px){
  .bs-compass{width:min(420px,50vw)}
  .bs-left{width:290px;padding:6px}
  .bs-beast{padding:6px 8px}
  .bs-beast .badge{width:32px;height:32px}
  .bs-beast .badge svg{width:18px;height:18px}
  .bs-beast .badge .loco{width:15px;height:15px}
  .bs-beast .badge .loco svg{width:10px;height:10px}
  .bs-beast .nm{font-size:16px}
  .bs-hp .track{height:13px}
  .bs-slot{width:58px;height:58px;border-radius:13px}
  .bs-hotbar{gap:8px;bottom:30px}
  .bs-shop{width:min(94vw,760px)}
  /* One column of sections below 900px: two 440px columns plus the panel's own
     padding wants 960px of content box, which a 900px window no longer has. */
  .bs-keys{width:min(94vw,620px)}
  .bs-keys-body{grid-template-columns:1fr}
}

/* Phone: the touch overlay owns the bottom corners, so the HUD moves out of
   the way — party panel to the top-left under the title, keyboard hints and
   the desktop hotbar hidden (touch has its own skill buttons). */
/* PHONE, AND THE ONE PLACE THE 16px FLOOR COSTS SOMETHING (issue #17).
   Everywhere else the floor is bought with a slightly larger box. Here there is
   no slack: this block used to run the HUD down to 8.5–12.5px because at 393 CSS
   px the desktop sizes eat a third of the screen, and holding the floor means
   the boxes grow on the screen least able to give the room.

   So the rule for this block is CUT CONTENT, NOT TYPE. The type is the same 16px
   floor it is at every other width — a phone is not a player sitting closer —
   and what pays for it is everything that is not a word: badges, padding, bar
   heights, the title chip's tagline (hidden outright), and the party panel's own
   ellipsis doing more work. Two elements had to be re-fitted against each other
   rather than sized alone, because they share the top band and the type between
   them has to fit across it: the party panel top-left and the toast stack
   top-right were 160 + 200 of 393, and are 196 + 157 with a 12px lane between.
   Sized independently for the floor they came to 206 + 180, which is 393 exactly
   and printed the toast over the panel's right edge. */
@media (max-width: 620px), (max-height: 460px){
  /* No compass on a phone. The top band is the one strip of screen the touch
     layout leaves alone, but the party panel (top-left), shard pill and toast
     stack (top-right) already close in on it from both sides, and a 170px strip
     between them shows barely 50° — a heading readout you have to squint at is
     worse than none. With it gone the three elements below it go back to the
     positions they had before the compass existed. */
  .bs-compass{display:none}
  /* No HUD menu button on a phone either, and it is a duplicate rather than a
     casualty: the touch overlay draws its own MENU in this exact corner (see
     .bs-pausebtn in core/touch.ts), sized for a thumb and tapping the same
     virtual F10. Two buttons doing one job, one of them printing the name of a
     key the device does not have, is worse than one. */
  .bs-menubtn{display:none}
  /* The tracker keeps the right edge here too, and stays in the middle of it:
     the toast stack moves to the top right on a phone (see .bs-toasts below),
     which is the one thing that would have collided with a top-anchored one. */
  /* IT WRAPS HERE, and only here. The badge is one nowrap line on a desktop; at
     the 16px floor that line is 357px of a 393px phone, which reaches from the
     MENU button on one side to the toast column on the other. Capped and wrapped
     it is two short lines in the middle of the top band, and the toast stack
     below drops far enough to clear the second one. */
  .bs-riding{top:18px;font-size:16px;letter-spacing:.02em;padding:6px 13px;
    max-width:56vw;white-space:normal;text-align:center;line-height:1.25}
  .bs-banner{top:58px}
  .bs-left{width:min(50vw,196px);max-width:60vw;padding:5px;border-radius:13px;
    bottom:auto;top:calc(max(12px,env(safe-area-inset-top)) + 40px)}
  .bs-beasts{flex-direction:column;gap:1px}
  .bs-beast{padding:5px 7px;border-radius:9px}
  .bs-beast .bs-beast-in{gap:7px}
  .bs-beast .badge{width:26px;height:26px}
  .bs-beast .badge svg{width:15px;height:15px}
  .bs-beast .badge .loco{width:13px;height:13px;border-width:1.2px}
  .bs-beast .badge .loco svg{width:8px;height:8px}
  .bs-beast.support .badge{width:24px;height:24px}
  .bs-beast .nm,.bs-beast.support .nm{font-size:16px}
  .bs-beast .lv{font-size:16px;padding:0 6px}
  .bs-beast .row{margin-bottom:3px}
  .bs-micro{height:4px}
  .bs-hp{padding:6px 7px 2px;margin-top:4px}
  .bs-hp .lbl{letter-spacing:.06em;font-size:16px}
  .bs-hp .val{font-size:16px}
  .bs-hp .track{height:12px;border-radius:7px}
  .bs-title{padding:5px 10px 6px;border-radius:9px}
  .bs-title b{font-size:16px;letter-spacing:.1em}
  /* The tagline goes. It is the one purely decorative string in the HUD, and at
     393 CSS px the chip and the currency pill share the top band with nothing
     between them — so the choice is a legible title without a subtitle, or both
     at a size the issue rules out. */
  .bs-title span{display:none}
  .bs-shards{padding:5px 10px;gap:6px}
  .bs-shards .ic{width:16px;height:16px}
  .bs-shards .num{font-size:17px}
  /* Shrunk rather than hidden: a phone player needs to be able to name the
     money too, and the pill still fits inside the right safe-area inset. */
  .bs-shards .lbl{font-size:16px;letter-spacing:0}
  .bs-bag{top:calc(max(14px,env(safe-area-inset-top)) + 36px);gap:4px}
  .bs-bag .chip{padding:3px 9px;gap:6px}
  .bs-bag .nm,.bs-bag .n{font-size:16px}
  /* touch has its own skill buttons; the desktop hotbar and key hints go away */
  .bs-hotbar{display:none}
  .bs-shop-foot{display:none}
  .bs-shop{width:96vw;max-height:82vh}
  /* The sheet is REACHABLE on a phone but not reachable FROM one: there is no
     F1 on a touchscreen, so this is what a player sees when a keyboard is
     attached to a small window. Tightened rather than hidden — the notes are
     what go, since a 96vw row cannot hold a caption and a key column. */
  .bs-keys{width:96vw;max-height:86vh}
  /* 78/74/46 at 11.5px before the floor. The caps inside these cells are
     <kbd>, which now bottoms out at 16px (see .bs-root kbd), so the columns are
     re-measured against the same widest cells the desktop rule names. */
  .bs-keyrow{grid-template-columns:minmax(0,1fr) 98px 90px 62px;font-size:16px;padding:4px 6px}
  .bs-keyrow.head .nm{font-size:16px}
  .bs-keyrow .nm em{display:none}
  /* INVENTORY ON A PHONE. The dock becomes the WHOLE screen — at 393 CSS px a
     430px drawer with the world showing beside it is neither, and there is no
     world left to look at anyway. Same five columns and the same 16px type;
     what is cut is everything that is not a word, which is this block's rule.
     The tooltip is left in the stylesheet but never opens: a finger has no
     hover, and tapping a slot is what the footer strip answers. */
  .bs-inv .pane{width:100vw;border-radius:0}
  /* EVERY "bound to this control" glyph goes. There is no keyboard to press Esc
     on and no right button to click, so the icons would be instructions for
     hardware that is not there — which is worse than no instructions. The
     buttons themselves stay; see footHtml. */
  .bs-inv .cap{display:none}
  .bs-inv .head{padding:12px 14px 10px}
  .bs-inv .gear{padding:0 14px 10px;gap:7px}
  .bs-inv .gs{padding:6px 5px 5px}
  .bs-inv .gs-ic{width:38px;height:38px}
  .bs-inv .tabs{padding:9px 14px 0;gap:5px}
  .bs-inv .chip{padding:4px 10px 5px}
  /* Eleven columns at 393 CSS px is a 30px slot, which is small but is still
     the SAME grid — a phone that reflowed to five columns would have the
     keyboard's row step wrong (INV_COLS) and, worse, would move everything the
     player had learned the position of. The gap and the padding pay for it. */
  .bs-inv .grid{gap:4px;padding:9px 10px}
  .bs-inv .slot{border-radius:7px;padding:2px}
  .bs-inv .slot .n{top:1px;left:3px}
  .bs-inv .sel{padding:9px 14px}
  /* Toasts: one at a time (see HUD.addToast), clear of the control clusters,
     and clamped to two short lines so a long instruction string can never grow
     into a screen-eating panel. */
  /* +66 rather than +38: the riding badge above is two lines here (see
     .bs-riding) and the stack has to start below the second one. */
  .bs-toasts{top:calc(max(12px,env(safe-area-inset-top)) + 66px);bottom:auto;
    left:auto;right:max(12px,env(safe-area-inset-right));transform:none;align-items:flex-end}
  /* Three lines rather than two, and narrower: at 16px a two-line clamp cut
     every instruction toast mid-sentence. The width is what the party panel
     opposite it left over — see the note at the top of this block. */
  .bs-toast{font-size:16px;line-height:1.35;padding:6px 9px;max-width:min(40vw,157px);
    border-radius:10px;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;
    line-clamp:3;overflow:hidden}
  .bs-banner{padding:8px 12px;max-width:82vw}
  .bs-banner .eyebrow{letter-spacing:.16em}
  .bs-banner .txt{font-size:18px}
  /* The interaction prompt has to clear the touch fans. Their topmost buttons
     (skill 1 on the right, SWAP on the left) reach 217px up from the bottom
     edge in BOTH orientations — the fan is sized in vmin, so it is the same
     cluster turned 90° — hence 232px here rather than the desktop 118px.
     Measured on a Pixel 5: portrait the pill lands at y 587-619, under the hero
     and above the arc; landscape at y 131-161, above the reticle and clear of
     the toast stack in the top-right. */
  .bs-hint{font-size:16px;padding:7px 13px;bottom:232px;
    max-width:88vw;white-space:normal;text-align:center}
  /* Same argument as the pill, one panel higher: the fans reach 217px up, the
     pill takes the band at 232, and the dialogue sits above both. */
  /* 330, where the desktop pill it sits above needs only 174. The interact
     prompt WRAPS at this width — "Press E — Talk to Deckard Gains Armstrong" is
     three lines of 16px in a 393px frame, 85px tall against the desktop's 47 —
     and the dialogue has to clear whatever it grows to, not the one-line height
     it used to have. Measured, at 280 the panel's bottom edge was 29px inside
     the pill. */
  .bs-dialogue{bottom:330px;padding:9px 12px 10px;width:min(92vw,440px)}
  .bs-dialogue .line{font-size:17px}
  .bs-dialogue .who{font-size:16px;letter-spacing:.1em}
  .bs-dialogue .foot{margin-top:5px;font-size:16px}
}

/* A PHONE HELD UPRIGHT, and the one rule that is about WIDTH rather than about
   being a phone — so it is its own block rather than a line in the one above,
   which landscape also matches. The level-up banner is centred and the party
   panel is top-left, and at 393 CSS px there is not room for both on one band:
   with the panel 160px wide and the banner 306 they already overlapped by 117,
   and the 16px floor (issue #17) took the panel to 206. Captured, a level-up
   printed straight across both beast rows. 200 clears the panel (which ends
   about 190) and the toast column beside it, and is still well above the
   reticle. In LANDSCAPE the same two sit side by side with room to spare and the
   banner stays at 58 — pushing it to 200 there would park it on the hero. */
@media (max-width: 620px){
  .bs-banner{top:200px}
}

/* --- developer console (§) ------------------------------------------------
   Deliberately plain and monospaced: it is an instrument, not part of the
   game's look, and it must stay readable over any world behind it.

   IT IS THE TOPMOST THING IN THE PAGE, above the F2 overlay (9999) and the F3
   panel (9998), and that is the one number here that is not cosmetic. All three
   developer instruments claim the SAME BAND — the console is a full-width sheet
   down the top 42vh, F2 is pinned top-centre, F3 top-left — so at its old 9000
   the two panels were painted straight through it: two monospace readouts
   overlapping the log, and the prompt you were typing into sitting behind the
   performance rows (issue #41). It wins because it is the only one of the three
   you type INTO, and it is the only one that is transient — § puts F2 and F3
   back, and F3 can be dragged out from under it besides. */
.bs-console {
  position: fixed; left: 0; right: 0; top: 0;
  height: 42vh; min-height: 180px;
  display: flex; flex-direction: column;
  background: rgba(8, 12, 18, .92);
  border-bottom: 1px solid rgba(140, 200, 255, .28);
  box-shadow: 0 8px 32px rgba(0, 0, 0, .5);
  z-index: 10000;
  font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: #d8f0ff;
}
.bs-console-log {
  flex: 1; overflow-y: auto; padding: 10px 14px;
  white-space: pre-wrap; word-break: break-word;
}
.bs-console-line { opacity: .92; }
.bs-console-input {
  border: 0; border-top: 1px solid rgba(140, 200, 255, .18);
  background: rgba(0, 0, 0, .35);
  color: #eaf6ff; font: inherit; padding: 9px 14px; outline: none;
}
.bs-console-input::placeholder { color: rgba(216, 240, 255, .38); }

/* ---- F3 performance panel ---------------------------------------------- */
/* TOP LEFT, deliberately, and the one place in this HUD with nothing in it.
   F2's readout is pinned top-centre and this is meant to be read BESIDE it —
   flip a row here, watch the number move there — so it cannot take the middle
   and it cannot take the bottom, where the hotbar and the touch sticks live.
   Monospace and the same slate as the F2 panel because they are one tool.
   pointer-events stay ON, unlike F2: the rows are clickable. */
.bs-perf{position:fixed;top:10px;left:10px;z-index:9998;
  font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color:#d8f0ff;background:rgba(8,14,22,.86);border:1px solid rgba(140,200,255,.22);
  border-radius:8px;padding:8px 10px;min-width:330px;
  box-shadow:0 6px 24px rgba(0,0,0,.45);letter-spacing:.02em}
.bs-perf-title{font-weight:700;letter-spacing:.06em;text-transform:uppercase;
  font-size:11px;color:#8fd0ff;padding:0 4px 6px}
.bs-perf-row{display:grid;grid-template-columns:1fr auto;gap:0 10px;
  padding:3px 4px;border-radius:5px;cursor:pointer}
.bs-perf-row:hover{background:rgba(140,200,255,.10)}
/* The cursor is a background rather than an outline so it cannot shift the
   layout as it moves — a list that jiggles under the selection is unreadable. */
.bs-perf-row.sel{background:rgba(140,200,255,.20)}
.bs-perf-val{font-weight:700;color:#9ef5c0;justify-self:end}
/* An OFF row keeps its label at full strength and greys the value: the player
   is scanning for what they have already turned off, not for what exists. */
.bs-perf-row.off .bs-perf-val{color:#ff9c8f}
.bs-perf-cost{grid-column:1 / -1;font-size:10.5px;color:rgba(216,240,255,.45);
  padding-bottom:1px}
.bs-perf-hint{font-size:10.5px;color:rgba(216,240,255,.42);padding:6px 4px 0;
  border-top:1px solid rgba(140,200,255,.14);margin-top:4px}
/* Section headings. The panel now holds two unrelated tools — the renderer
   switches and the spawner — and without a rule between them the tree reads as
   more graphics settings. Same colour as the title bar, half its weight. */
.bs-perf-head{font-size:10px;letter-spacing:.08em;text-transform:uppercase;
  color:rgba(143,208,255,.72);padding:8px 4px 3px;margin-top:4px;
  border-top:1px solid rgba(140,200,255,.14);user-select:none}
.bs-perf-body > .bs-perf-head:first-child{margin-top:0;border-top:0;padding-top:0}
/* The hair colour well. A native <input type="color"> with its chrome stripped
   back to the swatch itself, so it reads as the value of its row exactly like
   the green text on every other one — same size, same place, and the colour it
   is showing IS the answer. The vendor swatch-wrapper rules below are what
   carry the browser's own padding; without them it sits in a grey frame. */
.bs-hair-well{width:42px;height:15px;padding:0;border:1px solid rgba(140,200,255,.45);
  border-radius:3px;background:none;cursor:pointer;vertical-align:middle;display:block}
.bs-hair-well::-webkit-color-swatch-wrapper{padding:0}
.bs-hair-well::-webkit-color-swatch{border:0;border-radius:2px}
.bs-hair-well::-moz-color-swatch{border:0;border-radius:2px}

/* ---- F3 spawner tree ---------------------------------------------------- */
/* THE ONE TEXT FIELD IN THE HUD, and it is a developer instrument — the 16px
   floor in AGENTS.md is for player-facing text and this is not that. 12px keeps
   it on the same grid as the rows above it. */
.bs-spawn-search{width:100%;box-sizing:border-box;margin:2px 0 5px;
  background:rgba(0,0,0,.45);border:1px solid rgba(140,200,255,.24);
  border-radius:5px;color:#eaf6ff;font:inherit;padding:4px 7px;outline:none}
.bs-spawn-search:focus{border-color:rgba(140,200,255,.55);
  background:rgba(0,0,0,.62)}
.bs-spawn-search::placeholder{color:rgba(216,240,255,.35)}
.bs-spawn-branch{display:grid;grid-template-columns:12px 1fr auto;gap:0 8px;
  padding:3px 4px;border-radius:5px;cursor:pointer;align-items:baseline}
.bs-spawn-branch:hover{background:rgba(140,200,255,.10)}
.bs-spawn-caret{color:rgba(143,208,255,.8)}
.bs-spawn-count{color:rgba(216,240,255,.45);justify-self:end}
.bs-spawn-note{grid-column:2 / -1;font-size:10.5px;color:rgba(216,240,255,.42)}
/* Indented under its heading, and the rule is the indent — a tree two levels
   deep does not need a guide line as well as an offset, but with sixty rows
   under one branch the eye needs SOMETHING vertical to run down. */
.bs-spawn-rows{margin:1px 0 3px 12px;padding-left:8px;
  border-left:1px solid rgba(140,200,255,.16)}
.bs-spawn-row{display:grid;grid-template-columns:1fr auto;gap:0 10px;
  padding:2px 4px;border-radius:4px;cursor:pointer}
.bs-spawn-row:hover{background:rgba(140,200,255,.14)}
/* The raw id beside the name: it is what /give and /grant want, so browsing
   here is also how you learn the string to type there. */
.bs-spawn-id{color:rgba(216,240,255,.38);justify-self:end;font-size:10.5px}
/* Already bonded, already standing — the row still works, it just says the
   effect has happened. Greyed rather than removed: a list that hid what you
   own would change length under you as you used it. */
.bs-spawn-row.had .bs-spawn-label{color:rgba(216,240,255,.45)}
.bs-spawn-empty{color:rgba(216,240,255,.42);padding:3px 4px}
/* What the last click did. One line, and it holds the previous answer until
   the next click replaces it — a status that cleared itself would be gone
   before you looked away from the world and back at the panel. */
.bs-spawn-status{color:#9ef5c0;padding:0 4px 4px;min-height:1.4em;
  white-space:pre-wrap}
/* Draggable and resizable — see beginDrag in ui/perf-panel.ts for why a debug
   panel that cannot be moved is a debug panel covering the thing you are
   debugging. overflow:auto so a panel resized smaller than its rows scrolls
   rather than clipping them away with no way back. */
/* THE CUSTOM CURSOR'S OVERRIDE. The cursor property inherits, so ui/cursor.ts
   setting it on body reaches the whole page — except that this stylesheet declares
   cursor:pointer on every button, menu row and buy button, and an explicit
   declaration on an element beats an inherited value. The result was the custom
   cursor working everywhere except the things a player actually points at.
   Scoped to the class so ordinary hover behaviour is untouched whenever the
   custom cursor is not up. See Cursors.enable. */
body.bs-cursor * { cursor: inherit !important; }

.bs-perf{overflow:visible;display:flex;flex-direction:column;
  /* CAPPED, because the panel grew a spawner. Eleven renderer rows with their
     cost lines already fill about half a 900px window, and the tree under them
     runs to ninety rows across four branches — uncapped, the hint line and the
     south resize handles end up below the bottom of the screen with no way to
     reach them. The body scrolls instead. --bs-vh rather than 100vh: on a
     phone the two differ by the browser chrome, and core/viewport.ts is what
     already measures that for every other layer. */
  /* BORDER-BOX, and the 26px is measured rather than chosen: the panel sits at
     top:10px, its own padding and border add 18, and the south-east resize
     handle hangs 6px BELOW its bottom edge. At content-box and -20px the whole
     lot came to 808 in an 800px window and that corner could not be grabbed —
     tools/test-cursor.mjs is what says so. */
  box-sizing:border-box;max-height:calc(var(--bs-vh, 100dvh) - 26px)}
.bs-perf-body{overflow:auto;flex:1 1 auto;min-height:0}
.bs-perf-title{user-select:none;flex:0 0 auto}
.bs-perf-hint{flex:0 0 auto}
/* 6px of grab area, half of it outside the border so the edge is reachable
   without the pointer having to be exactly on the 1px line. Absolutely
   positioned against the panel, which is fixed-position above. */
.bs-perf-h{position:absolute;z-index:1}
.bs-perf-h.n{left:6px;right:6px;top:-3px;height:6px}
.bs-perf-h.s{left:6px;right:6px;bottom:-3px;height:6px}
.bs-perf-h.w{top:6px;bottom:6px;left:-3px;width:6px}
.bs-perf-h.e{top:6px;bottom:6px;right:-3px;width:6px}
.bs-perf-h.nw{left:-3px;top:-3px;width:9px;height:9px}
.bs-perf-h.ne{right:-3px;top:-3px;width:9px;height:9px}
.bs-perf-h.sw{left:-3px;bottom:-3px;width:9px;height:9px}
.bs-perf-h.se{right:-3px;bottom:-3px;width:9px;height:9px}
`;

/** Inject the HUD stylesheet once. Safe to call repeatedly. */
export function injectStyles(): void {
  if (document.getElementById('bs-hud-styles')) return;
  const style = document.createElement('style');
  style.id = 'bs-hud-styles';
  style.textContent = CSS;
  document.head.appendChild(style);
}
