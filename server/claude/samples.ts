// server/claude/samples.ts — provfilerna till try_app:s steg upload, drop och paste (CONTRACT §8.7). De byggs här i
// koden och läses aldrig från en sökväg som Claude anger: en 64×64 PNG (RGBA, zlib), en 64×64 JPEG och en kort text.
// Båda bilderna visar samma sak, en blå skiva (#2f6bff) på ljusgrå botten, som ett litet foto.
import zlib from 'node:zlib';

export const SAMPLE_KINDS = ['png', 'jpeg', 'txt'] as const;
export type SampleKind = (typeof SAMPLE_KINDS)[number];

export interface Sample {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** En PNG, size×size i RGBA (färgtyp 6, 8 bitar): den blå skivan på ljusgrå botten. */
export function samplePng(size = 64): Buffer {
  const row = size * 4 + 1;
  const raw = Buffer.alloc(row * size); // varje rad börjar med filtret 0 (inget)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inside = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) <= size * 0.375;
      raw.set(inside ? [0x2f, 0x6b, 0xff, 0xff] : [0xf2, 0xf4, 0xf8, 0xff], y * row + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Samma bild som JPEG (baseline, 758 byte), ritad en gång med Chromes canvas (kvalitet 0,6) och utan ICC-profil.
const JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//' +
  '2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCABAAEADASIAAhEBAxEB/8QA' +
  'GQABAAMBAQAAAAAAAAAAAAAAAAIGBwUD/8QAJxAAAgIBAgMJAQAAAAAAAAAAAgMAAREEBQYxURITFCIjQUJxgZH/xAAXAQADAQAAAAAAAAAAAAAAAAAABAUB' +
  '/8QAHREAAgICAwEAAAAAAAAAAAAAAAECAwQRBSFBMf/aAAwDAQACEQMRAD8A0eIkWsBKiY0qABrJFfKqm/TCUSnbpxS5pWvb/SXy7y68xfXScB2oe8u09zGX' +
  'fuRXcpVcbZJbk9C0smKel2ahEy9Ooegu0hzF3XuJXU7+18UuUVL3D1V8u8qvMP31hbxtkVuL2EcmL6fRcYkVMByhYoqMCrIlXK6kpN+DIlO4u3Im6nwCiwtW' +
  'LZj5F0/JcZl+pbb9U1xXm2HZf25S42pSscn4LZMmo6Xp5RES6IiIiAFk4R3IlanwDSytubXn4l0/ZcZl+mbaNUpw3i1nRfy5qEhclUo2KS9HsaW46fgmX6lV' +
  'o1TUlWLWdj/LmoSncXbaStT49Q5W3FMx8S6/sONtUbHF+hkxbjteFbiIl0REREAPXTKt+qUkazbDof7c1CU7hHbSbqfHtHC1ZpefkXX8lxkLkrVKxRXg9jR1' +
  'Hb9Ei1YOUS2jRgVYIb5XUlEm/Bkp26cLOUVs2/1V8+7u/MP11nAdp3oLsvSxd17EN1NQiUquSsitSWxaWNFva6MvTp3vLsoSxl37CN3O/tfCzmlTNw9JfPu6' +
  'vzF99JcYhbyVklqK0EcaK7fZFSwSoVqGgAawI1yqpKIk36Mn/9k=';

let cache: Record<SampleKind, Sample> | null = null;

/** Provfilen för ett slag; samma byte varje gång. */
export function sample(kind: SampleKind): Sample {
  cache ??= {
    png: { name: 'sample.png', mimeType: 'image/png', buffer: samplePng() },
    jpeg: { name: 'sample.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(JPEG_BASE64, 'base64') },
    txt: { name: 'sample.txt', mimeType: 'text/plain', buffer: Buffer.from('Hej från Workbench.\nEn kort provtext med å, ä och ö.\n', 'utf8') },
  };
  return cache[kind];
}
