// Zone placements that ship with the build.
//
// Authoring writes to browser storage, which is exactly right while you are
// drawing: it is instant, private to you, and survives a reload. It is exactly
// wrong as the finished article, because storage belongs to one browser on one
// machine. Open the space on a second laptop and the showroom has no zones at
// all - and so does every visitor, which is the version that matters.
//
// So the finished map lives here, in the repository, and ships with the site.
// Local storage still wins when it has something, so authoring is unaffected;
// this is the floor beneath it rather than a replacement for it.
//
// To update: draw the zones, press Copy zone map, and paste the JSON in below.

import type { AreaId, AreaState } from './areas';

export type PublishedMap = {
  buildingAngle?: number;
  aisleReach?: number;
  byArea: Record<AreaId, AreaState>;
};

export const PUBLISHED: PublishedMap = {
  byArea: {},
};
