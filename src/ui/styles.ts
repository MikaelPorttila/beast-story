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
.bs-root.shop-open .bs-compass{opacity:0}
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
.bs-root.shop-open .bs-cross{opacity:0}

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

/* ---- fullscreen offer (touch devices only) ------------------------------- */
/* A body-level SIBLING of .bs-root, not a child of it. .bs-root carries
   z-index:20 and therefore opens its own stacking context, so nothing inside it
   can ever hit-test above the touch overlay (.bs-touch, z-index:30) — and this
   prompt is drawn right over the corner the look pad owns. Sitting at z-index:40
   in the ROOT stacking context is what lets it take its own taps. The dev
   console (9000) and the F2 overlay (9999) still win, as they should.

   There is no wrapper and no scrim: the ONLY pixels this thing occupies are its
   own, and both answers remove() the element outright, so nothing is left
   behind to swallow a drag. pointer-events:auto sits on the pill itself rather
   than on a parent, following the same opt-in rule the rest of the HUD uses.

   bottom:264px is measured, not guessed. What has to be cleared is not the fan
   buttons (topmost reach 217px up from the bottom edge in BOTH orientations —
   the fan is sized in vmin, so landscape is the same cluster turned 90°) but the
   INVISIBLE look pad behind them, which on an emulated Pixel 5 starts 232px up.
   240px was tried first and left the pill's bottom edge 8px above the pad: no
   overlap, but a thumb reaching for the top of the drag surface could clip the
   NO button. 264px puts a 32px band between them, and still sits above
   .bs-hint's 232px so the interaction prompt and this one never stack.
   Measured at 264: portrait pill y 530-587, landscape y 72-129 — clear of every
   stick and button, above the reticle at y 196 in landscape, and between the
   party panel (top-left) and the toast stack (top-right). */
.bs-fsprompt{position:fixed;left:50%;bottom:calc(264px + env(safe-area-inset-bottom));
  z-index:40;pointer-events:auto;touch-action:manipulation;
  display:flex;align-items:center;gap:10px;padding:9px 10px 9px 15px;
  max-width:min(330px,90vw);border-radius:14px;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  color:#eef2f8;-webkit-user-select:none;user-select:none;
  -webkit-tap-highlight-color:transparent;
  background:linear-gradient(165deg,rgba(30,38,54,.86),rgba(14,18,28,.92));
  border:1px solid rgba(255,255,255,.16);
  box-shadow:0 12px 30px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.09);
  backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
  /* The -50% centring lives in the transform, so every state below has to
     restate it or the pill jumps half its width sideways as it animates. */
  opacity:0;transform:translateX(-50%) translateY(10px);
  transition:opacity .26s ease,transform .3s cubic-bezier(.34,1.5,.64,1)}
.bs-fsprompt.show{opacity:1;transform:translateX(-50%) translateY(0)}
.bs-fsprompt .txt{flex:1;font-size:12.5px;font-weight:700;letter-spacing:.01em;
  line-height:1.3;text-shadow:0 1px 2px rgba(0,0,0,.5)}
.bs-fs-btn{flex:none;min-width:56px;padding:9px 14px 10px;border-radius:10px;
  border:1px solid rgba(255,255,255,.18);font-family:inherit;font-weight:800;
  font-size:12px;letter-spacing:.06em;cursor:pointer;
  background:rgba(255,255,255,.08);color:rgba(238,242,248,.82);
  transition:filter .12s ease,transform .12s ease}
.bs-fs-btn.yes{border-color:transparent;color:#3a2703;
  background:linear-gradient(180deg,#ffd94f,#f5a623);
  box-shadow:0 3px 8px rgba(0,0,0,.3),inset 0 1px 0 rgba(255,255,255,.45)}
.bs-fs-btn:active{filter:brightness(1.2);transform:translateY(1px) scale(.98)}

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
