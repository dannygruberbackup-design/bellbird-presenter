export type TestPattern = {
  canvas: HTMLCanvasElement;
  start(): void;
  stop(): void;
  readonly running: boolean;
};

export function createTestPattern(keyColor = 0x00b140): TestPattern {
  const kr = (keyColor >> 16) & 0xff;
  const kg = (keyColor >> 8) & 0xff;
  const kb = keyColor & 0xff;
  const W = 270;
  const H = 480;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  let raf = 0;
  let running = false;
  let t0 = 0;

  const shaded = (f: number) =>
    `rgb(${Math.min(255, Math.round(kr * f))},${Math.min(255, Math.round(kg * f))},${Math.min(255, Math.round(kb * f))})`;

  const bar = (x: number, y: number, w: number, h: number, r: number, fill: string) => {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fill();
  };

  function draw(phase: number) {
    for (let y = 0; y < H; y += 3) {
      ctx.fillStyle = shaded(1.14 - 0.3 * (y / H));
      ctx.fillRect(0, y, W, 3);
    }
    const cx = W / 2 + Math.sin(phase * Math.PI * 2) * 3;
    const floor = H - 3;
    const legTop = floor - 176;
    const torsoTop = legTop - 113;
    bar(cx - 23, legTop, 19, 166, 8, '#30323a');
    bar(cx + 4, legTop, 19, 166, 8, '#30323a');
    bar(cx - 26, floor - 10, 24, 10, 3, '#202024');
    bar(cx + 2, floor - 10, 24, 10, 3, '#202024');
    bar(cx - 33, torsoTop, 66, 124, 16, '#3a4a7a');
    const wave = Math.sin(phase * Math.PI * 4);
    const sx = cx + 31;
    const sy = torsoTop + 21;
    const angle = (-52 + wave * 26) * (Math.PI / 180);
    ctx.strokeStyle = '#3a4a7a';
    ctx.lineWidth = 16;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + Math.cos(angle) * 44, sy - Math.sin(angle) * 44);
    ctx.stroke();
    bar(cx - 8, torsoTop - 15, 16, 20, 5, '#deb294');
    ctx.fillStyle = '#deb294';
    ctx.beginPath();
    ctx.arc(cx, torsoTop - 28, 24, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#48362c';
    ctx.beginPath();
    ctx.arc(cx, torsoTop - 28, 24, Math.PI, 0);
    ctx.fill();
  }

  function frame(now: number) {
    if (!running) return;
    if (!t0) t0 = now;
    draw((((now - t0) / 4000) % 1 + 1) % 1);
    raf = requestAnimationFrame(frame);
  }

  draw(0);

  return {
    canvas,
    get running() {
      return running;
    },
    start() {
      if (running) return;
      running = true;
      raf = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      cancelAnimationFrame(raf);
    },
  };
}
