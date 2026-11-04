import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadLocalPhotos, buildPhotoAtlases, releasePhotos } from './photos.js';

const original = { document: globalThis.document, createImageBitmap: globalThis.createImageBitmap };
const albums = [];
afterEach(() => {
  albums.splice(0).forEach(releasePhotos);
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
});

function imageFile(width, height, index) {
  return new File([`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="red"/></svg>`], `${index}.svg`, { type: 'image/svg+xml' });
}

function simpleCanvas() {
  return { width: 0, height: 0, getContext: () => ({ fillRect() {}, drawImage() {} }) };
}

test('atlas decode retains useful detail in portrait and panorama crops while bounding temporary pixels', async () => {
  const dimensions = [[1000, 4000], [4000, 1000], [3051, 32768], [32768, 1000]];
  const { photos } = await loadLocalPhotos(dimensions.map(([w, h], index) => imageFile(w, h, index)));
  albums.push(photos);
  globalThis.document = { createElement: simpleCanvas };
  const decoded = [];
  let closed = 0;
  globalThis.createImageBitmap = async (blob, options) => {
    decoded.push(options);
    return { width: options.resizeWidth, height: options.resizeHeight, close() { closed++; } };
  };
  const atlases = await buildPhotoAtlases(photos, null, { cellSize: 64, maxTextureSize: 2048, decodeConcurrency: 1 });
  const { cellRect } = atlases[0];
  assert.equal(decoded[0].resizeWidth, cellRect.width * 2);
  assert.equal(decoded[1].resizeHeight, cellRect.height * 2);
  // With the former longest-edge rule the portrait crop was only 32px wide,
  // forcing drawCover to enlarge it to 62px. Its useful crop is now 124px wide.
  assert.ok(decoded[0].resizeWidth >= cellRect.width);
  dimensions.forEach(([width, height], index) => {
    const decodedImage = decoded[index];
    assert.ok(decodedImage.resizeWidth <= width && decodedImage.resizeHeight <= height);
    assert.ok(decodedImage.resizeWidth * decodedImage.resizeHeight <= atlases.diagnostics.thumbnailPixelBudget);
    const sourceCropWidth = Math.min(decodedImage.resizeWidth, decodedImage.resizeHeight * cellRect.width / cellRect.height);
    const sourceCropHeight = Math.min(decodedImage.resizeHeight, decodedImage.resizeWidth * cellRect.height / cellRect.width);
    assert.ok(sourceCropWidth >= cellRect.width);
    assert.ok(sourceCropHeight >= cellRect.height);
  });
  assert.ok(atlases.diagnostics.maximumThumbnailPixels <= atlases.diagnostics.thumbnailPixelBudget);
  assert.equal(closed, photos.length);
  assert.equal(atlases.diagnostics.canvasBytes, 16 * 64 * 64 * 4);
});

test('one-pixel-wide extreme images still respect the temporary pixel cap after dimension rounding', async () => {
  const { photos } = await loadLocalPhotos([imageFile(1, 32768, 0), imageFile(32768, 1, 1)]);
  albums.push(photos);
  globalThis.document = { createElement: simpleCanvas };
  const dimensions = [];
  globalThis.createImageBitmap = async (blob, options) => {
    dimensions.push([options.resizeWidth, options.resizeHeight]);
    return { width: options.resizeWidth, height: options.resizeHeight, close() {} };
  };
  const atlases = await buildPhotoAtlases(photos, null, { cellSize: 16, maxTextureSize: 256 });
  assert.ok(dimensions.every(([w, h]) => w >= 1 && h >= 1 && w * h <= atlases.diagnostics.thumbnailPixelBudget));
  assert.equal(atlases.diagnostics.thumbnailPixelBudget, 8192);
});

