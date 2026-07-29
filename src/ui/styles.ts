/**
 * All HUD / shop CSS, injected once as a <style> tag.
 * Glassy panels, element-tinted accents, springy transitions.
 */

const CSS = `
.cp-root{position:fixed;inset:0;pointer-events:none;z-index:20;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  color:#eef2f8;user-select:none;-webkit-user-select:none;
  --glass:linear-gradient(165deg,rgba(30,38,54,.72),rgba(14,18,28,.82));
  --stroke:rgba(255,255,255,.14);
}
.cp-root *{box-sizing:border-box;margin:0;padding:0}
.cp-root svg{display:block}
.cp-root kbd{display:inline-block;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.28);
  border-bottom-width:2px;border-radius:5px;padding:0 6px;font:inherit;font-size:.86em;font-weight:700;
  line-height:1.5;vertical-align:baseline}
.cp-glass{background:var(--glass);border:1px solid var(--stroke);border-radius:14px;
  box-shadow:0 8px 24px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.08);
  backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}

/* ---- title chip -------------------------------------------------------- */
.cp-title{position:absolute;top:14px;left:16px;display:flex;align-items:baseline;gap:8px;
  padding:8px 14px 9px;border-radius:12px}
.cp-title b{font-weight:900;font-size:13px;letter-spacing:.18em;
  background:linear-gradient(92deg,#ffd23f 10%,#ff8b4a 55%,#ff6b35 90%);
  -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent}
.cp-title span{font-size:10px;font-weight:600;color:rgba(238,242,248,.5);letter-spacing:.05em}

/* ---- shard counter ----------------------------------------------------- */
.cp-shards{position:absolute;top:14px;right:16px;display:flex;align-items:center;gap:8px;
  padding:8px 14px;border-radius:999px}
.cp-shards .ic{width:18px;height:18px;color:#69d9ff;filter:drop-shadow(0 0 5px rgba(105,217,255,.55))}
.cp-shards .ic svg{width:100%;height:100%}
.cp-shards .num{font-variant-numeric:tabular-nums;font-weight:800;font-size:16px;letter-spacing:.02em;
  color:#dff5ff;text-shadow:0 1px 2px rgba(0,0,0,.5)}
.cp-pop{animation:cpPop .38s cubic-bezier(.34,1.8,.64,1)}
@keyframes cpPop{0%{transform:scale(1)}45%{transform:scale(1.28)}100%{transform:scale(1)}}

/* ---- crosshair --------------------------------------------------------- */
/* Sits just ABOVE the character (who is framed at screen centre), like Cube
   World's aim marker: a chunky 4-pixel cluster rather than a soft dot. Kept
   close to the hero -- pushed far up it just reads as specks of dirt in the
   grass. Each white cell carries a 1px dark ring so it survives light terrain.
   Shadow order matters: white is listed first so it paints over the ring. */
.cp-cross{position:absolute;left:50%;top:50%;width:4px;height:4px;margin:0 0 0 -2px;
  transform:translateY(-34px);background:transparent;
  box-shadow:
    0 -7px 0 0 rgba(255,255,255,.95), 0 7px 0 0 rgba(255,255,255,.95),
    -7px 0 0 0 rgba(255,255,255,.95), 7px 0 0 0 rgba(255,255,255,.95),
    0 -7px 0 1px rgba(0,0,0,.55), 0 7px 0 1px rgba(0,0,0,.55),
    -7px 0 0 1px rgba(0,0,0,.55), 7px 0 0 1px rgba(0,0,0,.55);
  transition:opacity .2s ease}
.cp-root.shop-open .cp-cross{opacity:0}

/* ---- left cluster: one party panel (pals + player hp) ------------------ */
/* Single continuous glass slab. The pal rows and the player HP block are
   sections inside it, not free-floating cards with a gap between them. */
.cp-left{position:absolute;left:16px;bottom:16px;display:flex;flex-direction:column;width:288px;
  padding:7px;border-radius:16px;background:var(--glass);border:1px solid var(--stroke);
  box-shadow:0 10px 28px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.09);
  backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}
.cp-pals{display:flex;flex-direction:column-reverse;gap:2px}

.cp-pal{border-radius:11px;padding:8px 10px;position:relative;background:transparent;border:0;
  transition:background .35s ease,opacity .35s ease,box-shadow .35s ease,filter .35s ease}
.cp-pal.hidden{display:none}
.cp-pal.primary{background:linear-gradient(92deg,rgba(255,255,255,.11),rgba(255,255,255,.02));
  box-shadow:inset 3px 0 0 var(--el),inset 0 0 24px -12px var(--el)}
.cp-pal.support{opacity:.62;filter:saturate(.7)}
.cp-pal.support .badge{width:30px;height:30px}
.cp-pal.support .badge svg{width:17px;height:17px}
.cp-pal.support .nm{font-size:12px}
.cp-pal .cp-pal-in{display:flex;align-items:center;gap:10px}
.cp-pal .cp-pal-in.cp-swap{animation:cpSwap .5s cubic-bezier(.34,1.56,.64,1)}
@keyframes cpSwap{0%{transform:translateY(12px) scale(.9);opacity:.15}
  60%{transform:translateY(-3px) scale(1.04);opacity:1}100%{transform:none;opacity:1}}
.cp-pal .badge{width:38px;height:38px;border-radius:50%;flex:none;display:grid;place-items:center;
  background:radial-gradient(circle at 34% 28%,rgba(255,255,255,.42),rgba(255,255,255,0) 46%),var(--el);
  color:rgba(255,255,255,.96);
  box-shadow:inset 0 -4px 8px rgba(0,0,0,.28),0 2px 8px rgba(0,0,0,.35)}
.cp-pal .badge svg{width:21px;height:21px;filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.4))}
.cp-pal .meta{flex:1;min-width:0}
.cp-pal .row{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:4px}
.cp-pal .nm{font-weight:800;font-size:13.5px;letter-spacing:.02em;white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis;text-shadow:0 1px 2px rgba(0,0,0,.45)}
.cp-pal .lv{font-size:10.5px;font-weight:800;color:var(--el);background:rgba(255,255,255,.09);
  padding:1px 7px;border-radius:999px;flex:none;filter:saturate(1.3) brightness(1.35)}
.cp-micro{height:5px;border-radius:3px;background:rgba(0,0,0,.42);overflow:hidden;
  box-shadow:inset 0 1px 2px rgba(0,0,0,.5)}
.cp-micro+.cp-micro{margin-top:3px}
.cp-micro>i{display:block;height:100%;border-radius:3px;transition:width .3s cubic-bezier(.22,1,.36,1)}
.cp-micro.hp>i{background:linear-gradient(90deg,#4fb548,#7ed465)}
.cp-micro.xp>i{background:linear-gradient(90deg,#f5a623,#ffd23f)}

/* player hp: bottom section of the party panel, hairline divider instead of a gap */
.cp-hp{padding:9px 10px 4px;margin-top:5px;border-top:1px solid rgba(255,255,255,.1)}
.cp-hp .row{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:6px}
.cp-hp .lbl{font-size:10.5px;font-weight:900;letter-spacing:.22em;color:rgba(238,242,248,.72)}
.cp-hp .val{font-size:12.5px;font-weight:800;font-variant-numeric:tabular-nums;
  text-shadow:0 1px 2px rgba(0,0,0,.5)}
.cp-hp .track{position:relative;height:15px;border-radius:9px;background:rgba(0,0,0,.5);overflow:hidden;
  box-shadow:inset 0 2px 5px rgba(0,0,0,.55),inset 0 0 0 1px rgba(255,255,255,.07)}
.cp-hp .ghost{position:absolute;top:0;bottom:0;left:0;border-radius:9px;background:rgba(255,246,238,.85)}
.cp-hp .fill{position:absolute;top:0;bottom:0;left:0;border-radius:9px;transition:width .12s ease;
  filter:saturate(.8)}
.cp-hp .fill::after{content:"";position:absolute;left:0;right:0;top:0;height:46%;
  border-radius:9px 9px 0 0;background:linear-gradient(rgba(255,255,255,.4),rgba(255,255,255,.04))}

/* ---- hotbar ------------------------------------------------------------ */
.cp-hotbar{position:absolute;left:50%;bottom:34px;transform:translateX(-50%);display:flex;gap:11px}
.cp-slot{width:58px;height:58px;border-radius:14px;position:relative;display:grid;place-items:center;
  background:var(--glass);border:1px solid var(--stroke);
  box-shadow:0 6px 16px rgba(0,0,0,.32),inset 0 1px 0 rgba(255,255,255,.08);
  backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
  transition:transform .16s ease,box-shadow .25s ease;pointer-events:auto}
.cp-slot:hover{transform:translateY(-3px)}
.cp-slot.empty{border-style:dashed;border-color:rgba(255,255,255,.12);box-shadow:none;opacity:.55}
.cp-slot.empty .key{top:50%;left:50%;transform:translate(-50%,-50%);font-size:21px;font-weight:800;
  color:rgba(255,255,255,.3);text-shadow:none}
.cp-slot.filled{border-color:transparent;
  box-shadow:inset 0 0 0 1.5px var(--el2),0 6px 16px rgba(0,0,0,.32)}
.cp-slot .key{position:absolute;top:3px;left:7px;font-size:10px;font-weight:800;
  color:rgba(255,255,255,.62);text-shadow:0 1px 2px rgba(0,0,0,.6)}
.cp-slot .ic{width:26px;height:26px;color:var(--el);transition:opacity .2s ease,filter .3s ease;
  filter:saturate(1.25) brightness(1.3) drop-shadow(0 1px 2px rgba(0,0,0,.5))}
.cp-slot .ic svg{width:100%;height:100%}
.cp-slot.ready .ic{animation:cpReadyGlow 2.4s ease-in-out infinite}
@keyframes cpReadyGlow{0%,100%{filter:saturate(1.25) brightness(1.3) drop-shadow(0 0 2px var(--el))}
  50%{filter:saturate(1.4) brightness(1.55) drop-shadow(0 0 8px var(--el))}}
.cp-slot.cooling .ic{opacity:.38;animation:none}
.cp-slot .cd{position:absolute;inset:2px;border-radius:11px;pointer-events:none}
.cp-slot .cdnum{position:absolute;inset:0;display:grid;place-items:center;font-size:15px;font-weight:900;
  font-variant-numeric:tabular-nums;color:#fff;text-shadow:0 1px 4px rgba(0,0,0,.85);pointer-events:none}
.cp-slot .nm{position:absolute;bottom:-19px;left:50%;transform:translateX(-50%);font-size:11px;
  font-weight:700;letter-spacing:.03em;white-space:nowrap;color:#e8e2d8;
  text-shadow:0 1px 3px rgba(0,0,0,.8)}
.cp-slot.cp-flash{animation:cpFlash .55s cubic-bezier(.34,1.56,.64,1)}
@keyframes cpFlash{0%{box-shadow:0 0 0 0 var(--el),inset 0 0 0 1.5px var(--el2);transform:scale(1)}
  40%{box-shadow:0 0 24px 6px var(--el),inset 0 0 14px var(--el2);transform:scale(1.14)}
  100%{box-shadow:inset 0 0 0 1.5px var(--el2),0 6px 16px rgba(0,0,0,.32);transform:scale(1)}}

/* ---- hint pill --------------------------------------------------------- */
.cp-hint{position:absolute;left:50%;bottom:118px;transform:translateX(-50%) translateY(8px);
  padding:8px 18px;border-radius:999px;font-size:13.5px;font-weight:700;letter-spacing:.02em;
  opacity:0;transition:opacity .28s ease,transform .28s cubic-bezier(.34,1.56,.64,1);white-space:nowrap}
.cp-hint.show{opacity:1;transform:translateX(-50%) translateY(0)}

/* ---- level-up banner --------------------------------------------------- */
.cp-banner{position:absolute;top:58px;left:50%;transform:translateX(-50%) translateY(-26px) scale(.94);
  opacity:0;padding:11px 30px 13px;border-radius:16px;text-align:center;
  transition:transform .45s cubic-bezier(.34,1.56,.64,1),opacity .35s ease}
.cp-banner.show{transform:translateX(-50%) translateY(0) scale(1);opacity:1}
.cp-banner .eyebrow{font-size:10px;font-weight:900;letter-spacing:.34em;color:#ffd23f;
  text-shadow:0 0 10px rgba(255,210,63,.6);margin-bottom:2px}
.cp-banner .txt{font-size:16px;font-weight:800;text-shadow:0 1px 3px rgba(0,0,0,.5)}
.cp-banner .txt em{font-style:normal;color:var(--el,#ffd23f);filter:saturate(1.3) brightness(1.35)}

/* ---- toasts ------------------------------------------------------------ */
.cp-toasts{position:absolute;top:96px;left:50%;transform:translateX(-50%);display:flex;
  flex-direction:column;gap:8px;align-items:center}
/* Same glass slab + accent-bar treatment as the party panel, so a toast never
   reads as an unstyled browser box dropped on top of a custom UI. */
.cp-toast{padding:9px 15px 10px;border-radius:12px;font-size:12.5px;font-weight:700;letter-spacing:.01em;
  max-width:340px;text-align:left;color:#eef2f8;text-shadow:0 1px 2px rgba(0,0,0,.5);
  background:var(--glass);border:1px solid var(--stroke);
  box-shadow:0 10px 26px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.09),inset 3px 0 0 #ffd23f;
  backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
  opacity:0;transform:translateY(-12px);
  transition:opacity .3s ease,transform .35s cubic-bezier(.34,1.56,.64,1)}
.cp-toast.show{opacity:1;transform:translateY(0)}
.cp-toast.hide{opacity:0;transform:translateY(-8px)}

/* ---- shop -------------------------------------------------------------- */
.cp-shopwrap{position:absolute;inset:0;display:grid;place-items:center;pointer-events:none}
.cp-scrim{position:absolute;inset:0;background:rgba(5,9,17,.58);opacity:0;transition:opacity .28s ease;
  backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px)}
.cp-shop{position:relative;width:min(880px,92vw);max-height:84vh;display:flex;flex-direction:column;
  border-radius:20px;opacity:0;transform:translateY(16px) scale(.96);
  transition:opacity .3s ease,transform .34s cubic-bezier(.34,1.45,.64,1);
  box-shadow:0 24px 64px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.1)}
.cp-shopwrap.open{pointer-events:auto}
.cp-shopwrap.open .cp-scrim{opacity:1}
.cp-shopwrap.open .cp-shop{opacity:1;transform:translateY(0) scale(1)}
.cp-shop-head{display:flex;align-items:center;gap:14px;padding:16px 20px 14px;
  border-bottom:1px solid rgba(255,255,255,.1)}
.cp-shop-head h2{font-size:19px;font-weight:900;letter-spacing:.04em;flex:1;
  text-shadow:0 1px 3px rgba(0,0,0,.5)}
.cp-shop-head .bal{display:flex;align-items:center;gap:7px;padding:6px 13px;border-radius:999px;
  background:rgba(105,217,255,.1);border:1px solid rgba(105,217,255,.28)}
.cp-shop-head .bal .ic{width:15px;height:15px;color:#69d9ff}
.cp-shop-head .bal .ic svg{width:100%;height:100%}
.cp-shop-head .bal b{font-size:14px;font-weight:800;font-variant-numeric:tabular-nums;color:#dff5ff}
.cp-shop-x{width:34px;height:34px;border-radius:10px;border:1px solid rgba(255,255,255,.16);
  background:rgba(255,255,255,.07);color:rgba(238,242,248,.8);display:grid;place-items:center;
  cursor:pointer;transition:background .15s,transform .15s;pointer-events:auto}
.cp-shop-x:hover{background:rgba(255,90,80,.28);transform:scale(1.06);color:#fff}
.cp-shop-x svg{width:15px;height:15px}
.cp-offers{display:grid;grid-template-columns:repeat(auto-fill,minmax(244px,1fr));gap:12px;
  padding:16px 20px;overflow-y:auto;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.25) transparent}
.cp-offer{position:relative;border-radius:14px;padding:15px 14px 13px;overflow:hidden;
  background:rgba(255,255,255,.055);border:1px solid rgba(255,255,255,.1);
  transition:transform .16s ease,box-shadow .22s ease,border-color .22s ease}
.cp-offer:hover{transform:translateY(-2px);border-color:var(--el2);
  box-shadow:0 8px 22px rgba(0,0,0,.35),0 0 16px -6px var(--el)}
.cp-offer.locked{opacity:.55;filter:saturate(.6)}
.cp-offer.locked:hover{transform:none;box-shadow:none;border-color:rgba(255,255,255,.1)}
.cp-offer .accent{position:absolute;top:0;left:0;right:0;height:4px}
.cp-offer .top{display:flex;align-items:center;gap:9px;margin-bottom:6px}
.cp-offer .oic{width:30px;height:30px;border-radius:9px;flex:none;display:grid;place-items:center;
  background:var(--el2);color:var(--el);filter:saturate(1.2) brightness(1.25)}
.cp-offer .oic svg{width:17px;height:17px}
.cp-offer h3{font-size:14px;font-weight:800;letter-spacing:.01em}
.cp-offer .pal{font-size:10.5px;font-weight:600;color:rgba(238,242,248,.55);margin-top:1px}
.cp-offer p{font-size:11.5px;line-height:1.45;color:rgba(238,242,248,.78);min-height:32px;margin-bottom:8px}
.cp-chips{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:10px}
.cp-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 8px 3px;border-radius:999px;
  background:rgba(255,255,255,.09);font-size:10.5px;font-weight:700;color:rgba(238,242,248,.85)}
.cp-chip b{color:#fff}
.cp-offer .foot{display:flex;align-items:center;gap:10px}
.cp-price{display:flex;align-items:center;gap:5px;font-weight:800;font-size:14px;
  font-variant-numeric:tabular-nums;color:#dff5ff}
.cp-price .ic{width:14px;height:14px;color:#69d9ff}
.cp-price .ic svg{width:100%;height:100%}
.cp-price.no{color:#ff8d84}
.cp-price.no .ic{color:#ff8d84}
.cp-buy{flex:1;padding:8px 0 9px;border-radius:10px;border:none;font-family:inherit;font-weight:800;
  font-size:12.5px;letter-spacing:.05em;cursor:pointer;color:#3a2703;
  background:linear-gradient(180deg,#ffd94f,#f5a623);
  box-shadow:0 3px 8px rgba(0,0,0,.3),inset 0 1px 0 rgba(255,255,255,.45);
  transition:transform .12s ease,filter .15s ease;pointer-events:auto}
.cp-buy:hover{filter:brightness(1.1);transform:translateY(-1px)}
.cp-buy:active{transform:translateY(1px) scale(.98)}
.cp-buy:disabled{cursor:default;background:rgba(255,255,255,.1);color:rgba(238,242,248,.4);
  box-shadow:none;transform:none;filter:none}
.cp-buy.owned{background:rgba(109,191,75,.18);color:#8fe06b;border:1px solid rgba(109,191,75,.4);
  display:flex;align-items:center;justify-content:center;gap:6px;cursor:default;box-shadow:none}
.cp-buy.owned svg{width:13px;height:13px}
.cp-shop-foot{border-top:1px solid rgba(255,255,255,.1);padding:11px 20px;display:flex;gap:16px;
  flex-wrap:wrap;justify-content:center;font-size:11.5px;font-weight:600;color:rgba(238,242,248,.7)}
.cp-shop-foot span{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
`;

/** Inject the HUD stylesheet once. Safe to call repeatedly. */
export function injectStyles(): void {
  if (document.getElementById('cp-hud-styles')) return;
  const style = document.createElement('style');
  style.id = 'cp-hud-styles';
  style.textContent = CSS;
  document.head.appendChild(style);
}
