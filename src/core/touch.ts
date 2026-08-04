import type { Input } from './input';
// TYPE-ONLY, so it is erased at build time and adds no import edge: the look
// axes are the pad's shape because they are the same setting, and a touch
// overlay that pulled in the gamepad module to say so would be paying a real
// import for a two-boolean interface.
import type { LookAxes } from './gamepad';
import { t, type StringKey } from '../i18n';

/**
 * Touch controls: a left analog stick for movement, a right look pad, and the
 * action buttons (attack, jump, interact, four skills, beast swap) fanned around
 * the two sticks.
 *
 * LAYOUT — why the buttons are on arcs and not in rows.
 *
 * The first version stacked two centred rows (`ATK JUMP USE SWAP` over `1 2 3
 * 4`) above the sticks. Measured on an emulated Pixel 5 that put a 273x62 slab
 * of buttons at y=241 in landscape — 45 px BELOW the reticle at y=196 — so the
 * one part of the frame the player is actually aiming at was covered by the
 * controls. Portrait was the same shape lower down: the rows sat across the
 * hero and the following beasts.
 *
 * Now every button sits on an arc centred on a stick, in the quarter each thumb
 * sweeps without regripping:
 *
 *   RIGHT fan, around the look stick (68deg .. 202deg, measured
 *   counter-clockwise from screen-right so 90deg is straight up):
 *     ATK 68, skills 1-4 at 97/123/149/175, JUMP 202.
 *   LEFT fan, around the move stick: USE 55, SWAP 105.
 *
 * The split is by FREQUENCY, not by category. Attack and the four skills are
 * what the right thumb reaches for in a fight and they get the good arc; jump
 * takes the other end of it. Use and swap are occasional, so they go to a small
 * mirror arc at the move stick — the right arc physically cannot hold eight
 * buttons (see the radius comment below), and these two are the ones that lose
 * least by being a thumb away.
 *
 * The overlay is only created on devices that actually have a touch screen; on
 * mouse/keyboard machines `TouchControls.attach` returns null and nothing is
 * added to the DOM, so there is no overlay and no per-frame cost.
 */

/**
 * True only when touch is the device's PRIMARY pointer.
 *
 * Note `'ontouchstart' in window` is useless for this: desktop Chrome exposes
 * touch events regardless of hardware, so testing it puts a joystick overlay on
 * every desktop. Touch points plus a coarse primary pointer is the reliable
 * signal. Hybrid machines (touchscreen laptop with a mouse) report a *fine*
 * primary pointer and are handled by lazy activation instead — see `attach`.
 */
export function isTouchPrimary(): boolean {
  if (typeof window === 'undefined') return false;
  const points = navigator.maxTouchPoints ?? 0;
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  return points > 0 && coarse;
}

/** True when the hardware can produce touches at all (may also have a mouse). */
export function hasTouchCapability(): boolean {
  return (navigator.maxTouchPoints ?? 0) > 0;
}

