const GRAIN_TILE_PX = 32;
const grain = { tile: "" };

function whiteNoiseTile() {
  const c = document.createElement("canvas");
  c.width = GRAIN_TILE_PX;
  c.height = GRAIN_TILE_PX;
  const ctx = c.getContext("2d");
  if (!ctx) return "";
  const img = ctx.createImageData(GRAIN_TILE_PX, GRAIN_TILE_PX);
  let seed = 713;
  for (let i = 0; i < img.data.length; i += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const grey = seed >>> 24;
    img.data[i] = grey;
    img.data[i + 1] = grey;
    img.data[i + 2] = grey;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  grain.tile = c.toDataURL();
  return grain.tile;
}

export function softLightGrainTile() {
  if (typeof document === "undefined" || grain.tile !== "") return grain.tile;
  return whiteNoiseTile();
}

export const GRAIN_STYLE = { mixBlendMode: "soft-light", opacity: 0.45, pointerEvents: "none" } as const;