// A small deterministic raster context lets this test inspect the produced
// edge pixels, rather than merely counting drawImage calls. Self-copies read a
// snapshot, matching the canvas API's source-before-destination behaviour.
class PixelCanvas {
  constructor() { this._width = 0; this._height = 0; this.pixels = new Uint32Array(); }
  set width(value) { this._width = value; this.resize(); }
  get width() { return this._width; }
  set height(value) { this._height = value; this.resize(); }
  get height() { return this._height; }
  resize() { this.pixels = new Uint32Array(this._width * this._height); }
  getContext() {
    const canvas = this;
    return {
      fillRect(x, y, width, height) {
        for (let row = y; row < y + height; row++) {
          for (let col = x; col < x + width; col++) canvas.pixels[row * canvas.width + col] = 0xff05070c;
        }
      },
      drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh) {
        const sourcePixels = source.pixels.slice();
        for (let row = 0; row < dh; row++) {
          for (let col = 0; col < dw; col++) {
            const sourceX = Math.min(source.width - 1, Math.floor(sx + (col + 0.5) * sw / dw));
            const sourceY = Math.min(source.height - 1, Math.floor(sy + (row + 0.5) * sh / dh));
            canvas.pixels[(dy + row) * canvas.width + dx + col] = sourcePixels[sourceY * source.width + sourceX];
          }
        }
      },
    };
  }
}

test('atlas gutters and corners repeat each photograph edge, and sampleRect addresses texel centres', async () => {
  const { photos } = await loadLocalPhotos([imageFile(90, 60, 0), imageFile(90, 60, 1)]);
  albums.push(photos);
  globalThis.document = { createElement: () => new PixelCanvas() };
  let seed = 0;
  globalThis.createImageBitmap = async (blob, options) => {
    const bitmap = { width: options.resizeWidth, height: options.resizeHeight, close() {} };
    const tone = ++seed * 37;
    bitmap.pixels = Uint32Array.from({ length: bitmap.width * bitmap.height }, (_, index) => {
      const x = index % bitmap.width;
      const y = Math.floor(index / bitmap.width);
      return (0xff000000 | ((x + 1) << 16) | ((y + 1) << 8) | tone) >>> 0;
    });
    return bitmap;
  };
  const [atlas] = await buildPhotoAtlases(photos, null, { cellSize: 64, maxTextureSize: 2048, decodeConcurrency: 1 });
  const { cellRect: rect, sampleRect, canvas } = atlas;
  const pixel = (x, y) => canvas.pixels[y * canvas.width + x];
  for (let slot = 0; slot < 2; slot++) {
    const origin = slot * rect.size;
    for (let y = 0; y < rect.size; y++) {
      for (let x = 0; x < rect.size; x++) {
        const edgeX = Math.max(rect.x, Math.min(rect.x + rect.width - 1, x));
        const edgeY = Math.max(rect.y, Math.min(rect.y + rect.height - 1, y));
        assert.equal(pixel(origin + x, y), pixel(origin + edgeX, edgeY));
      }
    }
  }
  assert.notEqual(pixel(0, 0), pixel(rect.size, 0));
  assert.equal(sampleRect.x, rect.x + 0.5);
  assert.equal(sampleRect.y, rect.y + 0.5);
  assert.equal(sampleRect.x + sampleRect.width, rect.x + rect.width - 0.5);
  assert.equal(sampleRect.y + sampleRect.height, rect.y + rect.height - 0.5);
});

test('preserveAspect keeps portrait, square and landscape slot proportions with full gutter extension', async () => {
  const { photos } = await loadLocalPhotos([imageFile(600, 900, 0), imageFile(800, 800, 1), imageFile(1200, 750, 2)]);
  albums.push(photos);
  globalThis.document = { createElement: () => new PixelCanvas() };
  globalThis.createImageBitmap = async (blob, options) => {
    const bitmap = { width: options.resizeWidth, height: options.resizeHeight, close() {} };
    bitmap.pixels = new Uint32Array(bitmap.width * bitmap.height).fill(0xff3388cc);
    return bitmap;
  };
  const [atlas] = await buildPhotoAtlases(photos, null, {
    cellSize: 64,
    maxTextureSize: 2048,
    decodeConcurrency: 1,
    preserveAspect: true,
  });
  assert.equal(atlas.slotRects.length, 3);
  assert.equal(atlas.slotSampleRects.length, 3);
  assert.ok(atlas.slotAspects[0] < 0.75, 'portrait slot keeps portrait aspect');
  assert.equal(atlas.slotAspects[1], 1, 'square slot keeps 1:1 aspect');
  assert.ok(atlas.slotAspects[2] > 1.5, 'landscape slot keeps landscape aspect');
  assert.ok(atlas.slotRects[0].height > atlas.slotRects[0].width);
  assert.equal(atlas.slotRects[1].width, atlas.slotRects[1].height);
  assert.ok(atlas.slotRects[2].width > atlas.slotRects[2].height);
});