const CSS = `
/* The overlay always covers the game viewport — it is fixed to the viewport and
   sized from --bs-vw/--bs-vh so it lies ON TOP of the canvas in both
   orientations rather than ever being laid out beside it.

   THOSE TWO ARE MEASURED, and this overlay is why (see src/core/viewport.ts).
   It used to be sized in dvw/dvh, and on a Samsung S22 entering fullscreen the
   browser resolved 100dvh to 941.6 CSS px on an 832 CSS px display — issue #16,
   in which the twin sticks and JUMP are 110 px below the bottom edge of the
   screen and the rest of the fan is halfway there. Everything a thumb has to
   reach hangs off the BOTTOM of this box, so it is the layer with the least
   tolerance for a viewport that is a little too tall. dvw/dvh remain as the
   fallback for the frames before the measurement lands.

   EVERY size below is a fraction of --vm, the SHORT screen edge — the width in
   portrait and the height in landscape — so one phone gets one set of
   physically identical controls in both orientations and the fan geometry only
   has to be solved once. The old sheet needed a max-aspect-ratio block and a
   max-height:460px block to undo vw sizing when the phone was turned sideways
   (12vw is 47px portrait but 102px landscape on a Pixel 5); both are gone.

   --vm is min(--bs-vw, --bs-vh), i.e. measured, and falls back to the vmin
   unit it used to be written in. That is the same argument as the box above one
   step in: in LANDSCAPE the short edge is the height, so a browser that
   mis-resolves viewport height mis-sizes every button and radius here too, and
   a fan drawn for a taller screen than there is reaches past the corner it is
   anchored to. Nothing in this stylesheet asks the browser for a viewport
   length any more. */
.bs-touch{position:fixed;left:0;top:0;
  width:100vw;width:100dvw;width:var(--bs-vw,100dvw);
  height:100vh;height:100dvh;height:var(--bs-vh,100dvh);
  z-index:30;pointer-events:none;touch-action:none;overflow:hidden;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  -webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent;

  /* The short screen edge, measured, as ONE length every size below scales off. */
  --vm:var(--bs-vmin,100vmin);
  /* Stick inset from the screen edge, stick diameter, ordinary button, the
     bigger attack button. */
  --m:clamp(20px,calc(var(--vm) * .05),36px);
  --s:min(calc(var(--vm) * .30),124px);
  /* A BUTTON IS AS WIDE AS THE WORD ON IT, which is what the 16px floor
     (issue #17) changed here. These labels were 9–12px; the widest of them,
     JUMP, is about 40px at 16px bold with the tracking taken out, so a 40px
     circle could not hold its own caption. The diameters below are that
     measurement plus a margin, not a taste. */
  --b:clamp(50px,calc(var(--vm) * .128),62px);
  --atk:clamp(58px,calc(var(--vm) * .15),72px);
  /* Fan radii, stick centre to button centre.
     --r is NOT the smallest radius that clears the stick (that would be
     s/2 + b/2 + gap = 88px on a Pixel 5). It is set by PACKING: six buttons
     have to fit on the arc between the screen's right edge and its bottom edge,
     and the angular width of a button shrinks as the radius grows. Eight
     buttons do not fit at ANY radius, which is why USE and SWAP live on the
     left fan.

     RE-DERIVED for the bigger buttons above; the ANGLES did not move, only the
     radius they need. Two circles a degrees apart at radius r are separated by
     a chord of 2r*sin(a/2), and that has to cover the mean of their diameters.
     Measured on a Pixel 5 (--vm 393, so b 50.3, atk 59, r 125.8):

       ATK -> skill 1   29deg   chord 63.0   needs 54.7   gap 8.3px
       skill -> skill   26deg   chord 56.6   needs 50.3   gap 6.3px
       skill 4 -> JUMP  27deg   chord 58.7   needs 50.3   gap 8.4px

     and the whole span, 68deg to 202deg, is 134deg inside the 140deg the two
     screen edges leave. At the old 118px radius the same buttons overlap by
     about 4px between every adjacent pair. Below ~120px they overlap; the
     ceiling is the LOOK PAD reaching across the frame, and in landscape the
     highest button (skill 2, at 123deg) now tops out 12px above the reticle
     rather than 7 — the one thing this change costs.
     The inner edge of the fan clears the stick by 42px, up from 38, which is
     the gap a thumb drags through to look around. */
  --r:clamp(124px,calc(var(--vm) * .32),150px);
  --lr:clamp(96px,calc(var(--vm) * .26),124px);
  /* Notch/rounded-corner aware edges, resolved once so the fan origins and the
     stick homes cannot drift apart. */
  --ml:max(var(--m),env(safe-area-inset-left));
  --mr:max(var(--m),env(safe-area-inset-right));
  --mb:max(var(--m),env(safe-area-inset-bottom))}
.bs-touch.hidden{display:none}

/* The LOOK PAD is the drag surface, not the ring. It covers the whole
   bottom-right cluster — stick, fan and the gaps between the fan buttons — so a
   thumb that comes down anywhere in that corner steers the camera instead of
   landing on dead pixels. The buttons are SIBLINGS of the pad, not children, so
   a press cannot bubble into it and swing the camera at the same time; they are
   also later in the DOM, so they hit-test above it.
   Sized to reach the far edge of the fan: corner inset + half a stick + the fan
   radius + half a button + a little slack. */
.bs-look{position:absolute;right:0;bottom:0;pointer-events:auto;touch-action:none;
  width:calc(var(--mr) + var(--s)/2 + var(--r) + var(--atk)/2 + 10px);
  height:calc(var(--mb) + var(--s)/2 + var(--r) + var(--atk)/2 + 10px)}

/* Twin sticks, one per bottom corner: left = movement, right = camera. */
.bs-stick{position:absolute;bottom:var(--mb);
  width:var(--s);aspect-ratio:1;pointer-events:auto;border-radius:50%;
  background:radial-gradient(circle,rgba(255,255,255,.09),rgba(255,255,255,.03) 70%);
  border:1px solid rgba(255,255,255,.16);transition:opacity .2s ease;opacity:.5}
.bs-stick.move{left:var(--ml)}
/* The look ring is a READOUT: the pad above owns the touch, and the ring jumps
   to wherever the thumb landed. pointer-events:none keeps it from stealing the
   pad's own drags at its edges. */
.bs-stick.look{right:var(--mr);pointer-events:none}
.bs-stick.active{opacity:1}
.bs-stick .knob{position:absolute;left:50%;top:50%;width:38%;aspect-ratio:1;margin:0;
  transform:translate(-50%,-50%);border-radius:50%;
  background:radial-gradient(circle at 36% 30%,rgba(255,255,255,.9),rgba(210,228,245,.55) 60%,rgba(150,180,210,.4));
  box-shadow:0 4px 14px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.6)}
/* tiny glyph so the two sticks are distinguishable at a glance */
.bs-stick .tag{position:absolute;left:50%;bottom:7%;transform:translateX(-50%);
  font-size:16px;font-weight:800;letter-spacing:.06em;color:rgba(255,255,255,.55)}

/* Fan containers are ZERO-SIZED points parked on a stick's centre; each button
   is placed by polar coordinates off that point. rotate(-a)/translateX(r)/
   rotate(a) lands the box at (r cos a, -r sin a) and leaves the label upright,
   so an angle is the only thing a slot has to declare. Nothing here is touched
   per frame — the transforms are static CSS. */
.bs-btns,.bs-skills{position:absolute;width:0;height:0;pointer-events:none;
  --rad:var(--r);
  right:calc(var(--mr) + var(--s)/2);bottom:calc(var(--mb) + var(--s)/2)}
/* The mirror fan on the move stick. */
.bs-btns.near{right:auto;left:calc(var(--ml) + var(--s)/2);--rad:var(--lr)}

/* letter-spacing 0, where it was .04em: inside a circle every point of tracking
   comes off the margin at both ends, and JUMP at the 16px floor has none to
   spare. See the diameter note at --b. */
.bs-btn,.bs-skill{position:absolute;left:0;top:0;pointer-events:auto;
  display:grid;place-items:center;border-radius:50%;aspect-ratio:1;
  color:#eef2f8;letter-spacing:0;
  backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
  transform:translate(-50%,-50%) rotate(calc(-1 * var(--a)))
    translateX(var(--rad)) rotate(var(--a));
  transition:filter .08s ease}
.bs-btn{width:var(--b);font-weight:800;font-size:clamp(16px,calc(var(--vm) * .036),19px);
  background:linear-gradient(165deg,rgba(34,44,62,.82),rgba(16,20,30,.88));
  border:1px solid rgba(255,255,255,.18);
  box-shadow:0 6px 18px rgba(0,0,0,.42),inset 0 1px 0 rgba(255,255,255,.1)}
.bs-btn.attack{width:var(--atk);
  background:linear-gradient(165deg,rgba(214,86,52,.9),rgba(150,48,26,.92));
  box-shadow:0 6px 20px rgba(0,0,0,.45),0 0 18px -6px rgba(255,140,90,.7),
    inset 0 1px 0 rgba(255,255,255,.14)}
.bs-btn.swap{background:linear-gradient(165deg,rgba(52,96,150,.85),rgba(24,52,92,.9))}
/* Pressed state is filter/brightness only: the placement transform carries the
   polar position, so a scale() here would fling the button back to the origin. */
.bs-btn:active,.bs-btn.on{filter:brightness(1.55)}

/* MENU, and the only control on this overlay that is not in a thumb fan.
   Everything else here is placed for a thumb resting on a stick during play;
   this one has to be reachable and NOT reachable by accident, because what it
   does is stop the game. So it goes in the top-left corner, which is the one
   region of the screen the HUD leaves empty (the compass strip is top-centre,
   the currency pill top-right) and the one no thumb passes through mid-fight.

   Sized off --vm like everything else, so a phone gets the same physical button
   in both orientations, and inset by --m plus the safe area so it clears a
   notch. It is smaller than an action button on purpose: a control you press
   once a session does not need the target area of one you press in a fight. */
.bs-pausebtn{position:absolute;
  left:calc(var(--m) + env(safe-area-inset-left));
  top:calc(var(--m) * .6 + env(safe-area-inset-top));
  width:auto;height:auto;padding:calc(var(--vm) * .018) calc(var(--vm) * .034);
  border-radius:999px;pointer-events:auto;
  font-family:inherit;font-weight:800;letter-spacing:.04em;color:#eef2f8;
  font-size:clamp(16px,calc(var(--vm) * .034),18px);
  background:linear-gradient(165deg,rgba(34,44,62,.82),rgba(16,20,30,.88));
  border:1px solid rgba(255,255,255,.18);
  box-shadow:0 6px 18px rgba(0,0,0,.42),inset 0 1px 0 rgba(255,255,255,.1)}
.bs-pausebtn:active,.bs-pausebtn.on{filter:brightness(1.55)}

/* Skills read as one group inside the fan — same circle, cooler fill and a
   cyan hairline, so the four numbered slots are visibly a set and not four more
   verbs. */
.bs-skill{width:var(--b);font-weight:900;font-size:clamp(18px,calc(var(--vm) * .045),22px);
  background:linear-gradient(165deg,rgba(28,42,62,.84),rgba(12,18,30,.88));
  border:1px solid rgba(150,220,255,.3);
  box-shadow:0 5px 14px rgba(0,0,0,.38),inset 0 1px 0 rgba(255,255,255,.09)}
.bs-skill:active{filter:brightness(1.55)}
`;

