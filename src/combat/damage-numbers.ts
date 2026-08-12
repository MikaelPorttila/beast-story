import * as THREE from "three";

interface Num {
  sprite: THREE.Sprite;
  mat: THREE.SpriteMaterial;
  tex: THREE.CanvasTexture;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  life: number;
  maxLife: number;
  x: number;
  y: number;
  z: number;
  vy: number;
  vx: number;
  vz: number;
  w: number;
  h: number;
  active: boolean;
}

const CW = 256,
  CH = 128;

function easeOutBack(t: number): number {
  const c1 = 1.70158,
    c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

export class DamageNumbers {
  private pool: Num[] = [];

  constructor(private scene: THREE.Scene) {}

  private slot(): Num | null {
    for (const n of this.pool) {
      if (!n.active) {
        return n;
      }
    }
    if (this.pool.length >= 40) {
      return null;
    }
    const canvas = document.createElement("canvas");
    canvas.width = CW;
    canvas.height = CH;
    const ctx = canvas.getContext("2d")!;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.renderOrder = 30;
    sprite.visible = false;
    this.scene.add(sprite);
    const n: Num = {
      sprite,
      mat,
      tex,
      canvas,
      ctx,
      life: 0,
      maxLife: 1,
      x: 0,
      y: 0,
      z: 0,
      vy: 0,
      vx: 0,
      vz: 0,
      w: 1,
      h: 0.5,
      active: false,
    };
    this.pool.push(n);
    return n;
  }

  /** World-space float; hex tints the fill, big = crit styling. */
  spawn(x: number, y: number, z: number, text: string, hex: number, big: boolean): void {
    const n = this.slot();
    if (!n) {
      return;
    }
    const ctx = n.ctx;
    ctx.clearRect(0, 0, CW, CH);
    const px = big ? 92 : 68;
    ctx.font = `900 ${px}px 'Arial Black', Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#151a28";
    ctx.lineWidth = big ? 18 : 14;
    ctx.strokeText(text, CW / 2, CH / 2);
    const c = new THREE.Color(hex);
    ctx.fillStyle = `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`;
    ctx.fillText(text, CW / 2, CH / 2);
    n.tex.needsUpdate = true;

    n.active = true;
    n.life = 0.9;
    n.maxLife = 0.9;
    n.x = x + (Math.random() - 0.5) * 0.35;
    n.y = y;
    n.z = z + (Math.random() - 0.5) * 0.35;
    n.vy = 2.0;
    n.vx = (Math.random() - 0.5) * 0.7;
    n.vz = (Math.random() - 0.5) * 0.7;
    n.h = big ? 0.82 : 0.58;
    n.w = n.h * (CW / CH);
    n.sprite.position.set(n.x, n.y, n.z);
    n.sprite.scale.set(0.01, 0.01, 1);
    n.mat.opacity = 1;
    n.sprite.visible = true;
  }

  update(dt: number): void {
    for (const n of this.pool) {
      if (!n.active) {
        continue;
      }
      n.life -= dt;
      if (n.life <= 0) {
        n.active = false;
        n.sprite.visible = false;
        continue;
      }
      const age = n.maxLife - n.life;
      n.vy = Math.max(0.35, n.vy - 4.2 * dt);
      n.y += n.vy * dt;
      n.x += n.vx * dt;
      n.z += n.vz * dt;
      const pop = age < 0.18 ? easeOutBack(age / 0.18) : 1;
      const t = n.life / n.maxLife;
      const fade = t < 0.45 ? t / 0.45 : 1;
      n.sprite.position.set(n.x, n.y, n.z);
      n.sprite.scale.set(n.w * pop, n.h * pop, 1);
      n.mat.opacity = fade;
    }
  }
}
