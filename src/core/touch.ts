import type { Input } from './input';
// Type-only, so no import edge: the look axes are one setting shared with the pad.
import type { LookAxes } from './gamepad';
import { t, type StringKey } from '../i18n';

/**
 * Touch controls. Buttons sit on arcs centred on each stick; angles run counter-clockwise
 * from screen-right, so 90deg is up. Frequent verbs take the right fan, occasional the left.
 * Nothing is created on mouse/keyboard machines.
 */

/**
 * Touch is the PRIMARY pointer. `'ontouchstart' in window` is useless — desktop Chrome
 * exposes touch events regardless of hardware. Hybrids activate lazily in `attach`.
 */
export function isTouchPrimary(): boolean {
  if (typeof window === 'undefined') return false;
  const points = navigator.maxTouchPoints ?? 0;
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  return points > 0 && coarse;
}

export function hasTouchCapability(): boolean {
  return (navigator.maxTouchPoints ?? 0) > 0;
}

const CSS = `
/* Sized from the MEASURED --bs-vw/--bs-vh, never dvw/dvh: a mis-resolved dvh put the
   sticks below the screen edge (issue #16), and everything a thumb reaches hangs off the
   bottom of this box. Every size below is a fraction of --vm, the short screen edge, so
   one phone gets identical controls in both orientations. */
.bs-touch{position:fixed;left:0;top:0;
  width:100vw;width:100dvw;width:var(--bs-vw,100dvw);
  height:100vh;height:100dvh;height:var(--bs-vh,100dvh);
  z-index:30;pointer-events:none;touch-action:none;overflow:hidden;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  -webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent;

  /* The short screen edge, measured: the one length every size below scales off. */
  --vm:var(--bs-vmin,100vmin);
  --m:clamp(20px,calc(var(--vm) * .05),36px);
  --s:min(calc(var(--vm) * .30),124px);
  /* Button diameters are the widest caption at the 16px floor (issue #17) plus margin. */
  --b:clamp(50px,calc(var(--vm) * .128),62px);
  --atk:clamp(58px,calc(var(--vm) * .15),72px);
  /* Fan radii, stick centre to button centre. --r is set by PACKING, not by clearing the
     stick: six buttons must fit the 140deg the screen edges leave, and below ~120px
     adjacent buttons overlap. Eight do not fit at any radius, hence the left fan. */
  --r:clamp(124px,calc(var(--vm) * .32),150px);
  --lr:clamp(96px,calc(var(--vm) * .26),124px);
  --ml:max(var(--m),env(safe-area-inset-left));
  --mr:max(var(--m),env(safe-area-inset-right));
  --mb:max(var(--m),env(safe-area-inset-bottom))}
.bs-touch.hidden{display:none}

/* The LOOK PAD is the drag surface, not the ring. Buttons are SIBLINGS, later in the DOM,
   so they hit-test above it and a press cannot bubble into a camera swing. */
.bs-look{position:absolute;right:0;bottom:0;pointer-events:auto;touch-action:none;
  width:calc(var(--mr) + var(--s)/2 + var(--r) + var(--atk)/2 + 10px);
  height:calc(var(--mb) + var(--s)/2 + var(--r) + var(--atk)/2 + 10px)}

.bs-stick{position:absolute;bottom:var(--mb);
  width:var(--s);aspect-ratio:1;pointer-events:auto;border-radius:50%;
  background:radial-gradient(circle,rgba(255,255,255,.09),rgba(255,255,255,.03) 70%);
  border:1px solid rgba(255,255,255,.16);transition:opacity .2s ease;opacity:.5}
.bs-stick.move{left:var(--ml)}
/* The look ring is a READOUT; the pad owns the touch, so it must not take events. */
.bs-stick.look{right:var(--mr);pointer-events:none}
.bs-stick.active{opacity:1}
.bs-stick .knob{position:absolute;left:50%;top:50%;width:38%;aspect-ratio:1;margin:0;
  transform:translate(-50%,-50%);border-radius:50%;
  background:radial-gradient(circle at 36% 30%,rgba(255,255,255,.9),rgba(210,228,245,.55) 60%,rgba(150,180,210,.4));
  box-shadow:0 4px 14px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.6)}
.bs-stick .tag{position:absolute;left:50%;bottom:7%;transform:translateX(-50%);
  font-size:16px;font-weight:800;letter-spacing:.06em;color:rgba(255,255,255,.55)}

/* Fan containers are ZERO-SIZED points on a stick's centre; rotate(-a)/translateX(r)/
   rotate(a) places a button polar and leaves its label upright. Static CSS. */
.bs-btns,.bs-skills{position:absolute;width:0;height:0;pointer-events:none;
  --rad:var(--r);
  right:calc(var(--mr) + var(--s)/2);bottom:calc(var(--mb) + var(--s)/2)}
.bs-btns.near{right:auto;left:calc(var(--ml) + var(--s)/2);--rad:var(--lr)}

/* letter-spacing 0: inside a circle, tracking comes off the margin at both ends. */
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
/* Brightness only — the transform carries the polar position, so scale() would move it. */
.bs-btn:active,.bs-btn.on{filter:brightness(1.55)}

/* MENU sits top-left, off the thumb fans and in the region the HUD leaves empty. */
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

/* Skills read as one set inside the fan: same circle, cooler fill, cyan hairline. */
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

class Stick {
  readonly el: HTMLDivElement;
  private knob: HTMLDivElement;
  private active: StickState | null = null;
  /** -1..1, +y is screen-up */
  x = 0;
  y = 0;

  /** `pad` makes this a FLOATING stick: the pad hears the touch, the ring only follows. */
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
      // Home the ring first: the deflection radius comes from its rect.
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
  /** Full-deflection turn rate, in the mouse-pixel units the camera consumes. */
  private static readonly LOOK_PX_PER_SEC = 620;
  /** +1/-1 on a DOWN-POSITIVE axis, as `GamepadControls` applies it to axes[3]. */
  private lookSignX = 1;
  private lookSignY = -1;
  private revealed = false;

  /** Null on pure mouse hardware. A hybrid gets a hidden instance that still ticks. */
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

    const place = (el: HTMLElement, angle: number): void => {
      el.style.setProperty('--a', `${angle}deg`);
    };

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

    const btns = document.createElement('div');
    btns.className = 'bs-btns';
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

    // The CSS class is the identifier; the cap is display. Nothing keys on the word.
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

    // MENU taps the virtual F10 main.ts already routes — one key edge, one entry point.
    const menuBtn = document.createElement('button');
    menuBtn.className = 'bs-pausebtn';
    menuBtn.textContent = t('touch.menu');
    menuBtn.addEventListener('touchstart', (e) => {
      e.preventDefault();
      e.stopPropagation();
      menuBtn.classList.add('on');
      this.input.tapVirtual('F10');
    }, { passive: false });
    const menuUp = (): void => menuBtn.classList.remove('on');
    menuBtn.addEventListener('touchend', menuUp);
    menuBtn.addEventListener('touchcancel', menuUp);
    this.root.appendChild(menuBtn);

    // Hybrids stay hidden until a real touch; the instance still ticks.
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

    // First real touch marks the session touch-driven (no pointer lock) and reveals.
    window.addEventListener('touchstart', () => {
      this.input.touchActive = true;
      this.revealed = true;
      this.root.classList.remove('hidden');
    }, { passive: true });

    // Which device is LIVE, stamped per gesture. CAPTURE PHASE is required: every stick
    // and button calls stopPropagation(), so a bubble listener never sees them.
    window.addEventListener(
      'touchstart',
      () => this.input.noteSource('touch'),
      { passive: true, capture: true },
    );
  }

  /** Per frame: the look stick is a RATE control, so held deflection must keep feeding. */
  update(dt: number): void {
    if (!this.lookStick.engaged) return;
    const k = TouchControls.LOOK_PX_PER_SEC * Math.min(dt, 0.05);
    // Stick y is screen-up-positive; negate into the down-positive axis `lookSignY` uses.
    this.input.addLook(
      this.lookStick.x * this.lookSignX * k,
      -this.lookStick.y * this.lookSignY * k,
    );
    this.input.setTouchLooking(true);
  }

  /** Same contract as `GamepadControls.setLookAxes` — a virtual stick is a stick. */
  setLookAxes(a: Partial<LookAxes>): void {
    if (a.invertX !== undefined) this.lookSignX = a.invertX ? -1 : 1;
    if (a.invertY !== undefined) this.lookSignY = a.invertY ? -1 : 1;
  }

  get lookAxes(): LookAxes {
    return { invertX: this.lookSignX < 0, invertY: this.lookSignY < 0 };
  }

  get isRevealed(): boolean { return this.revealed; }

  /** Called every frame. Never reveals a deferred overlay. */
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

  /** Re-cap after a language change (`onLanguageChange`). Looks up by CLASS, not caption. */
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