interface StickState {
  id: number;
  cx: number;
  cy: number;
  radius: number;
}

/** One joystick widget: its DOM, its active touch and its normalized output. */
class Stick {
  readonly el: HTMLDivElement;
  private knob: HTMLDivElement;
  private active: StickState | null = null;
  /** -1..1, +y is screen-up */
  x = 0;
  y = 0;

  /**
   * `pad`, when given, makes this a FLOATING stick: the pad is what listens for
   * the touch and the ring is only a readout that jumps to wherever the thumb
   * came down. That is what lets a drag started in a gap between fan buttons
   * still steer the camera. Without a pad the stick behaves exactly as before —
   * fixed ring, touches must land on it.
   */
  constructor(kind: 'move' | 'look', tag: string, onChange: () => void, pad?: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = `bs-stick ${kind}`;
    this.knob = document.createElement('div');
    this.knob.className = 'knob';
    this.el.appendChild(this.knob);
    const label = document.createElement('div');
    label.className = 'tag';
    label.textContent = tag;
    this.el.appendChild(label);

    const host = pad ?? this.el;
    host.addEventListener('touchstart', (e) => {
      if (this.active) return;
      const t = e.changedTouches[0];
      // Home the ring before measuring: a previous drag may have left it parked
      // elsewhere, and the deflection radius is derived from its rect.
      this.el.style.transform = '';
      const r = this.el.getBoundingClientRect();
      let cx = r.left + r.width / 2;
      let cy = r.top + r.height / 2;
      if (pad) {
        // Origin is the finger, clamped so the ring stays inside the pad.
        const h = pad.getBoundingClientRect();
        const half = r.width / 2;
        cx = Math.min(Math.max(t.clientX, h.left + half), h.right - half);
        cy = Math.min(Math.max(t.clientY, h.top + half), h.bottom - half);
        this.el.style.transform =
          `translate(${(cx - (r.left + half)).toFixed(1)}px,${(cy - (r.top + half)).toFixed(1)}px)`;
      }
      this.active = { id: t.identifier, cx, cy, radius: r.width * 0.42 };
      this.el.classList.add('active');
      this.move(t.clientX, t.clientY);
      onChange();
      e.preventDefault();
      e.stopPropagation();
    }, { passive: false });
  }

