/**
 * All HUD / shop CSS, injected once as a <style> tag.
 * Glassy panels, element-tinted accents, springy transitions.
 */

const CSS = `
.bs-root{position:fixed;inset:0;pointer-events:none;z-index:20;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  color:#eef2f8;user-select:none;-webkit-user-select:none;
  --glass:linear-gradient(165deg,rgba(30,38,54,.72),rgba(14,18,28,.82));
  --stroke:rgba(255,255,255,.14);
}
.bs-root *{box-sizing:border-box;margin:0;padding:0}
.bs-root svg{display:block}
.bs-root kbd{display:inline-block;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.28);
  border-bottom-width:2px;border-radius:5px;padding:0 6px;font:inherit;font-size:.86em;font-weight:700;
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

/* ---- title chip -------------------------------------------------------- */
.bs-title{position:absolute;top:14px;left:16px;display:flex;align-items:baseline;gap:8px;
  padding:8px 14px 9px;border-radius:12px}
.bs-title b{font-weight:900;font-size:13px;letter-spacing:.18em;
  background:linear-gradient(92deg,#ffd23f 10%,#ff8b4a 55%,#ff6b35 90%);
  -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent}
.bs-title span{font-size:10px;font-weight:600;color:rgba(238,242,248,.5);letter-spacing:.05em}

/* ---- currency counter --------------------------------------------------- */
/* The pill names the money as well as counting it (see src/i18n): the number is
   the loud part, the name a quieter chip-sized label beside it — same weight
   relationship the bag chips below already use for name vs count. */
.bs-shards{position:absolute;top:14px;right:16px;display:flex;align-items:center;gap:8px;
  padding:8px 14px;border-radius:999px}
.bs-shards .ic{width:18px;height:18px;color:#69d9ff;filter:drop-shadow(0 0 5px rgba(105,217,255,.55))}
.bs-shards .ic svg{width:100%;height:100%}
.bs-shards .num{font-variant-numeric:tabular-nums;font-weight:800;font-size:16px;letter-spacing:.02em;
  color:#dff5ff;text-shadow:0 1px 2px rgba(0,0,0,.5)}
.bs-shards .lbl{margin-left:-2px;font-size:11.5px;font-weight:700;letter-spacing:.04em;
  color:rgba(223,245,255,.72);text-shadow:0 1px 2px rgba(0,0,0,.5)}
/* ---- bag (stackable items) --------------------------------------------- */
/* Sits directly under the shard pill: money on top, stuff below it, both in
   the same corner. Empty until the first pickup, so a fresh save shows nothing. */
.bs-bag{position:absolute;top:58px;right:16px;display:flex;flex-direction:column;
  align-items:flex-end;gap:6px;transform-origin:100% 0}
.bs-bag .chip{display:flex;align-items:center;gap:8px;padding:5px 12px;border-radius:999px}
.bs-bag .sw{width:11px;height:11px;border-radius:3px;box-shadow:0 0 9px currentColor}
.bs-bag .nm{font-size:11.5px;font-weight:700;color:rgba(238,242,248,.82)}
.bs-bag .n{font-variant-numeric:tabular-nums;font-weight:800;font-size:13.5px;color:#fff;
  text-shadow:0 1px 2px rgba(0,0,0,.5)}
.bs-pop{animation:bsPop .38s cubic-bezier(.34,1.8,.64,1)}
@keyframes bsPop{0%{transform:scale(1)}45%{transform:scale(1.28)}100%{transform:scale(1)}}

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

   Geometry, top down: pointer 0..9, band 9..35. The riding badge, level-up
   banner and toast stack below it were each pushed down by 34px to make room
   (they used to start at 18/58/96). */
.bs-compass{position:absolute;left:50%;top:10px;transform:translateX(-50%);
  width:min(420px,44vw);height:35px;transition:opacity .2s ease}
.bs-root.shop-open .bs-compass,.bs-root.keys-open .bs-compass{opacity:0}
/* The window clips the tape. The 16px mask fade at each end is the one soft
   edge in the widget and it earns its place: without it letters pop in and out
   at full opacity mid-glyph, which reads as a rendering fault.
   Fill alpha .6, up from a first pass at .52: captured facing south over open
   water the band read fine, but facing north into the canopy it disappeared
   into the dark green and only the two white rules were left holding the shape.
   Much past .6 and it starts to read as an opaque letterbox bar. */
.bs-compass .win{position:absolute;left:0;right:0;top:9px;height:26px;overflow:hidden;
  background:rgba(6,10,17,.6);
  border-top:2px solid rgba(238,242,248,.9);border-bottom:2px solid rgba(238,242,248,.9);
  -webkit-mask:linear-gradient(90deg,transparent 0,#000 16px,#000 calc(100% - 16px),transparent 100%);
  mask:linear-gradient(90deg,transparent 0,#000 16px,#000 calc(100% - 16px),transparent 100%)}
/* Centre rule, drawn last so it sits over tape AND markers: the pointer has to
   be unambiguous about which pixel column it is reading. */
.bs-compass .win::after{content:"";position:absolute;left:50%;top:0;bottom:0;width:2px;
  margin-left:-1px;background:rgba(255,210,63,.5)}
.bs-compass .tape{position:absolute;left:0;top:0;height:100%;will-change:transform}
.bs-compass .t{position:absolute;bottom:2px;width:2px;height:5px;margin-left:-1px;
  background:rgba(238,242,248,.62)}
.bs-compass .t.maj{height:8px;background:#eef2f8}
.bs-compass .lb{position:absolute;top:0;transform:translateX(-50%);font-weight:900;line-height:1;
  color:#fff;white-space:nowrap;
  text-shadow:1px 1px 0 #05070c,-1px 1px 0 #05070c,1px -1px 0 #05070c,-1px -1px 0 #05070c}
.bs-compass .lb.card{font-size:12px;letter-spacing:.06em}
.bs-compass .lb.ord{font-size:8.5px;top:2px;letter-spacing:.08em;color:rgba(238,242,248,.7)}
/* Markers ride OVER the tape — a marker occluding the letter behind it is the
   correct priority, and it is what keeps the widget one band tall. */
.bs-compass .marks{position:absolute;inset:0}
.bs-compass .mk{position:absolute;left:50%;top:0;height:13px;min-width:11px;
  display:flex;align-items:center;justify-content:center;padding:0 3px;
  background:var(--mc);border:2px solid #05070c;
  font-size:8.5px;font-weight:900;letter-spacing:.08em;color:#05070c;
  will-change:transform}
/* Behind you: the chip parks at the end of the strip and turns into an arrow
   pointing the short way round to it. */
.bs-compass .mk.edge{padding:0;min-width:0;width:0;height:0;border:0;
  border-top:6px solid transparent;border-bottom:6px solid transparent;
  background:transparent;overflow:hidden;color:transparent;
  filter:drop-shadow(0 0 1px #05070c)}
.bs-compass .mk.edge.l{border-right:9px solid var(--mc)}
.bs-compass .mk.edge.r{border-left:9px solid var(--mc)}
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
.bs-mounthold .lbl{position:absolute;top:38px;left:50%;transform:translateX(-50%);
  font-size:10.5px;font-weight:900;letter-spacing:.22em;white-space:nowrap;
  color:rgba(238,242,248,.85);text-shadow:0 1px 3px rgba(0,0,0,.75)}

/* ---- riding badge ------------------------------------------------------ */
/* Top centre, NOT bottom centre. While the fill ring is a thing you are DOING
   at the reticle, this is a state you are in — and the bottom middle of the
   frame is exactly where the mount itself is drawn, so a badge there printed a
   label across the animal it was labelling (captured; that is why it moved).
   Above the toast stack and clear of the shard pill on the right.
   top was 18px before the compass took the top band; see .bs-compass. */
.bs-riding{position:absolute;left:50%;top:52px;transform:translateX(-50%) translateY(-8px);
  padding:7px 16px;border-radius:999px;font-size:11.5px;font-weight:800;letter-spacing:.06em;
  color:#dff5ff;white-space:nowrap;opacity:0;
  box-shadow:0 8px 24px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.08),
    inset 3px 0 0 #8ef0ff;
  transition:opacity .28s ease,transform .28s cubic-bezier(.34,1.56,.64,1)}
.bs-riding.show{opacity:1;transform:translateX(-50%) translateY(0)}

/* ---- left cluster: one party panel (beasts + player hp) ----------------- */
/* Single continuous glass slab. The beast rows and the player HP block are
   sections inside it, not free-floating cards with a gap between them. */
.bs-left{position:absolute;left:16px;bottom:16px;display:flex;flex-direction:column;width:288px;
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
.bs-beast.support .nm{font-size:12px}
.bs-beast .bs-beast-in{display:flex;align-items:center;gap:10px}
.bs-beast .bs-beast-in.bs-swap{animation:bsSwap .5s cubic-bezier(.34,1.56,.64,1)}
@keyframes bsSwap{0%{transform:translateY(12px) scale(.9);opacity:.15}
  60%{transform:translateY(-3px) scale(1.04);opacity:1}100%{transform:none;opacity:1}}
.bs-beast .badge{width:38px;height:38px;border-radius:50%;flex:none;display:grid;place-items:center;
  background:radial-gradient(circle at 34% 28%,rgba(255,255,255,.42),rgba(255,255,255,0) 46%),var(--el);
  color:rgba(255,255,255,.96);
  box-shadow:inset 0 -4px 8px rgba(0,0,0,.28),0 2px 8px rgba(0,0,0,.35)}
.bs-beast .badge svg{width:21px;height:21px;filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.4))}
.bs-beast .meta{flex:1;min-width:0}
.bs-beast .row{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:4px}
.bs-beast .nm{font-weight:800;font-size:13.5px;letter-spacing:.02em;white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis;text-shadow:0 1px 2px rgba(0,0,0,.45)}
.bs-beast .lv{font-size:10.5px;font-weight:800;color:var(--el);background:rgba(255,255,255,.09);
  padding:1px 7px;border-radius:999px;flex:none;filter:saturate(1.3) brightness(1.35)}
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
.bs-hp .lbl{font-size:10.5px;font-weight:900;letter-spacing:.22em;color:rgba(238,242,248,.72)}
.bs-hp .val{font-size:12.5px;font-weight:800;font-variant-numeric:tabular-nums;
  text-shadow:0 1px 2px rgba(0,0,0,.5)}
.bs-hp .track{position:relative;height:15px;border-radius:9px;background:rgba(0,0,0,.5);overflow:hidden;
  box-shadow:inset 0 2px 5px rgba(0,0,0,.55),inset 0 0 0 1px rgba(255,255,255,.07)}
.bs-hp .ghost{position:absolute;top:0;bottom:0;left:0;border-radius:9px;background:rgba(255,246,238,.85)}
.bs-hp .fill{position:absolute;top:0;bottom:0;left:0;border-radius:9px;transition:width .12s ease;
  filter:saturate(.8)}
.bs-hp .fill::after{content:"";position:absolute;left:0;right:0;top:0;height:46%;
  border-radius:9px 9px 0 0;background:linear-gradient(rgba(255,255,255,.4),rgba(255,255,255,.04))}

/* ---- hotbar ------------------------------------------------------------ */
.bs-hotbar{position:absolute;left:50%;bottom:34px;transform:translateX(-50%);display:flex;gap:11px}
.bs-slot{width:58px;height:58px;border-radius:14px;position:relative;display:grid;place-items:center;
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
.bs-slot.empty .lock{width:20px;height:20px;color:#eef2f8;opacity:.45}
.bs-slot.empty .lock svg{width:100%;height:100%}
.bs-slot.filled{border-color:transparent;
  box-shadow:inset 0 0 0 1.5px var(--el2),0 6px 16px rgba(0,0,0,.32)}
.bs-slot .key{position:absolute;top:3px;left:7px;font-size:10px;font-weight:800;
  color:rgba(255,255,255,.62);text-shadow:0 1px 2px rgba(0,0,0,.6)}
.bs-slot .ic{width:26px;height:26px;color:var(--el);transition:opacity .2s ease,filter .3s ease;
  filter:saturate(1.25) brightness(1.3) drop-shadow(0 1px 2px rgba(0,0,0,.5))}
.bs-slot .ic svg{width:100%;height:100%}
.bs-slot.ready .ic{animation:bsReadyGlow 2.4s ease-in-out infinite}
@keyframes bsReadyGlow{0%,100%{filter:saturate(1.25) brightness(1.3) drop-shadow(0 0 2px var(--el))}
  50%{filter:saturate(1.4) brightness(1.55) drop-shadow(0 0 8px var(--el))}}
.bs-slot.cooling .ic{opacity:.38;animation:none}
.bs-slot .cd{position:absolute;inset:2px;border-radius:11px;pointer-events:none}
.bs-slot .cdnum{position:absolute;inset:0;display:grid;place-items:center;font-size:15px;font-weight:900;
  font-variant-numeric:tabular-nums;color:#fff;text-shadow:0 1px 4px rgba(0,0,0,.85);pointer-events:none}
.bs-slot .nm{position:absolute;bottom:-19px;left:50%;transform:translateX(-50%);font-size:11px;
  font-weight:700;letter-spacing:.03em;white-space:nowrap;color:#e8e2d8;
  text-shadow:0 1px 3px rgba(0,0,0,.8)}
.bs-slot.bs-flash{animation:bsFlash .55s cubic-bezier(.34,1.56,.64,1)}
@keyframes bsFlash{0%{box-shadow:0 0 0 0 var(--el),inset 0 0 0 1.5px var(--el2);transform:scale(1)}
  40%{box-shadow:0 0 24px 6px var(--el),inset 0 0 14px var(--el2);transform:scale(1.14)}
  100%{box-shadow:inset 0 0 0 1.5px var(--el2),0 6px 16px rgba(0,0,0,.32);transform:scale(1)}}

/* ---- hint pill --------------------------------------------------------- */
.bs-hint{position:absolute;left:50%;bottom:118px;transform:translateX(-50%) translateY(8px);
  padding:8px 18px;border-radius:999px;font-size:13.5px;font-weight:700;letter-spacing:.02em;
  opacity:0;transition:opacity .28s ease,transform .28s cubic-bezier(.34,1.56,.64,1);white-space:nowrap}
.bs-hint.show{opacity:1;transform:translateX(-50%) translateY(0)}

/* ---- dialogue panel ---------------------------------------------------- */
/* Above the hint pill's 118px rather than in place of it: talking is not a
   modal, so a gateway countdown can still be running underneath while someone
   is mid-sentence. The accent bar is the toast's, in the amber this HUD already
   uses for "something wants your attention". */
.bs-dialogue{position:absolute;left:50%;bottom:158px;transform:translateX(-50%) translateY(10px);
  width:min(560px,84vw);padding:12px 18px 13px;border-radius:14px;text-align:left;
  box-shadow:0 14px 34px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.09),
    inset 3px 0 0 #ffd23f;
  opacity:0;transition:opacity .26s ease,transform .3s cubic-bezier(.34,1.5,.64,1)}
.bs-dialogue.show{opacity:1;transform:translateX(-50%) translateY(0)}
.bs-dialogue .who{font-size:11px;font-weight:900;letter-spacing:.22em;color:#ffd23f;
  text-transform:uppercase;text-shadow:0 0 10px rgba(255,210,63,.45);margin-bottom:4px}
.bs-dialogue .line{font-size:15px;font-weight:700;line-height:1.35;color:#f2f5fa;
  text-shadow:0 1px 3px rgba(0,0,0,.55)}
.bs-dialogue .foot{margin-top:8px;font-size:11px;font-weight:700;letter-spacing:.02em;
  color:rgba(230,236,245,.55)}

/* ---- level-up banner --------------------------------------------------- */
/* top was 58px before the compass took the top band; see .bs-compass. */
.bs-banner{position:absolute;top:92px;left:50%;transform:translateX(-50%) translateY(-26px) scale(.94);
  opacity:0;padding:11px 30px 13px;border-radius:16px;text-align:center;
  transition:transform .45s cubic-bezier(.34,1.56,.64,1),opacity .35s ease}
.bs-banner.show{transform:translateX(-50%) translateY(0) scale(1);opacity:1}
.bs-banner .eyebrow{font-size:10px;font-weight:900;letter-spacing:.34em;color:#ffd23f;
  text-shadow:0 0 10px rgba(255,210,63,.6);margin-bottom:2px}
.bs-banner .txt{font-size:16px;font-weight:800;text-shadow:0 1px 3px rgba(0,0,0,.5)}
.bs-banner .txt em{font-style:normal;color:var(--el,#ffd23f);filter:saturate(1.3) brightness(1.35)}

/* ---- toasts ------------------------------------------------------------ */
/* top was 96px before the compass took the top band; see .bs-compass. */
.bs-toasts{position:absolute;top:130px;left:50%;transform:translateX(-50%);display:flex;
  flex-direction:column;gap:8px;align-items:center}
/* Same glass slab + accent-bar treatment as the party panel, so a toast never
   reads as an unstyled browser box dropped on top of a custom UI. */
.bs-toast{padding:9px 15px 10px;border-radius:12px;font-size:12.5px;font-weight:700;letter-spacing:.01em;
  max-width:340px;text-align:left;color:#eef2f8;text-shadow:0 1px 2px rgba(0,0,0,.5);
  background:var(--glass);border:1px solid var(--stroke);
  box-shadow:0 10px 26px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.09),inset 3px 0 0 #ffd23f;
  backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
  opacity:0;transform:translateY(-12px);
  transition:opacity .3s ease,transform .35s cubic-bezier(.34,1.56,.64,1)}
.bs-toast.show{opacity:1;transform:translateY(0)}
.bs-toast.hide{opacity:0;transform:translateY(-8px)}

/* ---- shop -------------------------------------------------------------- */
.bs-shopwrap{position:absolute;inset:0;display:grid;place-items:center;pointer-events:none}
.bs-scrim{position:absolute;inset:0;background:rgba(5,9,17,.58);opacity:0;transition:opacity .28s ease;
  backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px)}
.bs-shop{position:relative;width:min(880px,92vw);max-height:84vh;display:flex;flex-direction:column;
  border-radius:20px;opacity:0;transform:translateY(16px) scale(.96);
  transition:opacity .3s ease,transform .34s cubic-bezier(.34,1.45,.64,1);
  box-shadow:0 24px 64px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.1)}
.bs-shopwrap.open{pointer-events:auto}
.bs-shopwrap.open .bs-scrim{opacity:1}
.bs-shopwrap.open .bs-shop{opacity:1;transform:translateY(0) scale(1)}
.bs-shop-head{display:flex;align-items:center;gap:14px;padding:16px 20px 14px;
  border-bottom:1px solid rgba(255,255,255,.1)}
.bs-shop-head h2{font-size:19px;font-weight:900;letter-spacing:.04em;flex:1;
  text-shadow:0 1px 3px rgba(0,0,0,.5)}
.bs-shop-head .bal{display:flex;align-items:center;gap:7px;padding:6px 13px;border-radius:999px;
  background:rgba(105,217,255,.1);border:1px solid rgba(105,217,255,.28)}
.bs-shop-head .bal .ic{width:15px;height:15px;color:#69d9ff}
.bs-shop-head .bal .ic svg{width:100%;height:100%}
.bs-shop-head .bal b{font-size:14px;font-weight:800;font-variant-numeric:tabular-nums;color:#dff5ff}
.bs-shop-x{width:34px;height:34px;border-radius:10px;border:1px solid rgba(255,255,255,.16);
  background:rgba(255,255,255,.07);color:rgba(238,242,248,.8);display:grid;place-items:center;
  cursor:pointer;transition:background .15s,transform .15s;pointer-events:auto}
.bs-shop-x:hover{background:rgba(255,90,80,.28);transform:scale(1.06);color:#fff}
.bs-shop-x svg{width:15px;height:15px}
.bs-offers{display:grid;grid-template-columns:repeat(auto-fill,minmax(244px,1fr));gap:12px;
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
.bs-offer .oic{width:30px;height:30px;border-radius:9px;flex:none;display:grid;place-items:center;
  background:var(--el2);color:var(--el);filter:saturate(1.2) brightness(1.25)}
.bs-offer .oic svg{width:17px;height:17px}
.bs-offer h3{font-size:14px;font-weight:800;letter-spacing:.01em}
.bs-offer .beast{font-size:10.5px;font-weight:600;color:rgba(238,242,248,.55);margin-top:1px}
.bs-offer p{font-size:11.5px;line-height:1.45;color:rgba(238,242,248,.78);min-height:32px;margin-bottom:8px}
.bs-chips{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:10px}
.bs-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 8px 3px;border-radius:999px;
  background:rgba(255,255,255,.09);font-size:10.5px;font-weight:700;color:rgba(238,242,248,.85)}
.bs-chip b{color:#fff}
.bs-offer .foot{display:flex;align-items:center;gap:10px}
.bs-price{display:flex;align-items:center;gap:5px;font-weight:800;font-size:14px;
  font-variant-numeric:tabular-nums;color:#dff5ff}
.bs-price .ic{width:14px;height:14px;color:#69d9ff}
.bs-price .ic svg{width:100%;height:100%}
.bs-price.no{color:#ff8d84}
.bs-price.no .ic{color:#ff8d84}
.bs-buy{flex:1;padding:8px 0 9px;border-radius:10px;border:none;font-family:inherit;font-weight:800;
  font-size:12.5px;letter-spacing:.05em;cursor:pointer;color:#3a2703;
  background:linear-gradient(180deg,#ffd94f,#f5a623);
  box-shadow:0 3px 8px rgba(0,0,0,.3),inset 0 1px 0 rgba(255,255,255,.45);
  transition:transform .12s ease,filter .15s ease;pointer-events:auto}
.bs-buy:hover{filter:brightness(1.1);transform:translateY(-1px)}
.bs-buy:active{transform:translateY(1px) scale(.98)}
.bs-buy:disabled{cursor:default;background:rgba(255,255,255,.1);color:rgba(238,242,248,.4);
  box-shadow:none;transform:none;filter:none}
.bs-buy.owned{background:rgba(109,191,75,.18);color:#8fe06b;border:1px solid rgba(109,191,75,.4);
  display:flex;align-items:center;justify-content:center;gap:6px;cursor:default;box-shadow:none}
.bs-buy.owned svg{width:13px;height:13px}
.bs-shop-foot{border-top:1px solid rgba(255,255,255,.1);padding:11px 20px;display:flex;gap:16px;
  flex-wrap:wrap;justify-content:center;font-size:11.5px;font-weight:600;color:rgba(238,242,248,.7)}
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
   half the width of the WASD row's, which reads as a broken table. 96/86 is
   measured off the widest cell each has to hold: the Space cap in the keyboard
   column, and the four D-pad arrows in the controller one. */
.bs-keyswrap{position:absolute;inset:0;display:grid;place-items:center;pointer-events:none}
.bs-keys{position:relative;width:min(940px,94vw);max-height:88vh;display:flex;flex-direction:column;
  border-radius:20px;opacity:0;transform:translateY(16px) scale(.96);
  transition:opacity .3s ease,transform .34s cubic-bezier(.34,1.45,.64,1);
  box-shadow:0 24px 64px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.1)}
.bs-keyswrap.open{pointer-events:auto}
.bs-keyswrap.open .bs-scrim{opacity:1}
.bs-keyswrap.open .bs-keys{opacity:1;transform:translateY(0) scale(1)}
.bs-keys-head{display:flex;align-items:center;gap:14px;padding:16px 20px 14px;
  border-bottom:1px solid rgba(255,255,255,.1)}
.bs-keys-head h2{font-size:19px;font-weight:900;letter-spacing:.04em;flex:1;
  text-shadow:0 1px 3px rgba(0,0,0,.5)}
.bs-keys-body{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));
  gap:4px 28px;padding:14px 20px 4px;overflow-y:auto;
  scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.25) transparent}
.bs-keys-sec{align-content:start;padding-bottom:12px}
.bs-keyrow{display:grid;grid-template-columns:minmax(0,1fr) 96px 86px 54px;align-items:center;
  gap:8px;padding:5px 8px;border-radius:9px;font-size:12.5px}
.bs-keyrow:not(.head):nth-child(even){background:rgba(255,255,255,.04)}
.bs-keyrow .nm{display:flex;flex-direction:column;gap:1px;font-weight:700;
  color:rgba(238,242,248,.92)}
/* The caveat under a row — the climb note, the combo note. Quiet on purpose:
   it is the second thing the row says, and a player scanning for a key should
   scan past it. */
.bs-keyrow .nm em{font-style:normal;font-size:10.5px;font-weight:600;line-height:1.35;
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
.bs-keyrow .mode{justify-self:end;padding:2px 7px 3px;border-radius:999px;
  font-size:9.5px;font-weight:800;letter-spacing:.08em}
.bs-keyrow .mode.hold{background:linear-gradient(180deg,#ffd94f,#f5a623);color:#3a2703;
  box-shadow:0 1px 5px rgba(245,166,35,.35)}
.bs-keyrow .mode.press{background:rgba(255,255,255,.07);color:rgba(238,242,248,.45)}
.bs-keyrow.head{margin-top:4px;padding-bottom:7px;border-bottom:1px solid rgba(255,255,255,.1);
  border-radius:0}
.bs-keyrow.head .nm{font-size:12px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;
  color:#ffd23f}
.bs-keyrow.head .kbm,.bs-keyrow.head .pad{font-size:9.5px;font-weight:800;letter-spacing:.06em;
  text-transform:uppercase;color:rgba(238,242,248,.42)}
.bs-keys-foot{border-top:1px solid rgba(255,255,255,.1);padding:11px 20px;text-align:center;
  font-size:11.5px;font-weight:600;color:rgba(238,242,248,.7)}

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
  .bs-menu .logo,.bs-menu .panel{transition:none}
}

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
.bs-menu[data-step="settings"]{--slide:0vh;--gap:44px}
/* A soft pool of shade under the list, and nothing more solid than that.
   Captured without it, the rows sat over a village, a red banner and the hero's
   arm, and every one of those read THROUGH the wood — the buttons looked
   translucent when they are not. A hard panel would have fixed it too and hidden
   the painting the screen exists to show; this darkens what is directly behind
   the type and fades out well before the frame edges. */
.bs-menu[data-step="options"] .panel::before,
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
   screen came out looking like a bug. */
.bs-menu .press{text-align:center;font-size:clamp(16px,2.4vw,23px);font-weight:900;
  letter-spacing:.16em;text-transform:uppercase;
  text-shadow:0 1px 2px rgba(0,0,0,.95),0 2px 12px rgba(0,0,0,.9),
    0 0 30px rgba(255,196,90,.5);
  animation:bsPressPulse 1.9s ease-in-out infinite}
@keyframes bsPressPulse{0%,100%{opacity:1}50%{opacity:.45}}

/* Positioned, so it paints ABOVE the panel's absolutely-positioned shade —
   without this the ::before above would cover the buttons rather than sit
   behind them. */
.bs-menu .opts{position:relative;z-index:1;
  display:flex;flex-direction:column;align-items:stretch;gap:10px}
.bs-menu .opts h2{font-size:13px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;
  text-align:center;color:rgba(255,255,255,.72);text-shadow:0 2px 6px rgba(0,0,0,.8);
  margin-bottom:2px}
.bs-menu .note{font-size:11.5px;font-weight:600;line-height:1.35;text-align:center;
  color:rgba(255,255,255,.62);text-shadow:0 1px 4px rgba(0,0,0,.85);margin:-4px 0 2px}
/* Wood-and-gold, taken from the logo rather than from the HUD's cool glass:
   this screen belongs to the painting, not to the interface that comes after. */
.bs-menu-btn{display:flex;align-items:center;justify-content:center;gap:10px;
  width:100%;padding:13px 18px;border-radius:12px;cursor:pointer;
  font-family:inherit;font-size:15px;font-weight:800;letter-spacing:.05em;
  color:#f4e7cd;text-shadow:0 1px 2px rgba(0,0,0,.6);
  /* OPAQUE. At 92% the red gate banner behind the settings list came through
     the wood as a pink rectangle inside the row — captured, and it read as a
     rendering fault rather than as translucency. The shade behind the panel is
     where the art is allowed to show; the buttons themselves are solid. */
  background:linear-gradient(180deg,#5b3d24,#33210f);
  border:1px solid rgba(255,214,140,.3);
  box-shadow:0 6px 18px rgba(0,0,0,.42),inset 0 1px 0 rgba(255,226,170,.22);
  transition:transform .14s cubic-bezier(.34,1.5,.64,1),filter .14s ease,box-shadow .14s ease}
.bs-menu-btn:hover:not([disabled]){filter:brightness(1.16);transform:translateY(-1px)}
.bs-menu-btn:active:not([disabled]){transform:translateY(1px) scale(.985);filter:brightness(1.24)}
/* The focus ring is the pad's cursor as much as the keyboard's, so it is loud on
   purpose — on a controller it is the ONLY thing saying where you are. */
.bs-menu-btn:focus-visible{outline:none;
  box-shadow:0 0 0 2px rgba(255,214,120,.95),0 0 22px rgba(255,196,90,.6),
    0 6px 18px rgba(0,0,0,.42),inset 0 1px 0 rgba(255,226,170,.22)}
.bs-menu-btn.primary{color:#3a2703;border-color:transparent;
  background:linear-gradient(180deg,#ffd94f,#f0a12a);
  box-shadow:0 6px 20px rgba(0,0,0,.42),inset 0 1px 0 rgba(255,255,255,.5)}
.bs-menu-btn[disabled]{cursor:default;opacity:.42;filter:grayscale(.5)}
/* A settings row: label left, state pill right. */
.bs-menu-btn.row{justify-content:space-between;font-size:14px;padding:12px 14px 12px 18px}
.bs-menu-btn.row .lbl{font-weight:700;letter-spacing:.02em}
.bs-menu-btn.row .pill{flex:none;min-width:46px;padding:4px 10px 5px;border-radius:999px;
  font-size:11px;font-weight:900;letter-spacing:.1em;
  background:rgba(0,0,0,.38);border:1px solid rgba(255,214,140,.24);
  color:rgba(244,231,205,.6)}
.bs-menu-btn.row[aria-pressed="true"] .pill{color:#3a2703;border-color:transparent;
  background:linear-gradient(180deg,#ffd94f,#f0a12a)}
.bs-menu .row.lang{display:flex;align-items:center;justify-content:space-between;gap:10px;
  padding:2px 4px 2px 18px;font-size:14px;font-weight:700;
  text-shadow:0 1px 3px rgba(0,0,0,.8)}
.bs-menu .langs{display:flex;gap:6px}
.bs-menu-btn.chip{width:auto;padding:8px 13px;font-size:12.5px;letter-spacing:.04em;border-radius:999px}
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
   compacted. */
@media (min-height:521px) and (max-height:660px){
  .bs-menu[data-step="settings"] .fore{grid-template-rows:0 auto auto 1fr}
  .bs-menu[data-step="settings"]{--gap:20px}
  .bs-menu[data-step="settings"] .opts{gap:7px}
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
  .bs-menu-btn{padding:9px 16px;font-size:13.5px}
  .bs-menu-btn.row{padding:8px 12px 8px 16px}
  .bs-menu .opts{gap:7px}
  .bs-menu .press{font-size:15px}
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
  .bs-menu[data-step="settings"] .logo{display:none}
  /* 1fr above AND below the panel, so with no logo it is centred rather than
     parked against the top with all the slack underneath it. */
  .bs-menu[data-step="options"] .fore,
  .bs-menu[data-step="settings"] .fore{grid-template-rows:0 1fr auto 1fr}
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
   panel ends 43px clear of the bottom. */
@media (max-height:600px){
  .bs-menu[data-step="settings"] .logo{display:none}
  .bs-menu[data-step="settings"] .fore{grid-template-rows:0 1fr auto 1fr}
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
.bs-load.chip .box{width:min(248px,52vw);padding:9px 13px 11px;border-radius:12px;
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
  font-size:11px;font-weight:800;letter-spacing:.13em;text-transform:uppercase;
  color:rgba(238,242,248,.74);text-shadow:0 1px 2px rgba(0,0,0,.5)}
.bs-load.cover .cap{font-size:12.5px}
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
.bs-title{left:max(16px,env(safe-area-inset-left));top:max(14px,env(safe-area-inset-top))}
.bs-shards{right:max(16px,env(safe-area-inset-right));top:max(14px,env(safe-area-inset-top))}
.bs-compass{top:max(10px,env(safe-area-inset-top))}
.bs-bag{right:max(16px,env(safe-area-inset-right));top:calc(max(14px,env(safe-area-inset-top)) + 44px)}

/* Tablet / large phone: shrink the party panel and hotbar. */
@media (max-width: 900px){
  .bs-compass{width:min(340px,46vw)}
  .bs-left{width:236px;padding:6px}
  .bs-beast{padding:6px 8px}
  .bs-beast .badge{width:32px;height:32px}
  .bs-beast .badge svg{width:18px;height:18px}
  .bs-beast .nm{font-size:12.5px}
  .bs-hp .track{height:13px}
  .bs-slot{width:50px;height:50px;border-radius:12px}
  .bs-hotbar{gap:8px;bottom:26px}
  .bs-shop{width:min(94vw,720px)}
  /* One column of sections below 900px: two 360px columns plus the panel's own
     padding wants 800px of content box, which a 900px window no longer has. */
  .bs-keys{width:min(94vw,560px)}
  .bs-keys-body{grid-template-columns:1fr}
}

/* Phone: the touch overlay owns the bottom corners, so the HUD moves out of
   the way — party panel to the top-left under the title, keyboard hints and
   the desktop hotbar hidden (touch has its own skill buttons). */
@media (max-width: 620px), (max-height: 460px){
  /* The whole HUD scales down: at 393 CSS px the desktop sizes eat a third of
     the screen. Panel is compact and parked top-left under the title chip. */
  /* Hard cap so the party panel can never dominate the frame: at ~350 CSS px
     the old min(48vw,168px) was still eating nearly half the width. */
  /* No compass on a phone. The top band is the one strip of screen the touch
     layout leaves alone, but the party panel (top-left), shard pill and toast
     stack (top-right) already close in on it from both sides, and a 170px strip
     between them shows barely 50° — a heading readout you have to squint at is
     worse than none. With it gone the three elements below it go back to the
     positions they had before the compass existed. */
  .bs-compass{display:none}
  .bs-riding{top:18px}
  .bs-banner{top:58px}
  .bs-left{width:min(40vw,160px);max-width:62vw;padding:5px;border-radius:13px;
    bottom:auto;top:calc(max(12px,env(safe-area-inset-top)) + 38px)}
  .bs-beasts{flex-direction:column;gap:1px}
  .bs-beast{padding:5px 7px;border-radius:9px}
  .bs-beast .bs-beast-in{gap:7px}
  .bs-beast .badge{width:24px;height:24px}
  .bs-beast .badge svg{width:14px;height:14px}
  .bs-beast.support .badge{width:22px;height:22px}
  .bs-beast .nm{font-size:11px}
  .bs-beast.support .nm{font-size:10.5px}
  .bs-beast .lv{font-size:9px;padding:0 5px}
  .bs-beast .row{margin-bottom:3px}
  .bs-micro{height:4px}
  .bs-hp{padding:6px 7px 2px;margin-top:4px}
  .bs-hp .lbl{letter-spacing:.12em;font-size:9px}
  .bs-hp .val{font-size:10.5px}
  .bs-hp .track{height:11px;border-radius:7px}
  .bs-title{padding:5px 10px 6px;border-radius:9px}
  .bs-title b{font-size:10.5px;letter-spacing:.13em}
  .bs-title span{font-size:8.5px}
  .bs-shards{padding:5px 10px;gap:6px}
  .bs-shards .ic{width:14px;height:14px}
  .bs-shards .num{font-size:13px}
  /* Shrunk rather than hidden: a phone player needs to be able to name the
     money too, and the pill still fits inside the right safe-area inset. */
  .bs-shards .lbl{font-size:9.5px;letter-spacing:.02em}
  .bs-bag{top:calc(max(14px,env(safe-area-inset-top)) + 34px);gap:4px}
  .bs-bag .chip{padding:3px 9px;gap:6px}
  .bs-bag .nm{font-size:9.5px}
  .bs-bag .n{font-size:11px}
  /* touch has its own skill buttons; the desktop hotbar and key hints go away */
  .bs-hotbar{display:none}
  .bs-shop-foot{display:none}
  .bs-shop{width:96vw;max-height:82vh}
  /* The sheet is REACHABLE on a phone but not reachable FROM one: there is no
     F1 on a touchscreen, so this is what a player sees when a keyboard is
     attached to a small window. Tightened rather than hidden — the notes are
     what go, since a 96vw row cannot hold a caption and a key column. */
  .bs-keys{width:96vw;max-height:86vh}
  .bs-keyrow{grid-template-columns:minmax(0,1fr) 78px 74px 46px;font-size:11.5px;padding:4px 6px}
  .bs-keyrow .nm em{display:none}
  /* Toasts: one at a time (see HUD.addToast), clear of the control clusters,
     and clamped to two short lines so a long instruction string can never grow
     into a screen-eating panel. */
  .bs-toasts{top:calc(max(12px,env(safe-area-inset-top)) + 38px);bottom:auto;
    left:auto;right:max(12px,env(safe-area-inset-right));transform:none;align-items:flex-end}
  .bs-toast{font-size:11px;line-height:1.35;padding:6px 9px;max-width:min(52vw,200px);
    border-radius:10px;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;
    line-clamp:2;overflow:hidden}
  .bs-banner{font-size:11.5px;padding:8px 12px;max-width:78vw}
  /* The interaction prompt has to clear the touch fans. Their topmost buttons
     (skill 1 on the right, SWAP on the left) reach 217px up from the bottom
     edge in BOTH orientations — the fan is sized in vmin, so it is the same
     cluster turned 90° — hence 232px here rather than the desktop 118px.
     Measured on a Pixel 5: portrait the pill lands at y 587-619, under the hero
     and above the arc; landscape at y 131-161, above the reticle and clear of
     the toast stack in the top-right. */
  .bs-hint{font-size:11px;padding:7px 11px;bottom:232px}
  /* Same argument as the pill, one panel higher: the fans reach 217px up, the
     pill takes the band at 232, and the dialogue sits above both. */
  .bs-dialogue{bottom:274px;padding:9px 12px 10px;width:min(88vw,420px)}
  .bs-dialogue .line{font-size:12.5px}
  .bs-dialogue .who{font-size:9.5px;letter-spacing:.18em}
  .bs-dialogue .foot{margin-top:5px;font-size:9.5px}
}

/* --- developer console (§) ------------------------------------------------
   Deliberately plain and monospaced: it is an instrument, not part of the
   game's look, and it must stay readable over any world behind it. Sits above
   the HUD's z-index but below the F2 overlay. */
.bs-console {
  position: fixed; left: 0; right: 0; top: 0;
  height: 42vh; min-height: 180px;
  display: flex; flex-direction: column;
  background: rgba(8, 12, 18, .92);
  border-bottom: 1px solid rgba(140, 200, 255, .28);
  box-shadow: 0 8px 32px rgba(0, 0, 0, .5);
  z-index: 9000;
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
`;

/** Inject the HUD stylesheet once. Safe to call repeatedly. */
export function injectStyles(): void {
  if (document.getElementById('bs-hud-styles')) return;
  const style = document.createElement('style');
  style.id = 'bs-hud-styles';
  style.textContent = CSS;
  document.head.appendChild(style);
}
