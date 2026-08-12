/**
 * All HUD / shop CSS, injected once as a <style> tag.
 * Glassy panels, element-tinted accents, springy transitions.
 */

const CSS = `
/* THE 16px FLOOR (issue #17): no player-facing text below 16px. The scale is
   COMPRESSED, not multiplied — weight, colour and letter-spacing carry the
   hierarchy so the type range is 16–22 and boxes grow by about a third. The
   developer instruments (§ console, F3, F2) are exempt; tools/test-textsize.mjs
   holds everything else to the floor. */

/* --bs-vw/--bs-vh, not inset:0: on Android in fullscreen the layout viewport
   measured 110px taller than the display (issue #16, core/viewport.ts).
   Declared on :root because the bag, journal and pause menu are SIBLINGS of the
   HUD root, so a property on .bs-root never reached them.
   --pane is the same two colours at full alpha — a panel is opaque, a chip is
   not, and identical hues stop the two reading as two themes. */
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
/* .bs-journal is here because it is a SIBLING of the HUD root and the one panel
   built from real document elements — without the reset the browser's 40px list
   indent walks every objective line in off the left margin. */
.bs-root *,.bs-journal *{box-sizing:border-box;margin:0;padding:0}
.bs-root svg{display:block}
/* Three hosts on one rule: .bs-inv and .bs-journal are SIBLINGS of the HUD root
   and print the same caps, and three copies of this drift (issue #17). */
.bs-root kbd,.bs-inv kbd,.bs-journal kbd{display:inline-block;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.28);
  border-bottom-width:2px;border-radius:5px;padding:0 6px;font:inherit;font-weight:700;
  /* A cap is .86em of its sentence, floored at 16 (issue #17) — max() keeps both
     readings rather than flattening it to 16px everywhere. */
  font-size:max(16px,.86em);
  line-height:1.5;vertical-align:baseline}
/* Controller faces are round, so the shape alone names the device. */
.bs-root kbd.pad{border-radius:50%;border-bottom-width:1px;padding:0;min-width:1.5em;
  text-align:center;margin:0 1px}
/* A face that is a WORD (Start, Options) — a one-character circle clips it. */
.bs-root kbd.pad.wide{border-radius:999px;padding:0 7px}
.bs-glass{background:var(--glass);border:1px solid var(--stroke);border-radius:14px;
  box-shadow:0 8px 24px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.08);
  backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}
/* A PANEL IS NOT A CHIP: the four surfaces you open keep .bs-glass's border and
   shadow but take the glass out. Chips keep it — .bs-glass is worn by ten HUD
   readouts too, so this is a selector list rather than an edit to that class. */
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
/* The only element in .bs-root that opts back into pointer events — every other
   clickable thing lives inside a panel that turns the layer on. Hidden on a
   phone, where the touch overlay draws its own MENU. */
.bs-menubtn{position:absolute;top:14px;left:16px;display:flex;align-items:center;gap:8px;
  padding:7px 12px;border-radius:12px;cursor:pointer;pointer-events:auto;
  color:rgba(238,242,248,.9);font:inherit;
  transition:filter .12s ease,transform .12s ease}
.bs-menubtn svg{width:20px;height:20px;display:block}
.bs-menubtn .cap{display:flex;gap:4px}
.bs-menubtn:hover{filter:brightness(1.22)}
.bs-menubtn:active{transform:translateY(1px)}
/* The debug title chip owns this corner when it is up. */
.bs-root:has(.bs-title) .bs-menubtn{top:58px}

/* ---- currency counter --------------------------------------------------- */
.bs-shards{position:absolute;top:14px;right:16px;display:flex;align-items:center;gap:8px;
  padding:8px 14px;border-radius:999px}
.bs-shards .ic{width:21px;height:21px;color:#69d9ff;filter:drop-shadow(0 0 5px rgba(105,217,255,.55))}
.bs-shards .ic svg{width:100%;height:100%}
.bs-shards .num{font-variant-numeric:tabular-nums;font-weight:800;font-size:19px;letter-spacing:.02em;
  color:#dff5ff;text-shadow:0 1px 2px rgba(0,0,0,.5)}
.bs-shards .lbl{margin-left:-2px;font-size:16px;font-weight:700;letter-spacing:.04em;
  color:rgba(223,245,255,.72);text-shadow:0 1px 2px rgba(0,0,0,.5)}
/* ---- bag (stackable items) --------------------------------------------- */
.bs-bag{position:absolute;top:64px;right:16px;display:flex;flex-direction:column;
  align-items:flex-end;gap:6px;transform-origin:100% 0}
.bs-bag .chip{display:flex;align-items:center;gap:8px;padding:5px 12px;border-radius:999px}
.bs-bag .sw{width:12px;height:12px;border-radius:3px;box-shadow:0 0 9px currentColor}
.bs-bag .nm{font-size:16px;font-weight:700;color:rgba(238,242,248,.82)}
.bs-bag .n{font-variant-numeric:tabular-nums;font-weight:800;font-size:17px;color:#fff;
  text-shadow:0 1px 2px rgba(0,0,0,.5)}
/* ---- readied taming orb -------------------------------------------------- */
/* Bottom right, near the hotbar: a control used during a fight, not a readout. */
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
/* Filled by src/ui/journal.ts through HUD.setQuests. Anchored at 38% of the
   height because the right column already holds the shard pill, the bag (which
   GROWS DOWNWARD) and the readied orb — a tracker docked under the bag would have
   to guess its height. No panel around it: this is prose, so the text-shadow
   carries legibility instead. Opt-out per quest — see hudFlag in main.ts. */
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
/* Hidden while a panel is up — the pause menu does not cover this corner. */
.bs-root.shop-open .bs-quests,.bs-root.keys-open .bs-quests{opacity:0}

/* ---- compass ------------------------------------------------------------ */
/* Heading tape across the top centre. Deliberately unlike the rest of the HUD:
   no radius, no blur, flat fills, and letters carried by a hard four-way 1px
   outline, which is what keeps them readable over bright sand and dark canopy.
   Geometry top down: pointer 0..10, band 10..46 — the band is sized by its
   letters, so the 16px floor (issue #17) set every number in this block and
   pushed the badge, banner and toast stack below it down. */
.bs-compass{position:absolute;left:50%;top:10px;transform:translateX(-50%);
  width:min(560px,52vw);height:46px;transition:opacity .2s ease}
.bs-root.shop-open .bs-compass,.bs-root.keys-open .bs-compass{opacity:0}
/* The mask fade stops letters popping in mid-glyph. Fill alpha .6: less and the
   band vanishes into dark canopy, more and it reads as a letterbox bar. */
.bs-compass .win{position:absolute;left:0;right:0;top:10px;height:36px;overflow:hidden;
  background:rgba(6,10,17,.6);
  border-top:2px solid rgba(238,242,248,.9);border-bottom:2px solid rgba(238,242,248,.9);
  -webkit-mask:linear-gradient(90deg,transparent 0,#000 16px,#000 calc(100% - 16px),transparent 100%);
  mask:linear-gradient(90deg,transparent 0,#000 16px,#000 calc(100% - 16px),transparent 100%)}
/* Centre rule, drawn last so it sits over tape AND markers. */
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
/* One point off the floor, not two: an ordinal is already the wider mark, so
   colour and offset carry the difference the size used to. */
.bs-compass .lb.ord{font-size:16px;top:3px;letter-spacing:.06em;color:rgba(238,242,248,.7)}
/* Markers ride OVER the tape, which keeps the widget one band tall. */
.bs-compass .marks{position:absolute;inset:0}
.bs-compass .mk{position:absolute;left:50%;top:0;height:22px;min-width:20px;
  display:flex;align-items:center;justify-content:center;padding:0 5px;
  background:var(--mc);border:2px solid #05070c;
  font-size:16px;font-weight:900;letter-spacing:.04em;color:#05070c;
  will-change:transform}
/* A label-less marker is a pin, not the 20x22 box a four-character tag needs. */
.bs-compass .mk:empty{min-width:0;width:12px;height:14px;padding:0;top:4px}
/* Behind you: the chip parks at the strip's end as an arrow pointing the short way. */
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
/* A ZERO-SIZE box centred by transform, so the element IS the centre point and
   every tick is a symmetric shadow around it — it cannot drift off axis. */
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
/* Conic-gradient annulus at the reticle. The hole is a radial MASK, not an opaque
   inner disc — the HUD is transparent and there is no background to fake one with.
   Zero-size box, like the crosshair, so it cannot drift as the label changes. */
.bs-mounthold{position:absolute;left:50%;top:50%;width:0;height:0;
  opacity:0;transition:opacity .18s ease}
.bs-mounthold.show{opacity:1}
.bs-mounthold .ring{position:absolute;left:-27px;top:-27px;width:54px;height:54px;border-radius:50%;
  background:conic-gradient(#8ef0ff 0deg,rgba(255,255,255,.16) 0deg);
  filter:drop-shadow(0 0 6px rgba(142,240,255,.45));
  -webkit-mask:radial-gradient(circle,transparent 19px,#000 20px);
  mask:radial-gradient(circle,transparent 19px,#000 20px)}
/* "HOLD F TO MOUNT" (issue #17). Tracking drops to .12em with the size — at 16px
   the old .22em pushed the phrase past the ring on both sides. */
.bs-mounthold .lbl{position:absolute;top:40px;left:50%;transform:translateX(-50%);
  font-size:16px;font-weight:900;letter-spacing:.12em;white-space:nowrap;
  color:rgba(238,242,248,.92);text-shadow:0 1px 3px rgba(0,0,0,.85)}

/* ---- riding badge ------------------------------------------------------ */
/* Top centre, NOT bottom: down there it printed a label across the mount it was
   labelling. Its top offset follows .bs-compass's band. */
.bs-riding{position:absolute;left:50%;top:64px;transform:translateX(-50%) translateY(-8px);
  padding:7px 16px;border-radius:999px;font-size:17px;font-weight:800;letter-spacing:.04em;
  color:#dff5ff;white-space:nowrap;opacity:0;
  box-shadow:0 8px 24px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.08),
    inset 3px 0 0 #8ef0ff;
  transition:opacity .28s ease,transform .28s cubic-bezier(.34,1.56,.64,1)}
.bs-riding.show{opacity:1;transform:translateX(-50%) translateY(0)}

/* ---- left cluster: one party panel (beasts + player hp) ----------------- */
/* One glass slab; the beast rows and the HP block are sections inside it.
   340px, up from 288 for the 16px floor (issue #17) — a name plus a level chip
   needs it to sit on one line without ellipsing. */
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
/* The LOCOMOTION pip, on the badge rather than as a second badge — that pushed the
   name into an ellipsis on a phone. Dark disc under a light glyph so it separates
   from var(--el), which runs from #fff3c4 to #7a5fa8. */
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
/* A faint amber wash, so a near-empty bar reads as "no progress" not "no render". */
.bs-micro.xp{background:linear-gradient(90deg,rgba(245,166,35,.2),rgba(255,210,63,.09)),rgba(0,0,0,.42)}
.bs-micro.xp>i{background:linear-gradient(90deg,#f5a623,#ffd23f)}

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
/* 66px, up from 58 for the 16px floor (issue #17): at 16px the corner key cap
   touched the centred icon in a 58px box. */
.bs-slot{width:66px;height:66px;border-radius:15px;position:relative;display:grid;place-items:center;
  background:var(--glass);border:1px solid var(--stroke);
  box-shadow:0 6px 16px rgba(0,0,0,.32),inset 0 1px 0 rgba(255,255,255,.08);
  backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
  transition:transform .16s ease,box-shadow .25s ease;pointer-events:auto}
.bs-slot:hover{transform:translateY(-3px)}
/* Unearned: a solid slab with a padlock. A dashed box read as unimplemented. */
.bs-slot.empty{border-style:solid;border-color:rgba(255,255,255,.13);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.05);opacity:.72}
.bs-slot.empty .key{color:rgba(255,255,255,.4)}
.bs-slot.empty .lock{width:22px;height:22px;color:#eef2f8;opacity:.45}
.bs-slot.empty .lock svg{width:100%;height:100%}
.bs-slot.filled{border-color:transparent;
  box-shadow:inset 0 0 0 1.5px var(--el2),0 6px 16px rgba(0,0,0,.32)}
/* The slot's key number — issue #17's second named case; was a 10px watermark. */
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
/* "Press E — Talk to …", issue #17's third named case. 128px, up from 118 when
   the hotbar's slots grew for the floor. */
.bs-hint{position:absolute;left:50%;bottom:128px;transform:translateX(-50%) translateY(8px);
  padding:9px 20px;border-radius:999px;font-size:18px;font-weight:700;letter-spacing:.02em;
  opacity:0;transition:opacity .28s ease,transform .28s cubic-bezier(.34,1.56,.64,1);white-space:nowrap}
.bs-hint.show{opacity:1;transform:translateX(-50%) translateY(0)}

/* ---- dialogue panel ---------------------------------------------------- */
/* Above the hint pill rather than in place of it: talking is not a modal, so a
   countdown can still be running underneath. */
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
/* top follows .bs-compass's band. */
.bs-banner{position:absolute;top:104px;left:50%;transform:translateX(-50%) translateY(-26px) scale(.94);
  opacity:0;padding:11px 30px 13px;border-radius:16px;text-align:center;
  transition:transform .45s cubic-bezier(.34,1.56,.64,1),opacity .35s ease}
.bs-banner.show{transform:translateX(-50%) translateY(0) scale(1);opacity:1}
.bs-banner .eyebrow{font-size:16px;font-weight:900;letter-spacing:.26em;color:#ffd23f;
  text-shadow:0 0 10px rgba(255,210,63,.6);margin-bottom:2px}
.bs-banner .txt{font-size:22px;font-weight:800;text-shadow:0 1px 3px rgba(0,0,0,.5)}
.bs-banner .txt em{font-style:normal;color:var(--el,#ffd23f);filter:saturate(1.3) brightness(1.35)}

/* ---- toasts ------------------------------------------------------------ */
/* 184 clears the level-up banner's FULL height — at 130 a toast arriving while one
   was up printed across its bottom edge. */
.bs-toasts{position:absolute;top:184px;left:50%;transform:translateX(-50%);display:flex;
  flex-direction:column;gap:8px;align-items:center}
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
/* THE SCRIM IS INVISIBLE AND STILL LOAD-BEARING: it dims nothing (panels are
   opaque now) but it is the click-to-close target for four panels and the
   throw-into-the-world drop target (dropTarget in ui/inventory.ts). An opacity:0
   element still takes clicks. */
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
/* 296px, up from 244: at the 16px floor the stat chips wrapped to three rows. */
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
/* min-height is THREE lines, so every card in a row ends its buy button on the
   same baseline — the longest description went to three lines at 16px. */
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
/* Same wrapper/scrim/panel construction as the shop, reusing .bs-scrim and
   .bs-shop-x outright. The body is auto-fit columns so the sheet fits on screen
   without scrolling and reflows to one column with no breakpoint; each section is
   its own grid, so a wide heading cannot push another's columns out of line.
   The key columns are FIXED (118/104, measured off the Space cap and the four
   D-pad arrows) — sized to content the ']' row read as a broken table. */
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
/* Row padding 3px, down from 5: the sheet has to fit at 1080 and thirty rows at
   the 16px floor are ~120px taller, so the space comes out of the gaps. */
.bs-keyrow{display:grid;grid-template-columns:minmax(0,1fr) 118px 104px 68px;align-items:center;
  gap:8px;padding:3px 8px;border-radius:9px;font-size:17px}
.bs-keyrow:not(.head):nth-child(even){background:rgba(255,255,255,.04)}
.bs-keyrow .nm{display:flex;flex-direction:column;gap:1px;font-weight:700;
  color:rgba(238,242,248,.92)}
/* The caveat under a row. Quiet, so a player scanning for a key scans past it. */
.bs-keyrow .nm em{font-style:normal;font-size:16px;font-weight:600;line-height:1.35;
  color:rgba(238,242,248,.5)}
.bs-keyrow .kbm,.bs-keyrow .pad{text-align:right;white-space:nowrap;
  color:rgba(238,242,248,.9)}
.bs-keyrow .pad .none{color:rgba(238,242,248,.32);font-weight:700}
/* HOLD is the loud one; PRESS is the default and near-invisible on purpose, which
   is what makes the handful of HOLD rows jump off the page. */
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
/* src/ui/inventory.ts. Wears the HUD's glass, not the pause menu's wood, and
   reuses .bs-scrim, .bs-glass, .bs-shop-x, .bs-chip and .bs-buy outright.
   A right-hand dock at full height: the stage needs height for three figures to
   stand in, and docked it leaves half the frame as the world.
   z-index 40, alongside .bs-pause: over the HUD (20) and touch overlay (30),
   under the title screen (50). Measured in --bs-vh, not dvh — on a phone in
   fullscreen those disagree by 110px and the footer falls off (issue #16). */
.bs-inv{position:fixed;inset:0;z-index:40;display:flex;justify-content:flex-end;
  pointer-events:auto;touch-action:manipulation;-webkit-tap-highlight-color:transparent;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  color:#eef2f8;user-select:none;-webkit-user-select:none}
.bs-inv .bs-scrim{opacity:0}
.bs-inv.open .bs-scrim{opacity:1}
/* Sized by the wall: eleven 52px slots with 9px gaps is 662px plus padding. */
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
/* .cap is worn by every "bound to this control" glyph here, so the phone rule can
   hide all of them at once. */
.bs-inv .head .cap{display:flex;gap:5px;opacity:.62}

/* THE STAGE: a live WebGL canvas (ui/inventory-stage.ts). A FIXED height rather
   than an aspect ratio — the slot wall is what should grow with the window.
   pointer-events:none, or a drag crossing the canvas loses its drop. */
.bs-inv .stage{position:relative;height:230px;flex:none;
  background:radial-gradient(120% 90% at 50% 12%,rgba(120,170,255,.14),transparent 70%)}
.bs-inv .stage-gl{position:absolute;inset:0;width:100%;height:100%;
  display:block;pointer-events:none}

/* FOUR GEAR SLOTS — lead beast, weapon, support beast, taming orb — in the order
   the figures stand on the stage above. Equal tracks: a slot you drag onto has to
   be the same size as its neighbours or it reads as a status pip. */
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
/* The wall's selection ring, meaning the same thing: the footer points here. A gear
   slot is the ONLY place an equipped row can be selected from. */
.bs-inv .gs.sel{outline:2px solid #69d9ff;outline-offset:-2px}
.bs-inv .gs.r-rare{border-color:rgba(105,217,255,.5)}
.bs-inv .gs.r-legendary{border-color:rgba(255,190,80,.62)}
.bs-inv .gs-ic{width:52px;height:52px;display:block}
/* The slot's ROLE only — no element for the item's NAME, which is what keeps the
   slots the same width whatever is in them. See gearHtml. */
.bs-inv .gs-l{font-size:16px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;
  color:rgba(238,242,248,.42);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  max-width:100%}
/* A legal drop target, while something is being dragged over it. */
.bs-inv .drop-ok{border-color:#8fe06b;box-shadow:0 0 0 2px rgba(143,224,107,.35) inset,
  0 0 22px -6px rgba(143,224,107,.9)}

/* THE THREE MOUNT BADGES, in the order the story hands them out. Pips rather than
   gear slots: these take no gesture (see mountsHtml). The words live in the tooltip
   and aria-label, which is why nothing here needs the 16px floor. */
.bs-inv .mounts{display:flex;justify-content:center;gap:10px;padding:10px 18px;
  border-bottom:1px solid rgba(255,255,255,.08)}
.bs-inv .mt{width:38px;height:32px;display:flex;align-items:center;justify-content:center;
  border-radius:10px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);
  color:var(--el);opacity:.4;cursor:help;transition:opacity .18s ease,border-color .18s ease,
  box-shadow .2s ease}
/* Unlocked is the lit one; locked is the same badge at 40%, not a padlock. */
.bs-inv .mt.on{opacity:1;border-color:var(--el);box-shadow:0 0 18px -8px var(--el)}
.bs-inv .mt:hover{opacity:1}
/* Square and fixed, overriding .ic.glyph's 70%-of-the-box below, which is written
   for a square gear slot. Four classes, so it wins on specificity not on order. */
.bs-inv .mt .ic.glyph{width:20px;height:20px;margin:0}

.bs-inv .tabs{display:flex;gap:6px;flex-wrap:wrap;padding:11px 18px 0}
.bs-inv .chip{padding:5px 12px 6px;border-radius:999px;border:1px solid rgba(255,255,255,.14);
  background:rgba(255,255,255,.05);color:rgba(238,242,248,.72);font-family:inherit;
  font-size:16px;font-weight:700;cursor:pointer;transition:background .15s,color .15s,border-color .15s}
.bs-inv .chip:hover{background:rgba(255,255,255,.12);color:#fff}
.bs-inv .chip.on{background:rgba(105,217,255,.16);border-color:rgba(105,217,255,.5);color:#dff5ff}

/* THE WALL. --cols carries INV_COLS from ui/inventory.ts, which is what the
   keyboard's up/down steps by — auto-fill would let the two disagree about what
   "the row below" means. minmax(0,1fr), not 1fr: a grid item's automatic minimum
   is its CONTENT, so 1fr refuses to shrink and the wall overflows.
   THE WALL SCROLLS AND THE PANEL DOES NOT, so the footer never moves. */
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
/* The selection ring is an OUTLINE, not a border, so it cannot reflow the wall.
   AN EMPTY CELL IS A REAL CELL: a <div> not a <button>, so a keyboard walks what
   you own — but it IS a drop target (issue #116), so no pointer-events:none.
   A .held cell's row is hidden by the tab filter, so nothing may land on it. */
.bs-inv .slot.empty{background:rgba(255,255,255,.035);border-color:rgba(255,255,255,.09);
  cursor:default}
.bs-inv .slot.empty:hover{transform:none;border-color:rgba(255,255,255,.09);box-shadow:none}
.bs-inv .slot.empty.held{background:rgba(255,255,255,.02);border-style:dashed}
.bs-inv .slot.sel{outline:2px solid #69d9ff;outline-offset:-2px;background:rgba(105,217,255,.1)}
.bs-inv .slot:focus-visible{outline:2px solid #ffd23f;outline-offset:-2px}
/* Rarity is the slot's EDGE, not its fill. */
.bs-inv .slot.r-rare{border-color:rgba(105,217,255,.45)}
.bs-inv .slot.r-legendary{border-color:rgba(255,190,80,.6);
  box-shadow:inset 0 0 22px -10px rgba(255,190,80,.9)}
/* Equipped: a corner dot, which survives every rarity border above. */
.bs-inv .slot.on::after{content:'';position:absolute;top:5px;right:5px;width:8px;height:8px;
  border-radius:50%;background:#8fe06b;box-shadow:0 0 8px rgba(143,224,107,.9)}
/* One element with a background: an atlas tile, a baked portrait, or the lozenge. */
.bs-inv .ic{width:100%;height:100%;display:block;background-repeat:no-repeat;
  background-position:center;background-size:contain}
.bs-inv .ic.blob{background-image:none;
  background:radial-gradient(circle at 38% 32%,#fff2,transparent 60%),var(--el);
  border-radius:26% 26% 30% 30%/30%;box-shadow:0 0 14px -4px var(--el);
  width:62%;height:62%;margin:auto}
/* An inline SVG glyph, tinted through currentColor. The drop shadow keeps a
   near-black Master Orb from vanishing into its slot. */
.bs-inv .ic.glyph{background:none;width:70%;height:70%;margin:auto;color:var(--el);
  filter:drop-shadow(0 0 6px rgba(255,255,255,.28))}
.bs-inv .ic.glyph svg{width:100%;height:100%;display:block}
.bs-inv .slot .n{position:absolute;top:4px;left:7px;font-size:16px;font-weight:800;
  font-variant-numeric:tabular-nums;color:#fff;text-shadow:0 1px 3px #000,0 0 6px #000}
/* Everything else fades mid-drag, so only the legal targets are lit. */
.bs-inv.dragging .slot,.bs-inv.dragging .gs{opacity:.55}
.bs-inv.dragging .drop-ok{opacity:1}
/* THE BOX IN THE AIR (issue #116): the panel's own cursor freight, parked under
   the pointer by a transform. pointer-events:none is required — the drag reads the
   wall through document.elementFromPoint, which would otherwise find only this. */
.bs-inv .drag-ghost{position:fixed;top:0;left:0;z-index:2;width:56px;height:56px;
  margin:-28px 0 0 -28px;padding:5px;border-radius:13px;pointer-events:none;
  display:grid;place-items:center;
  border:1px solid var(--el);background:rgba(10,14,22,.85);
  box-shadow:0 10px 26px rgba(0,0,0,.5),0 0 20px -6px var(--el)}

/* THE FOOTER STRIP. The constructive action is a right-click and is only NAMED
   here — see ui/inventory.ts's header. */
.bs-inv .sel{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:26px;
  padding:10px 18px;border-top:1px solid rgba(255,255,255,.1)}
.bs-inv .sel .nm{font-size:17px;font-weight:800;flex:1;min-width:0;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bs-inv .sel .bs-buy{flex:none;display:inline-flex;align-items:center;gap:7px;
  padding:5px 12px 6px;font-size:16px}
/* The binding, as a picture on its button. An unbound action has no icon (footHtml). */
.bs-inv .sel .cap{display:block;width:17px;height:17px;opacity:.85}
.bs-inv .sel .cap svg{width:100%;height:100%}
/* The primary action, a button only where there is no pointer to right-click with. */
.bs-inv .sel .bs-buy.ghost{background:rgba(255,255,255,.1);color:#eef2f8;
  border:1px solid rgba(255,255,255,.18);box-shadow:none}
.bs-inv .sel .bs-buy.ghost:hover{background:rgba(255,255,255,.18)}
.bs-inv .sel .bs-buy.danger{background:rgba(255,90,80,.12);color:#ff9d95;
  border:1px solid rgba(255,90,80,.34);box-shadow:none}
.bs-inv .sel .bs-buy.danger:hover{background:rgba(255,90,80,.24);color:#fff}

/* THE TOOLTIP, positioned against the VIEWPORT rather than inside the panel,
   because it has to be able to leave it. See moveTip for the clamping. */
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
/* A short window pays for the wall out of the STAGE, never out of the type
   (issue #17). Below 520 the stage goes entirely — a 90px stage is a smear. */
@media (max-height:620px){
  .bs-inv .stage{height:150px}
  .bs-inv .gs-ic{width:36px;height:36px}
}
@media (max-height:520px){
  .bs-inv .stage{display:none}
}

/* ---- quest journal (J) --------------------------------------------------- */
/* src/ui/journal.ts. The same dock the inventory is — same z-index 40, same
   --bs-vh, same .bs-glass / .bs-scrim / .bs-shop-x / .bs-chip / .bs-buy.
   Narrower (520 against 710) because a line of prose sets this width and a measure
   past ~60 characters gets harder to read. Full screen below 720px, which the
   inventory does not do: a 520px drawer on a 390px screen is a sheet already. */
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
/* The shelves, each carrying its count (tabsHtml). The <b> is not a badge — a pill
   on a pill is two borders saying one thing. */
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
/* The column scrolls and the panel does not, so the tabs stay on screen. */
.bs-journal .list{flex:1;min-height:0;overflow-y:auto;padding:12px 18px 18px;
  display:flex;flex-direction:column;gap:11px;
  scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.25) transparent}
.bs-journal .none{font-size:16px;line-height:1.5;color:rgba(238,242,248,.55);
  padding:26px 4px;text-align:center}
/* Category as a left EDGE, not a fill: main and side quests must read as the same
   kind of object, or a player learns to skip one. */
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
/* Arc, giver and place on one quiet line — labelled rows outshouted the objectives. */
.bs-journal .q-m{margin-top:3px;font-size:16px;font-weight:600;color:rgba(238,242,248,.5)}
.bs-journal .q-d{margin-top:7px;font-size:16px;line-height:1.45;color:rgba(238,242,248,.8)}
.bs-journal .steps{list-style:none;margin-top:9px;display:flex;flex-direction:column;gap:5px}
.bs-journal .steps li{display:flex;align-items:flex-start;gap:8px;font-size:16px;line-height:1.4;
  color:rgba(238,242,248,.9)}
.bs-journal .steps li.ok{color:rgba(238,242,248,.5);text-decoration:line-through}
.bs-journal .steps li b{margin-left:auto;font-weight:800;font-variant-numeric:tabular-nums;
  color:rgba(238,242,248,.7)}
/* Drawn done or not, so the list does not shift sideways line by line. */
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
/* Pressed says so with a colour, not only a label — it is a switch. */
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
/* src/ui/pause.ts. Borrows the TITLE SCREEN's controls (.bs-menu-btn, .bs-opts)
   because it does the title screen's job, and only .bs-scrim / .bs-glass from the
   HUD. z-index 40 is load-bearing: over the HUD (20) and touch overlay (30) so
   nothing behind is tappable, UNDER the title screen (50) so Exit's poster covers
   it. The pane is width-capped — stretched, an ON pill ends up a third of a metre
   from its label. */
.bs-pause{position:fixed;inset:0;z-index:40;display:grid;place-items:center;
  pointer-events:auto;touch-action:manipulation;-webkit-tap-highlight-color:transparent;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  color:#fff;user-select:none;-webkit-user-select:none}
.bs-pause .bs-scrim{position:absolute;inset:0;background:transparent;opacity:0;
  transition:opacity .22s ease}
.bs-pause.open .bs-scrim{opacity:1}
.bs-pause .pane{position:relative;width:min(420px,90vw);max-height:88vh;overflow-y:auto;
  padding:22px 20px;border-radius:0;
  /* Warm, so the wooden buttons do not sit on the HUD's blue-grey. */
  background:linear-gradient(180deg,#261a0f,#140e08);
  border:1px solid rgba(255,214,140,.22);
  box-shadow:0 24px 64px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,226,170,.14);
  opacity:0;transform:translateY(14px) scale(.97);
  transition:opacity .24s ease,transform .28s cubic-bezier(.34,1.45,.64,1);
  scrollbar-width:thin;scrollbar-color:rgba(255,214,140,.3) transparent}
.bs-pause.open .pane{opacity:1;transform:translateY(0) scale(1)}
/* Greyed as a whole row, so it does not read as three broken buttons. */
.bs-opts .row.lang.off{opacity:.45}
@media (prefers-reduced-motion:reduce){
  .bs-pause .bs-scrim,.bs-pause .pane{transition:none}
}

/* ---- start menu ---------------------------------------------------------- */
/* The title screen — see src/ui/menu.ts for the layers. z-index 50: over the HUD
   (20) and touch overlay (30). Unlike the rest of this sheet it OPTS IN to pointer
   events wholesale, and step one accepts a click anywhere on the poster. */
.bs-menu{position:fixed;inset:0;z-index:50;overflow:hidden;pointer-events:auto;
  touch-action:manipulation;-webkit-tap-highlight-color:transparent;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  color:#fff;user-select:none;-webkit-user-select:none;background:#0a0e14;
  opacity:0;transition:opacity .45s ease}
.bs-menu.show{opacity:1}
.bs-menu.leaving{opacity:0;transition:opacity .5s ease}
.bs-menu *{box-sizing:border-box;margin:0;padding:0}
/* photo=1&menu=1 — every animation stops, so two runs produce identical pixels. */
.bs-menu.photo *{animation-play-state:paused!important}
/* Reduced motion takes away MOVEMENT, not light: travel and scaling stop, the two
   things that only change BRIGHTNESS keep going. Pausing everything left the
   fairies frozen mid-air and the screen looking broken rather than calm. */
@media (prefers-reduced-motion:reduce){
  .bs-menu .fly{animation-play-state:paused}
  .bs-menu .fly b{animation:bsFlyTwinkle calc(var(--bob) * .45) ease-in-out infinite alternate}
  .bs-menu .lamp{animation-name:bsLampGlow}
  /* The entrance is NOT paused here: three fades are light, not travel. */
  .bs-menu .logo,.bs-menu .panel{transition:none}
}

/* ---- the entrance: logo, then painting, then "press start" --------------- */
/* Issue #49; see INTRO in src/ui/menu.ts for the why. The sequence is three
   animation delays adding up, so once .intro is added no JavaScript is involved —
   which is the point: the boot blocks the main thread in long tasks, and a
   setTimeout(550) for the second beat was measured firing at 4066 ms.
   .lit is the same layers with no sequence (the skip, photo=1, Exit to title). It
   sits AFTER .intro to win at equal specificity, and restates the press pulse
   because animation:none would otherwise take it away with the fades. */
.bs-menu .stage,.bs-menu .logo,.bs-menu .press{opacity:0}
.bs-menu.intro .logo{animation:bsIntroIn .55s ease both}
.bs-menu.intro .stage{animation:bsIntroIn .7s ease .55s both}
/* Two animations on one property: the pulse's delay puts it past the fade with no
   fill of its own, and both start from full opacity so the handover is invisible. */
.bs-menu.intro .press{animation:bsIntroIn .45s ease 1.25s both,
  bsPressPulse 1.9s ease-in-out 1.7s infinite}
.bs-menu.lit .stage,.bs-menu.lit .logo,.bs-menu.lit .press{opacity:1;animation:none}
.bs-menu.lit .press{animation:bsPressPulse 1.9s ease-in-out infinite}
@keyframes bsIntroIn{from{opacity:0}to{opacity:1}}

.bs-menu .stage{position:absolute;inset:0;overflow:hidden}
/* cover, written out, so the glows can be positioned in PER CENT OF THE PICTURE and
   stay on their lanterns at every aspect ratio. 1672/941 is the source art's ratio. */
.bs-menu .plate{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
  width:max(100vw,calc(100dvh * 1672 / 941));height:max(100dvh,calc(100vw * 941 / 1672))}
.bs-menu .art{width:100%;height:100%;object-fit:fill;display:block}
/* plus-lighter ADDS light; a normal-blended white circle reads as a lens smudge.
   The pulse is opacity AND scale together, ~18% above the trough. */
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
/* The same breath with the swell taken out, for prefers-reduced-motion. */
@keyframes bsLampGlow{from{opacity:.62}to{opacity:1}}

/* Fairies. Two nested elements so crossing and bobbing keep independent periods
   without JS: the outer travels, the inner wobbles. --sz alone sizes a sprite. */
.bs-menu .flies{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.bs-menu .fly{position:absolute;top:var(--top);left:0;width:var(--sz);height:var(--sz);
  will-change:transform;animation:bsFlyX var(--dur) linear var(--delay) infinite}
.bs-menu .fly.rev{animation-name:bsFlyXrev}
/* White CORE, coloured halo: amber all the way through washes out against a
   sunlit cloud. */
.bs-menu .fly b{display:block;width:100%;height:100%;border-radius:50%;
  background:radial-gradient(circle,#fff 0%,#fff6d2 28%,rgba(255,214,120,.75) 52%,rgba(255,190,90,0) 76%);
  box-shadow:0 0 calc(var(--sz) * 2.6) calc(var(--sz) * .8) rgba(255,208,120,.65),
             0 0 calc(var(--sz) * .9) rgba(255,255,255,.9);
  /* The twinkle runs at .45 of the bob, so the brightest moment lands somewhere
     different every pass rather than at the top of the arc. */
  animation:bsFlyY var(--bob) ease-in-out infinite alternate,
            bsFlyTwinkle calc(var(--bob) * .45) ease-in-out infinite alternate}
/* A cool-toned minority, so seven identical amber dots do not read as dust. */
.bs-menu .fly.cool b{
  background:radial-gradient(circle,#fff 0%,#e6fbff 28%,rgba(150,225,255,.75) 52%,rgba(110,205,255,0) 76%);
  box-shadow:0 0 calc(var(--sz) * 2.6) calc(var(--sz) * .8) rgba(150,222,255,.65),
             0 0 calc(var(--sz) * .9) rgba(255,255,255,.9)}
@keyframes bsFlyX{from{transform:translate3d(-6vw,0,0)}to{transform:translate3d(106vw,0,0)}}
@keyframes bsFlyXrev{from{transform:translate3d(106vw,0,0)}to{transform:translate3d(-6vw,0,0)}}
@keyframes bsFlyY{from{transform:translateY(calc(var(--bobY) * -1))}to{transform:translateY(var(--bobY))}}
/* Bright end FIRST: paused at 0% under photo=1, a dim-first keyframe froze all
   seven fairies invisible. Same reason the press pulse runs that way. */
@keyframes bsFlyTwinkle{from{opacity:1}to{opacity:.22}}

/* White type over bright noon art: darkened top and bottom where the logo and
   buttons live, untouched across the middle band. */
.bs-menu .vign{position:absolute;inset:0;pointer-events:none;
  background:
    linear-gradient(180deg,rgba(6,10,18,.55) 0%,rgba(6,10,18,.12) 26%,
      rgba(6,10,18,0) 46%,rgba(6,10,18,.28) 72%,rgba(6,10,18,.72) 100%),
    radial-gradient(120% 90% at 50% 40%,rgba(6,10,18,0) 40%,rgba(6,10,18,.45) 100%)}

/* FOUR ROWS: flexible, logo, panel, flexible. The logo aligns to its row's BOTTOM
   and the panel to its TOP, so the gap between them is exactly --gap at every
   window size and they cannot overlap however tall the panel grows; --slide moves
   the pair without changing that distance. The two fr rows split the rest, so the
   pair is centred AS A GROUP. Rows must be auto — minmax(auto,50%) let a panel
   of wrappable rows take the 50% and overflow it. */
.bs-menu .fore{position:absolute;inset:0;display:grid;
  grid-template-rows:1fr auto auto 1fr;justify-items:center;
  padding:max(16px,env(safe-area-inset-top)) 16px max(16px,env(safe-area-inset-bottom))}
/* Sized against BOTH dimensions — the max-height is load-bearing: width alone gave a
   960x540 window the same 560px logo as 1920x1080. It does NOT change between steps. */
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