  owns(id: number): boolean {
    return this.active !== null && this.active.id === id;
  }

  get engaged(): boolean {
    return this.active !== null;
  }

  move(px: number, py: number): void {
    if (!this.active) return;
    const dx = px - this.active.cx;
    const dy = py - this.active.cy;
    const len = Math.hypot(dx, dy) || 1;
    const clamped = Math.min(len, this.active.radius);
    this.x = (dx / len) * (clamped / this.active.radius);
    this.y = -(dy / len) * (clamped / this.active.radius); // screen-down is -y
    const kx = (dx / len) * clamped;
    const ky = (dy / len) * clamped;
    this.knob.style.transform = `translate(calc(-50% + ${kx}px), calc(-50% + ${ky}px))`;
  }

  release(): void {
    this.active = null;
    this.x = 0;
    this.y = 0;
    this.el.classList.remove('active');
    this.knob.style.transform = 'translate(-50%,-50%)';
    this.el.style.transform = ''; // floating ring snaps back to its home corner
  }
}

export class TouchControls {
  private root: HTMLDivElement;
  private moveStick: Stick;
  private lookStick: Stick;
  /**
   * Camera rotation rate at full stick deflection, in radians/second, converted
   * to the mouse-pixel units the camera consumes (0.0028 rad per px of yaw).
   */
  private static readonly LOOK_PX_PER_SEC = 620;
  /**
   * Which way each look axis runs. +1 straight through, -1 inverted, and the
   * sign is applied to a DOWN-POSITIVE raw axis exactly as `GamepadControls`
   * applies it to `axes[3]` — which is why `update` negates the stick's own
   * screen-up-positive `y` first. Defaults match DEFAULT_PREFS.
   */
  private lookSignX = 1;
  private lookSignY = -1;
  private revealed = false;

