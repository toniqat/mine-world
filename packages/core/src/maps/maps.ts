import { base64Decode } from '../multi/codec';
import { EARTH_H, EARTH_RLE, EARTH_W } from './earthData';

/** Map shapes a world can be read from (`WorldConfig.map`). */
export type MapId = 'earth';

/** A fixed land mask: `data[y * w + x]` is 1 on land, 0 on water. The world wraps every `w` columns. */
export interface MapMask {
  w: number;
  h: number;
  data: Uint8Array;
}

const cache = new Map<MapId, MapMask>();

/** The land mask of a map, decoded once. */
export function mapMask(id: MapId): MapMask {
  let m = cache.get(id);
  if (!m) {
    m = decode(EARTH_W, EARTH_H, EARTH_RLE);
    cache.set(id, m);
  }
  return m;
}

/** Run lengths per row (water first, alternating), LEB128 varints, base64 (see scripts/earth-mask.mjs). */
function decode(w: number, h: number, b64: string): MapMask {
  const bytes = base64Decode(b64);
  const data = new Uint8Array(w * h);
  let p = 0;
  for (let row = 0; row < h; row++) {
    let c = 0;
    let v = 0;
    while (c < w) {
      let n = 0;
      let shift = 0;
      let b: number;
      do {
        b = bytes[p++];
        n |= (b & 0x7f) << shift;
        shift += 7;
      } while (b & 0x80);
      if (v) data.fill(1, row * w + c, row * w + c + n);
      c += n;
      v ^= 1;
    }
  }
  return { w, h, data };
}
