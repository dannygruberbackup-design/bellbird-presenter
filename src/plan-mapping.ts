// Turning a drag on the floor plan into a rectangle in the room.
//
// The obvious route was Pointer.intersection: whatever is under the cursor,
// in world coordinates. It works for a tap and not for a drag, because a drag
// in plan view is Matterport panning the plan, and it stops reporting while it
// does. That is why dragging a box did nothing.
//
// So the drag is taken away from Matterport entirely \u2014 a transparent layer over
// the viewer swallows it \u2014 and screen coordinates are converted afterwards.
//
// The conversion is possible because the plan view is an orthographic camera
// looking straight down: the map from floor to screen is affine, so three known
// points are enough to pin it down. Matterport will happily tell us where any
// world point lands on screen; the sweeps are a free set of known points, so we
// ask about several and solve the mapping backwards.

import { diag } from './diagnostics';

export type ScreenToWorld = (screen: { x: number; y: number }) => { x: number; z: number };

/**
 * Builds a screen-to-floor mapping for the current view.
 *
 * Returns null when there are too few sweeps to solve, or when the view is not
 * flat enough for an affine map to be honest \u2014 which is the case in the
 * walkthrough, where a perspective camera makes distance and screen position
 * non-linear.
 */
export function calibrate(
  mpSdk: any,
  pose: any,
  sweeps: { x: number; y: number; z: number }[],
): ScreenToWorld | null {
  const convert = mpSdk?.Conversion?.worldToScreen;
  if (typeof convert !== 'function' || !pose) return null;

  const size = { w: window.innerWidth, h: window.innerHeight };
  const samples: { sx: number; sy: number; x: number; z: number }[] = [];

  // A spread of sweeps rather than the first few: three points huddled in one
  // corner solve the mapping but amplify every small error across the building.
  const step = Math.max(1, Math.floor(sweeps.length / 12));
  for (let i = 0; i < sweeps.length; i += step) {
    const world = sweeps[i];
    try {
      const screen = convert(world, pose, size);
      if (!screen || !Number.isFinite(screen.x) || !Number.isFinite(screen.y)) continue;
      samples.push({ sx: screen.x, sy: screen.y, x: world.x, z: world.z });
    } catch {
      return null;
    }
  }

  if (samples.length < 3) return null;

  const forX = solveAffine(samples, (s) => s.x);
  const forZ = solveAffine(samples, (s) => s.z);
  if (!forX || !forZ) return null;

  return (screen) => ({
    x: forX[0] * screen.x + forX[1] * screen.y + forX[2],
    z: forZ[0] * screen.x + forZ[1] * screen.y + forZ[2],
  });
}

/**
 * Least squares fit of `value = a*sx + b*sy + c`.
 *
 * Three points would be exact, but the sweeps are measured and the projection
 * is not perfectly flat, so fitting over a dozen spreads the error rather than
 * letting whichever three were picked decide the whole building.
 */
function solveAffine(
  samples: { sx: number; sy: number; x: number; z: number }[],
  value: (s: { x: number; z: number }) => number,
): [number, number, number] | null {
  // Normal equations for a 3-parameter fit: a symmetric 3x3 solved by hand,
  // which is smaller and clearer than pulling in a matrix library for one use.
  let sxx = 0, sxy = 0, sx1 = 0, syy = 0, sy1 = 0, s11 = 0;
  let bx = 0, by = 0, b1 = 0;

  for (const s of samples) {
    const v = value(s);
    sxx += s.sx * s.sx;
    sxy += s.sx * s.sy;
    sx1 += s.sx;
    syy += s.sy * s.sy;
    sy1 += s.sy;
    s11 += 1;
    bx += s.sx * v;
    by += s.sy * v;
    b1 += v;
  }

  const m = [
    [sxx, sxy, sx1],
    [sxy, syy, sy1],
    [sx1, sy1, s11],
  ];
  const rhs = [bx, by, b1];

  // Gaussian elimination with partial pivoting.
  for (let col = 0; col < 3; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < 3; row += 1) {
      if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    }
    if (Math.abs(m[pivot][col]) < 1e-9) return null;

    [m[col], m[pivot]] = [m[pivot], m[col]];
    [rhs[col], rhs[pivot]] = [rhs[pivot], rhs[col]];

    for (let row = 0; row < 3; row += 1) {
      if (row === col) continue;
      const factor = m[row][col] / m[col][col];
      for (let k = col; k < 3; k += 1) m[row][k] -= factor * m[col][k];
      rhs[row] -= factor * rhs[col];
    }
  }

  const result: [number, number, number] = [
    rhs[0] / m[0][0],
    rhs[1] / m[1][1],
    rhs[2] / m[2][2],
  ];

  if (result.some((n) => !Number.isFinite(n))) {
    diag.warn('Could not map the plan to the floor.');
    return null;
  }
  return result;
}