  /**
   * Returns a controller on any touch-capable device, or null on pure
   * mouse hardware (where nothing is created and no listeners are registered).
   *
   * On touch-PRIMARY devices the overlay is shown immediately. On hybrid
   * machines (touchscreen laptop with a mouse) the instance exists but stays
   * hidden until the first real touch, so a desktop never sprouts a joystick
   * unless the user actually touches the screen.
   *
   * The instance is returned in BOTH cases on purpose: the right stick is a
   * rate control that needs a per-frame update() from the caller, so returning
   * null for the deferred case silently disabled camera rotation.
   */
  static attach(input: Input, onSkill?: (index: number) => void): TouchControls | null {
    if (!hasTouchCapability() && !isTouchPrimary()) return null;
    return new TouchControls(input, onSkill, !isTouchPrimary());
  }

  private constructor(
    private input: Input,
    onSkill?: (index: number) => void,
    deferred = false,
  ) {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    this.root = document.createElement('div');
    this.root.className = 'bs-touch';

    // -- twin sticks: movement bottom-left, camera bottom-right --------------
    // The look pad goes in FIRST so every button added below hit-tests above it.
    const lookPad = document.createElement('div');
    lookPad.className = 'bs-look';
    this.root.appendChild(lookPad);

    this.moveStick = new Stick('move', t('touch.move'), () => {
      this.input.setStick(this.moveStick.x, this.moveStick.y);
    });
    this.lookStick = new Stick('look', t('touch.look'), () => {
      this.input.setTouchLooking(true);
    }, lookPad);
    this.root.appendChild(this.moveStick.el);
    lookPad.appendChild(this.lookStick.el);

    /** Places one fan item at `angle` degrees off its container's stick centre. */
    const place = (el: HTMLElement, angle: number): void => {
      el.style.setProperty('--a', `${angle}deg`);
    };

    // -- skills: the middle of the right fan ---------------------------------
    // Highest-frequency right-thumb verbs after ATK, so they get the arc rather
    // than the centred row they used to be.
    const skills = document.createElement('div');
    skills.className = 'bs-skills';
    const SKILL_ANGLES = [97, 123, 149, 175];
    for (let i = 0; i < 4; i++) {
      const b = document.createElement('button');
      b.className = 'bs-skill';
      b.textContent = String(i + 1);
      place(b, SKILL_ANGLES[i]);
      b.addEventListener('touchstart', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.input.tapVirtual(`Digit${i + 1}`);
        onSkill?.(i);
      }, { passive: false });
      skills.appendChild(b);
    }
    this.root.appendChild(skills);

