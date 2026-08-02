import type { Placement } from './scene';
import type { DirectorOptions } from './presenter-director';

// Presenter placements for this space.
//
// Every entry becomes a slot you can switch between in the dev panel, each with
// its own position, size, shadow, trim and video. Slots beyond the first start
// hidden: they appear once you place them, so an unused guide never stands in
// the middle of a room waiting to be noticed.
//
// To fill one in: open with ?dev=1, pick the presenter, tap Placement mode, tap
// a floor circle, adjust, then Copy placement JSON and paste the result here.
// `position` is the point on the floor — the component lifts the plane by half
// its height automatically, so you are placing feet, not centre of mass.
//
// TO PUBLISH A VIDEO: put the MP4 somewhere it can be served over HTTPS with
// CORS enabled and set `src` to that URL. Until then the panel's picker keeps a
// copy on the device you are testing from, per presenter, which is enough to
// judge the result but is not visible to anyone else.

export const DIRECTOR_OPTIONS: Partial<DirectorOptions> = {
  triggerRadius: 3.5,
  preloadRadius: 9,
  onReturn: 'restart',
  playOnce: true,
};

// Everything measured off the supplied footage. Shared by every slot so a new
// presenter starts keying correctly instead of invisible.
const MEASURED = {
  // Height of the FRAME, not the person. She spans 923px of a 944px crop, so
  // the frame runs ~2.3% taller than she does: a 2.00m presenter needs a 2.05m
  // frame. The Height slider is labelled in person-height and converts for you.
  heightMeters: 2.05,

  // Replaced automatically from the file's own dimensions on load.
  aspect: 512 / 944,

  // Sampled from the real footage, not assumed. The border of every frame after
  // the fade-in measures #4f895b. Note how far that is from broadcast green
  // (0x00b140): a soft desaturated sage sitting only 0.11 from neutral grey in
  // chroma space, where a proper screen sits nearer 0.33.
  keyColor: 0x50895b,

  // Measured, not guessed. Chroma distance from the key is cleanly bimodal: 92%
  // of pixels sit below 0.056 (the screen) and the subject begins at 0.090,
  // with an empty gap between. 0.07 sits in that gap.
  similarity: 0.07,
  smoothness: 0.025,
  spill: 0.04,

  // Without this her spill-tinted trousers, shoes and hair came out ~60% opaque
  // and the room showed through. At 0.30, 100% of subject pixels are solid and
  // 99.9% of the screen is still removed.
  lumaWeight: 0.3,

  // The clip fades in from white and only settles into a keyable colour at
  // about 0.6s. Before that the background crosses the key threshold — at 0.4s
  // roughly a third is half-keyed and another third fully opaque, which shows
  // as a checkerboard because compression pushes each block differently.
  startAt: 0.7,

  shadowDiameter: 1.65,
  shadowOpacity: 0.55,

  // Studio lighting is almost always darker than the room it lands in, so a
  // small lift is a better starting point than none.
  brightness: 1.15,
};

// One renderer.
//
// She used to be four, because a presenter was also a place. The zone map has
// nineteen places, and nineteen chroma planes each with its own video element
// is not something an iPad should be asked to hold. Areas are data now; she is
// the single surface that gets moved to wherever she is wanted.
export const PRESENTERS: Placement[] = [
  {
    id: 'Presenter 1',
    position: { x: 1.24, y: -0.05, z: -5.448 },
    inputs: { src: 'test', visible: true, ...MEASURED },
  },
];
