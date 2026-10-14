import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadLocalPhotos, buildPhotoAtlases, releasePhotos } from './photos.js';

const photoDirectory = new URL('../public/photos/', import.meta.url);
const jpeg = await readFile(new URL('photo-01.jpg', photoDirectory));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1UAAAAASUVORK5CYII=', 'base64');
const originalGlobals = { document: globalThis.document, createImageBitmap: globalThis.createImageBitmap };
let decoded;
let closed;
let imports;

beforeEach(() => {
  decoded = [];
  closed = 0;
  imports = [];
  // Node has no canvas or image decoder. Stub only those browser boundaries;
  // parsing, File/blob URLs, filtering, ordering and cleanup use the real APIs.
  globalThis.document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ({ fillRect() {}, drawImage() {} }) }),
  };
  globalThis.createImageBitmap = async (_, options) => {
    decoded.push(options);
    return { width: options.resizeWidth, height: options.resizeHeight, close() { closed += 1; } };
  };
});

afterEach(() => {
  for (const photos of imports) releasePhotos(photos);
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
});

async function importFiles(files) {
  const result = await loadLocalPhotos(files);
  imports.push(result.photos);
  return result;
}

function segment(body) {
  const prefix = Buffer.alloc(4);
  prefix[0] = 0xff;
  prefix[1] = 0xe1;
  prefix.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([prefix, body]);
}

function exif(orientation, littleEndian = true) {
  const bytes = Buffer.alloc(32);
  bytes.write('Exif\0\0', 0, 'binary');
  bytes.write(littleEndian ? 'II' : 'MM', 6);
  const short = (offset, value) => littleEndian ? bytes.writeUInt16LE(value, offset) : bytes.writeUInt16BE(value, offset);
  const long = (offset, value) => littleEndian ? bytes.writeUInt32LE(value, offset) : bytes.writeUInt32BE(value, offset);
  short(8, 42);
  long(10, 8);
  short(14, 1);
  short(16, 0x0112);
  short(18, 3);
  long(20, 1);
  short(24, orientation);
  return segment(bytes);
}

function stripApp1(bytes) {
  const chunks = [bytes.subarray(0, 2)];
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff || bytes[offset + 1] === 0xda) break;
    const end = offset + 2 + bytes.readUInt16BE(offset + 2);
    if (bytes[offset + 1] !== 0xe1) chunks.push(bytes.subarray(offset, end));
    offset = end;
  }
  chunks.push(bytes.subarray(offset));
  return Buffer.concat(chunks);
}

test('all offline demo JPEG headers agree with the manifest and decode only at atlas preparation', async () => {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', photoDirectory), 'utf8'));
  const files = await Promise.all(manifest.map(async entry => new File([
    await readFile(new URL(entry.file, photoDirectory)),
  ], entry.file, { type: 'image/jpeg' })));
  const { photos } = await importFiles(files);
  assert.equal(photos.length, 48);
  assert.equal(decoded.length, 0);
  const atlases = await buildPhotoAtlases(photos);
  assert.deepEqual(photos.map(photo => [photo.width, photo.height]), manifest.map(entry => [entry.width, entry.height]));
  assert.equal(atlases.diagnostics.decodedCount, 48);
  assert.equal(atlases[0].canvas.height, 384);
  assert.equal(closed, 48);
});

test('JPEG EXIF orientation survives a later XMP APP1 segment in both byte orders', async () => {
  const base = stripApp1(jpeg);
  const xmp = segment(Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>'));
  const files = [true, false].flatMap(littleEndian => Array.from({ length: 8 }, (_, index) => {
    const orientation = index + 1;
    const body = Buffer.concat([base.subarray(0, 2), exif(orientation, littleEndian), xmp, base.subarray(2)]);
    return new File([body], `orientation-${orientation}-${littleEndian}.jpg`, { type: 'image/jpeg' });
  }));
  const { photos } = await importFiles(files);
  await buildPhotoAtlases(photos);
  assert.deepEqual(photos.map(photo => [photo.width, photo.height]), [true, false].flatMap(() =>
    Array.from({ length: 8 }, (_, index) => index >= 4 ? [280, 400] : [400, 280])));
});

test('PNG dimensions are read from its real header; huge dimensions and corrupt files are skipped', async () => {
  const huge = Buffer.from(png);
  huge.writeUInt32BE(32769, 16);
  const { photos } = await importFiles([
    new File([png], 'pixel.png', { type: 'image/png' }),
    new File([huge], 'huge.png', { type: 'image/png' }),
    new File(['truncated JPEG'], 'broken.jpg', { type: 'image/jpeg' }),
  ]);
  const atlases = await buildPhotoAtlases(photos);
  assert.equal(photos[0].width, 1);
  assert.equal(photos[0].height, 1);
  assert.deepEqual(atlases[0].photoIndices, [0]);
  assert.equal(atlases.diagnostics.skippedCount, 2);
  assert.equal(decoded.length, 1);
  assert.equal(closed, 1);
});

test('empty, non-image and oversized files do not use up the 3000-photo allowance', async () => {
  const oversized = new File([png], 'too-large.png', { type: 'image/png' });
  Object.defineProperty(oversized, 'size', { value: 40 * 1024 * 1024 + 1 });
  const good = new File([png], 'pixel.png', { type: 'image/png' });
  const result = await importFiles([
    new File([], 'empty.png', { type: 'image/png' }),
    new File(['text'], 'notes.txt', { type: 'text/plain' }),
    oversized,
    ...Array(3001).fill(good),
  ]);
  assert.equal(result.photos.length, 3000);
  assert.equal(result.skipped, 4);
  assert.equal(new Set(result.photos.map(photo => photo.id)).size, 3000);
  assert.equal(decoded.length, 0);
});

test('releasePhotos revokes local blob URLs and can be called twice', async () => {
  const { photos } = await importFiles([new File([png], 'pixel.png', { type: 'image/png' })]);
  assert.equal((await fetch(photos[0].url)).ok, true);
  releasePhotos(photos);
  releasePhotos(photos);
  await assert.rejects(fetch(photos[0].url));
});

test('SVG dimension attributes do not match data-width or stroke-width', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" data-width="9" data-height="7" stroke-width="3" width="400" height="280"><rect width="400" height="280"/></svg>';
  const { photos } = await importFiles([new File([svg], 'vector.svg', { type: 'image/svg+xml' })]);
  await buildPhotoAtlases(photos);
  assert.deepEqual([photos[0].width, photos[0].height], [400, 280]);
});