    // -- action buttons ------------------------------------------------------
    const btns = document.createElement('div');
    btns.className = 'bs-btns';
    // Mirror fan on the move stick for the two occasional verbs.
    const nearBtns = document.createElement('div');
    nearBtns.className = 'bs-btns near';
    const mkButton = (
      into: HTMLDivElement, angle: number, cls: string, label: string,
      onDown: () => void, onUp?: () => void,
    ): void => {
      const b = document.createElement('button');
      b.className = `bs-btn ${cls}`;
      b.textContent = label;
      place(b, angle);
      b.addEventListener('touchstart', (e) => {
        e.preventDefault();
        e.stopPropagation();
        b.classList.add('on');
        onDown();
      }, { passive: false });
      const release = (): void => { b.classList.remove('on'); onUp?.(); };
      b.addEventListener('touchend', release);
      b.addEventListener('touchcancel', release);
      into.appendChild(b);
    };

    // Both ends of the right fan are the shortest reach from where the thumb
    // pivots; the middle is ~30px further. So the two buttons held during play
    // take the ends and the skills sit between them.
    // The CSS class is the identifier ('attack'), the cap is display: the
    // stylesheet and the touch tool key on the former, never on the word.
    mkButton(btns, 68, 'attack', t('touch.attack'),
      () => this.input.setVirtualAttack(true),
      () => this.input.setVirtualAttack(false));
    mkButton(btns, 202, 'jump', t('touch.jump'),
      () => this.input.setVirtualButton('Space', true),
      () => this.input.setVirtualButton('Space', false));
    mkButton(nearBtns, 55, 'interact', t('touch.interact'), () => this.input.tapVirtual('KeyE'));
    mkButton(nearBtns, 105, 'swap', t('touch.swap'), () => this.input.tapVirtual('Tab'));
    this.root.appendChild(btns);
    this.root.appendChild(nearBtns);

    // MENU. A phone has no Escape key and no Start button, so this is the whole
    // of "every device can open the in-game menu" — and it opens it the same way
    // both of those do, by tapping the virtual Escape main.ts already routes.
    // Nothing here knows the menu exists, which is what keeps one key edge as
    // the single entry point rather than three.
    const menuBtn = document.createElement('button');
    menuBtn.className = 'bs-pausebtn';
    menuBtn.textContent = t('touch.menu');
    menuBtn.addEventListener('touchstart', (e) => {
      e.preventDefault();
      e.stopPropagation();
      menuBtn.classList.add('on');
      this.input.tapVirtual('Escape');
    }, { passive: false });
    const menuUp = (): void => menuBtn.classList.remove('on');
    menuBtn.addEventListener('touchend', menuUp);
    menuBtn.addEventListener('touchcancel', menuUp);
    this.root.appendChild(menuBtn);

    // Deferred (hybrid mouse+touch) devices keep the overlay hidden until the
    // user actually touches the screen; the instance still ticks, so nothing
    // depends on the DOM being attached.
    this.revealed = !deferred;
    if (deferred) this.root.classList.add('hidden');
    document.body.appendChild(this.root);

    // Global move/end handling so a finger that slides off its stick keeps working.
    window.addEventListener('touchmove', (e) => {
      for (const t of Array.from(e.changedTouches)) {
        if (this.moveStick.owns(t.identifier)) {
          this.moveStick.move(t.clientX, t.clientY);
          this.input.setStick(this.moveStick.x, this.moveStick.y);
          e.preventDefault();
        } else if (this.lookStick.owns(t.identifier)) {
          this.lookStick.move(t.clientX, t.clientY);
          e.preventDefault();
        }
      }
    }, { passive: false });

    const endTouch = (e: TouchEvent): void => {
      for (const t of Array.from(e.changedTouches)) {
        if (this.moveStick.owns(t.identifier)) {
          this.moveStick.release();
          this.input.setStick(0, 0);
        } else if (this.lookStick.owns(t.identifier)) {
          this.lookStick.release();
          this.input.setTouchLooking(false);
        }
      }
    };
    window.addEventListener('touchend', endTouch);
    window.addEventListener('touchcancel', endTouch);

    // First real touch anywhere marks the session as touch-driven (which also
    // stops the mouse handler from grabbing pointer lock) and reveals the
    // overlay on hybrid devices.
    window.addEventListener('touchstart', () => {
      this.input.touchActive = true;
      this.revealed = true;
      this.root.classList.remove('hidden');
    }, { passive: true });

