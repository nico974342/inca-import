/** Fabrique de petits PNG RGBA 8 bits pour les tests (aucune dépendance). */
import { deflateSync, crc32 } from 'node:zlib';

function bloc(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const corps = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(corps) >>> 0);
  return Buffer.concat([len, corps, crc]);
}

/** PNG transparent de w × h ; `trace(x, y)` renvoie true pour les pixels à colorer (opaques, encre sombre). */
export function fabriquerPng(w: number, h: number, trace: (x: number, y: number) => boolean = () => false, filtre = 0): Buffer {
  const lignes: Buffer[] = [];
  for (let y = 0; y < h; y++) {
    const l = Buffer.alloc(w * 4 + 1); l[0] = filtre;
    for (let x = 0; x < w; x++) if (trace(x, y)) { const o = 1 + x * 4; l[o] = 11; l[o + 1] = 27; l[o + 2] = 58; l[o + 3] = 255; }
    lignes.push(l);
  }
  // filtre « Up » (2) : chaque octet est stocké comme différence avec la ligne du dessus
  if (filtre === 2) for (let y = h - 1; y > 0; y--) for (let i = 1; i < lignes[y].length; i++) lignes[y][i] = (lignes[y][i] - lignes[y - 1][i]) & 0xff;
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    bloc('IHDR', ihdr), bloc('IDAT', deflateSync(Buffer.concat(lignes))), bloc('IEND', Buffer.alloc(0)),
  ]);
}

export const versDataUrl = (png: Buffer) => 'data:image/png;base64,' + png.toString('base64');

/** Une « signature » : une courbe épaisse sur toute la largeur. */
export const signatureTest = (w = 900, h = 540) =>
  fabriquerPng(w, h, (x, y) => Math.abs(y - (h / 2 + Math.sin(x / 40) * h / 6)) < 4 && x > w * 0.1 && x < w * 0.9);