    // Which device is LIVE, stamped per gesture — a finger takes the labels and
    // the vibration back from the keyboard the same way the keyboard takes them
    // back from a pad (see `InputSource`).
    //
    // CAPTURE PHASE, and that is the whole reason this is a second listener
    // rather than a line inside the one above. Every stick and button in this
    // overlay calls `stopPropagation()` on touchstart, so the bubble listener
    // above only ever sees touches that land on the CANVAS. A phone player
    // driving with the sticks and never poking the scenery would have stayed
    // 'kbm' forever, and the rumble gate would have read that as "not holding
    // anything" and silenced their phone. Capture runs before the target's own
    // handlers, so nothing downstream can suppress it.
    window.addEventListener(
      'touchstart',
      () => this.input.noteSource('touch'),
      { passive: true, capture: true },
    );
  }

  /**
   * Call once per frame. The right stick is a RATE control — held deflection
   * turns the camera continuously — so it must feed the look delta every frame
   * rather than only on touchmove like a drag would.
   */
  update(dt: number): void {
    if (!this.lookStick.engaged) return;
    const k = TouchControls.LOOK_PX_PER_SEC * Math.min(dt, 0.05);
    // Camera treats +mouseDY as looking down, matching a mouse, and the stick's
    // own y is screen-up-positive — so the negation turns it into the
    // down-positive axis `lookSignY` is defined against. Uninverted (sign +1)
    // that is the old behaviour exactly: push up, look up.
    this.input.addLook(
      this.lookStick.x * this.lookSignX * k,
      -this.lookStick.y * this.lookSignY * k,
    );
    this.input.setTouchLooking(true);
  }

  /**
   * Flip either look axis, at any time. Same shape and same live-change contract
   * as `GamepadControls.setLookAxes`, because it is the same player choice: a
   * thumb on a virtual stick is a STICK, and the one thing the setting is
   * documented never to reach is the mouse (see core/prefs.ts).
   */
  setLookAxes(a: Partial<LookAxes>): void {
    if (a.invertX !== undefined) this.lookSignX = a.invertX ? -1 : 1;
    if (a.invertY !== undefined) this.lookSignY = a.invertY ? -1 : 1;
  }

  get lookAxes(): LookAxes {
    return { invertX: this.lookSignX < 0, invertY: this.lookSignY < 0 };
  }

  /** True once a real touch has been seen (always true on touch-primary devices). */
  get isRevealed(): boolean { return this.revealed; }

  /**
   * Hide the overlay (e.g. while a modal shop is open). Never reveals a
   * deferred overlay — a mouse-driven touchscreen laptop must stay clean until
   * the user actually touches the screen, and this is called every frame.
   */
  setVisible(v: boolean): void {
    this.root.classList.toggle('hidden', !v || !this.revealed);
    if (!v) {
      this.moveStick.release();
      this.lookStick.release();
      this.input.setStick(0, 0);
      this.input.setTouchLooking(false);
      this.input.setVirtualAttack(false);
      this.input.setVirtualButton('Space', false);
    }
  }

  /**
   * Re-cap the sticks and buttons after the display language changed. Wire it to
   * `onLanguageChange` (see src/i18n/index.ts); it is never called per frame.
   *
   * The lookup is by CLASS, which is the identifier here — `.bs-btn.attack` is
   * the button whatever its cap reads, and that is exactly the split the
   * constructor already makes when it passes a class and a `t()` cap side by
   * side. Nothing keys on the word, so re-capping cannot break the tool that
   * asserts on these nodes.
   */
  relabel(): void {
    const cap = (sel: string, key: StringKey): void => {
      const el = this.root.querySelector(sel);
      if (el) el.textContent = t(key);
    };
    cap('.bs-stick.move .tag', 'touch.move');
    cap('.bs-stick.look .tag', 'touch.look');
    cap('.bs-btn.attack', 'touch.attack');
    cap('.bs-btn.jump', 'touch.jump');
    cap('.bs-btn.interact', 'touch.interact');
    cap('.bs-btn.swap', 'touch.swap');
    cap('.bs-pausebtn', 'touch.menu');
  }

  dispose(): void {
    this.root.remove();
  }
}
