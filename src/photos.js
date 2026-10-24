/**
 * Local-only photo loading and bounded texture preparation. No renderer dependency.
 * One atlas cell represents one successfully decoded photo. A renderer can repeat
 * those cells across particles without changing the number of unique photos.
 */
const MAX_PHOTOS = 3000;
const MAX_FILE_BYTES = 40 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 100_000_000;
const MAX_IMAGE_EDGE = 32768;
const ATLAS_COLUMNS = 16;
const ATLAS_CAPACITY = 256;
const MIB = 1024 * 1024;
const CELL_SIZES = [192, 128, 96, 64, 48, 32, 16];
const HEADER_BYTES = 512 * 1024;
const localFiles = new WeakMap();
const atlasCells = new WeakMap();
let importSequence = 0;

const yieldToBrowser = () => new Promise((resolve) => setTimeout(resolve, 0));

function reportProgress(callback, loaded, total) {
  if (typeof callback === 'function') callback({ loaded, total });
}

function demoBaseUrl() {
  const base = import.meta.env?.BASE_URL || '/';
  return new URL('editorial/', new URL(base, globalThis.location?.href || import.meta.url));
}

/** Returns demo metadata; images are read once when preparing the atlases. */
export async function loadDemoPhotos(onProgress) {
  const base = demoBaseUrl();
  const response = await fetch(new URL('manifest.json', base));
  if (!response.ok) throw new Error('无法读取演示相册，请确认照片资源已安装。');
  const manifest = await response.json();
  if (!Array.isArray(manifest)) throw new Error('演示相册清单格式无效。');
  const entries = manifest.slice(0, MAX_PHOTOS);
  reportProgress(onProgress, 0, entries.length);
  const photos = entries.map((entry, index) => {
    const url = new URL(entry.file, base);
    // Demo assets are bundled locally. Credit links are metadata, never fetches.
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
      throw new Error('演示照片必须来自本地演示相册。');
    }
    const thumbnail = entry.thumbnailFile ? new URL(entry.thumbnailFile, base) : url;
    if (thumbnail.origin !== base.origin || !thumbnail.pathname.startsWith(base.pathname)) {
      throw new Error('演示缩略图必须来自本地演示相册。');
    }
    return {
      id: entry.id || `demo-${index + 1}`,
      name: entry.name || `Photo ${index + 1}`,
      url: url.href,
      thumbnailUrl: thumbnail.href,
      width: entry.width,
      height: entry.height,
      source: 'demo',
      author: entry.author,
      authorHandle: entry.authorHandle,
      sourceUrl: entry.sourceUrl,
      category: entry.category,
      license: entry.license,
      licenseUrl: entry.licenseUrl,
    };
  });
  reportProgress(onProgress, photos.length, photos.length);
  return { photos, skipped: 0 };
}

/**
 * Import metadata and object URLs only: do not decode a large album twice.
 * Local dimensions start at zero and are populated during atlas preparation.
 * Unsupported and corrupt images are reported by buildPhotoAtlases.diagnostics.
 */
export async function loadLocalPhotos(files, onProgress) {
  const candidates = Array.from(files || []);
  const photos = [];
  const skippedDetails = [];
  const batchId = ++importSequence;
  reportProgress(onProgress, 0, candidates.length);

  for (let index = 0; index < candidates.length; index += 1) {
    const file = candidates[index];
    const mime = (file.type || '').toLowerCase();
    const hasImageExtension = /\.(?:jpe?g|png|webp|gif|bmp|avif|heic|heif|svg|ico|tiff?)$/i.test(file.name || '');
    const isImage = mime.startsWith('image/')
      || ((!mime || mime === 'application/octet-stream') && hasImageExtension);
    let reason;
    if (!isImage) reason = '非图片文件';
    else if (!file.size) reason = '空文件';
    else if (file.size > MAX_FILE_BYTES) reason = '文件超过 40 MiB';
    else if (photos.length >= MAX_PHOTOS) reason = '超过 3000 张导入上限';

    if (reason) {
      skippedDetails.push({ name: file.name || '未命名文件', reason });
    } else {
      const photo = {
        id: `local-${batchId}-${index}`,
        name: file.name || `Photo ${index + 1}`,
        url: URL.createObjectURL(file),
        width: 0,
        height: 0,
        source: 'local',
      };
      localFiles.set(photo, file);
      photos.push(photo);
    }

    if ((index + 1) % 48 === 0 || index === candidates.length - 1) {
      reportProgress(onProgress, index + 1, candidates.length);
      await yieldToBrowser();
    }
  }
  return { photos, skipped: skippedDetails.length, skippedDetails };
}

/** Call only when a replaced album is no longer displayed. Safe to repeat. */
export function releasePhotos(photos) {
  for (const photo of photos || []) {
    atlasCells.delete(photo);
    if (photo.source === 'local' && photo.url?.startsWith('blob:')) {
      URL.revokeObjectURL(photo.url);
      localFiles.delete(photo);
    }
  }
}

function ascii(bytes, offset, length) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function exifOrientation(view, offset, length) {
  // APP1 body: Exif\0\0, followed by a TIFF header and IFD0.
  const end = Math.min(view.byteLength, offset + length);
  if (offset + 14 > end || view.getUint32(offset) !== 0x45786966 || view.getUint16(offset + 4) !== 0) return null;
  const tiff = offset + 6;
  const byteOrder = view.getUint16(tiff);
  if (byteOrder !== 0x4949 && byteOrder !== 0x4d4d) return null;
  const littleEndian = byteOrder === 0x4949;
  if (view.getUint16(tiff + 2, littleEndian) !== 42) return null;
  const ifd = tiff + view.getUint32(tiff + 4, littleEndian);
  if (ifd + 2 > end || ifd < tiff) return null;
  const count = view.getUint16(ifd, littleEndian);
  for (let index = 0; index < count; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > end) break;
    if (view.getUint16(entry, littleEndian) === 0x0112
      && view.getUint16(entry + 2, littleEndian) === 3
      && view.getUint32(entry + 4, littleEndian) === 1) {
      const orientation = view.getUint16(entry + 8, littleEndian);
      return orientation >= 1 && orientation <= 8 ? orientation : null;
    }
  }
  return null;
}

async function readImageDimensions(blob) {
  const buffer = await blob.slice(0, HEADER_BYTES).arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (bytes.length < 10) return null;

  if (bytes.length >= 24 && view.getUint32(0) === 0x89504e47 && ascii(bytes, 12, 4) === 'IHDR') {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (/^GIF8[79]a$/.test(ascii(bytes, 0, 6))) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (bytes.length >= 26 && ascii(bytes, 0, 2) === 'BM') {
    const dibSize = view.getUint32(14, true);
    if (dibSize === 12) return { width: view.getUint16(18, true), height: view.getUint16(20, true) };
    return { width: Math.abs(view.getInt32(18, true)), height: Math.abs(view.getInt32(22, true)) };
  }
  if (bytes.length >= 8 && view.getUint32(0) === 0x00000100) {
    return { width: bytes[6] || 256, height: bytes[7] || 256 };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    let dimensions;
    let orientation = 1;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) break;
      while (bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      // APP1 also carries XMP; a non-EXIF segment must not reset prior EXIF.
      if (marker === 0xe1) orientation = exifOrientation(view, offset + 2, length - 2) ?? orientation;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)
        && length >= 7) {
        dimensions = { width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) };
      }
      offset += length;
    }
    if (dimensions && orientation >= 5 && orientation <= 8) {
      [dimensions.width, dimensions.height] = [dimensions.height, dimensions.width];
    }
    return dimensions || null;
  }
  if (bytes.length >= 30 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const type = ascii(bytes, offset, 4);
      const size = view.getUint32(offset + 4, true);
      const start = offset + 8;
      if (type === 'VP8X' && size >= 10 && start + 10 <= bytes.length) {
        const uint24 = (index) => bytes[index] | (bytes[index + 1] << 8) | (bytes[index + 2] << 16);
        return { width: uint24(start + 4) + 1, height: uint24(start + 7) + 1 };
      }
      if (type === 'VP8 ' && size >= 10 && start + 10 <= bytes.length && bytes[start + 3] === 0x9d && bytes[start + 4] === 0x01 && bytes[start + 5] === 0x2a) {
        return { width: view.getUint16(start + 6, true) & 0x3fff, height: view.getUint16(start + 8, true) & 0x3fff };
      }
      if (type === 'VP8L' && size >= 5 && start + 5 <= bytes.length && bytes[start] === 0x2f) {
        const bits = view.getUint32(start + 1, true);
        return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      }
      if (start + size > bytes.length) break;
      offset = start + size + (size % 2);
    }
  }
  // AVIF/HEIF images expose their spatial extent in an ISO BMFF ispe box.
  if (bytes.length >= 24 && ascii(bytes, 4, 4) === 'ftyp') {
    for (let offset = 8; offset + 16 <= bytes.length; offset += 1) {
      if (bytes[offset] === 0x69 && bytes[offset + 1] === 0x73 && bytes[offset + 2] === 0x70
        && bytes[offset + 3] === 0x65 && view.getUint32(offset - 4) >= 20) {
        return { width: view.getUint32(offset + 8), height: view.getUint32(offset + 12) };
      }
    }
  }
  if (blob.type === 'image/svg+xml' || ascii(bytes, 0, 128).includes('<svg')) {
    const text = new TextDecoder().decode(bytes);
    const svgTag = text.match(/<svg\b[^>]*>/i)?.[0];
    const viewBox = svgTag?.match(/\sviewBox\s*=\s*["']([^"']+)["']/i)?.[1].trim().split(/[\s,]+/).map(Number);
    const width = Number(svgTag?.match(/\swidth\s*=\s*["']([\d.]+)(?:px)?["']/i)?.[1]);
    const height = Number(svgTag?.match(/\sheight\s*=\s*["']([\d.]+)(?:px)?["']/i)?.[1]);
    if (width && height) return { width, height };
    if (viewBox?.length === 4) return { width: viewBox[2], height: viewBox[3] };
  }
  return null;
}

function positiveOption(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} 必须是正数。`);
  return value;
}

function plannedCanvasBytes(count, cellSize) {
  // Capacity is a multiple of columns, so summing each atlas's rounded rows
  // gives the same result as rounding the full candidate count once.
  return Math.ceil(count / ATLAS_COLUMNS) * ATLAS_COLUMNS * cellSize * cellSize * 4;
}

function atlasBudget(count, options) {
  const mobile = options.mobile ?? Boolean(globalThis.matchMedia?.('(pointer: coarse)').matches);
  const memory = options.deviceMemoryGB ?? globalThis.navigator?.deviceMemory;
  const lowMemory = Number.isFinite(memory) && memory <= 2;
  const maxTextureSize = Math.floor(positiveOption(options.maxTextureSize, 2048, 'maxTextureSize'));
  const maxAtlasBytes = positiveOption(options.maxAtlasBytes, (lowMemory ? 32 : mobile ? 48 : 64) * MIB, 'maxAtlasBytes');
  const preferred = count > ATLAS_CAPACITY ? (lowMemory ? 48 : 64)
    : count <= 32 && !mobile && maxTextureSize >= 3072 ? 192 : 128;
  const desired = positiveOption(options.cellSize, preferred, 'cellSize');
  const cellSize = CELL_SIZES.find(size => size <= desired && size * ATLAS_COLUMNS <= maxTextureSize
    && plannedCanvasBytes(count, size) <= maxAtlasBytes);
  if (!cellSize) throw new RangeError('照片数量超过当前纹理预算，请提高预算或减少照片。');
  const gutter = Math.max(1, Math.round(cellSize / 64));
  const width = cellSize - gutter * 2;
  const height = Math.max(1, Math.round(width / 1.5));
  const cellRect = Object.freeze({ x: gutter, y: Math.floor((cellSize - height) / 2), width, height, size: cellSize });
  const decodeConcurrency = Math.max(1, Math.min(4, Math.floor(positiveOption(options.decodeConcurrency,
    lowMemory ? 1 : mobile ? 2 : 3, 'decodeConcurrency'))));
  const decodePixelBudget = positiveOption(options.decodePixelBudget, (mobile || lowMemory ? 16 : 32) * 1_000_000, 'decodePixelBudget');
  let pixelsInFlight = 0;
  let activeDecodes = 0;
  const waiting = [];
  const budget = {
    cellSize, cellRect, columns: ATLAS_COLUMNS, maxTextureSize, maxAtlasBytes,
    decodeConcurrency, decodePixelBudget, maximumConcurrentDecodes: 0, maximumDecodePixels: 0,
    async acquireDecode(pixels) {
      await new Promise(resolve => { waiting.push({ pixels, resolve }); pump(); });
      return () => { pixelsInFlight -= pixels; activeDecodes -= 1; pump(); };
    },
  };
  function pump() {
    while (waiting.length && activeDecodes < decodeConcurrency) {
      const next = waiting[0];
      // A single accepted image may exceed this estimate. Run it alone instead
      // of leaving the queue permanently blocked; the 100MP guard still applies.
      if (activeDecodes && pixelsInFlight + next.pixels > decodePixelBudget) break;
      waiting.shift();
      pixelsInFlight += next.pixels;
      activeDecodes += 1;
      budget.maximumConcurrentDecodes = Math.max(budget.maximumConcurrentDecodes, activeDecodes);
      budget.maximumDecodePixels = Math.max(budget.maximumDecodePixels, pixelsInFlight);
      next.resolve();
    }
  }
  return budget;
}

async function decodeThumbnail(photo, budget) {
  let blob = localFiles.get(photo);
  if (!blob) {
    // The bundled 440px version already exceeds the atlas resolution. Keep
    // full photographs for the lightbox instead of downloading all of them.
    const response = await fetch(photo.source === 'demo' ? photo.thumbnailUrl || photo.url : photo.url);
    if (!response.ok) throw new Error('照片资源读取失败');
    blob = await response.blob();
  }
  if (!blob.size || blob.size > MAX_FILE_BYTES) throw new Error('空文件或文件超过 40 MiB');
  const dimensions = await readImageDimensions(blob);
  if (!dimensions) throw new Error('不支持的图片格式或图片文件损坏');
  const { width, height } = dimensions;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('图片尺寸无效');
  }
  if (width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE || width * height > MAX_IMAGE_PIXELS) {
    throw new Error('图片超过 1 亿像素或 32768 px 边长');
  }
  const scale = Math.min(1, (budget.cellSize * 2) / Math.max(width, height));
  const releaseDecode = await budget.acquireDecode(width * height);
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob, {
      resizeWidth: Math.max(1, Math.round(width * scale)),
      resizeHeight: Math.max(1, Math.round(height * scale)),
      resizeQuality: 'medium',
      imageOrientation: 'from-image',
    });
  } finally {
    // The resized bitmap is small; the native full-image decode is now finished.
    releaseDecode();
  }
  if (photo.source !== 'demo' || !photo.width || !photo.height) {
    photo.width = width;
    photo.height = height;
  }
  return bitmap;
}

function releaseCanvas(canvas) {
  canvas.width = 0;
  canvas.height = 0;
}

function drawCover(context, bitmap, slot, budget) {
  const { cellSize, cellRect, columns } = budget;
  const x = (slot % columns) * cellSize;
  const y = Math.floor(slot / columns) * cellSize;
  const targetAspect = cellRect.width / cellRect.height;
  const sourceAspect = bitmap.width / bitmap.height;
  const sourceWidth = sourceAspect > targetAspect ? bitmap.height * targetAspect : bitmap.width;
  const sourceHeight = sourceAspect > targetAspect ? bitmap.height : bitmap.width / targetAspect;
  context.fillStyle = '#05070c';
  context.fillRect(x, y, cellSize, cellSize);
  context.drawImage(bitmap, (bitmap.width - sourceWidth) / 2, (bitmap.height - sourceHeight) / 2,
    sourceWidth, sourceHeight, x + cellRect.x, y + cellRect.y, cellRect.width, cellRect.height);
}

/**
 * Returns [{ canvas, photoIndices, cellRect, columns }]. Cell i maps to photos[photoIndices[i]].
 * cellRect describes the rectangular photo area within the budgeted cell; use it
 * when computing texture UVs so landscape cards preserve their proportions.
 * Corrupt files are excluded, preserving deterministic input ordering.
 * Options (all optional): maxTextureSize (renderer.capabilities.maxTextureSize;
 * conservative default 2048), maxAtlasBytes (CPU atlas budget), cellSize (upper
 * bound), mobile, deviceMemoryGB, decodeConcurrency (1–4), decodePixelBudget.
 * A non-enumerable diagnostics property exposes counts and actual canvas bytes.
 * A native decode larger than decodePixelBudget runs alone. Successful canvases
 * belong to the renderer; every canvas is released if the build throws.
 */
export async function buildPhotoAtlases(photos, onProgress, options = {}) {
  const budget = atlasBudget(photos.length, options);
  const atlases = [];
  const skipped = [];
  const createdCanvases = new Set();
  let peakCanvasBytes = 0;
  let loaded = 0;
  let decodedCount = 0;
  const canvasBytes = () => [...createdCanvases].reduce((sum, canvas) => sum + canvas.width * canvas.height * 4, 0);
  function createCanvas(count) {
    const canvas = document.createElement('canvas');
    createdCanvases.add(canvas); // Register before sizing or obtaining a context.
    canvas.width = budget.columns * budget.cellSize;
    canvas.height = Math.ceil(count / budget.columns) * budget.cellSize;
    peakCanvasBytes = Math.max(peakCanvasBytes, canvasBytes());
    return canvas;
  }
  try {
    reportProgress(onProgress, 0, photos.length);
    for (let start = 0; start < photos.length; start += ATLAS_CAPACITY) {
      const end = Math.min(start + ATLAS_CAPACITY, photos.length);
      let canvas = createCanvas(end - start);
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('浏览器无法创建照片图册。');
      const photoIndices = [];

      for (let offset = start; offset < end; offset += budget.decodeConcurrency) {
        const batchEnd = Math.min(offset + budget.decodeConcurrency, end);
        const batchIndices = Array.from({ length: batchEnd - offset }, (_, index) => offset + index);
        const results = await Promise.allSettled(batchIndices.map(index => decodeThumbnail(photos[index], budget)));
        try {
          for (let index = 0; index < results.length; index += 1) {
            const result = results[index];
            const photoIndex = batchIndices[index];
            const photo = photos[photoIndex];
            if (result.status === 'fulfilled') {
              try {
                drawCover(context, result.value, photoIndices.length, budget);
                photoIndices.push(photoIndex);
                decodedCount += 1;
              } catch (error) {
                skipped.push({ id: photo.id, name: photo.name, reason: error?.message || '图片绘制失败' });
              }
            } else {
              skipped.push({ id: photo.id, name: photo.name, reason: result.reason?.message || '图片解码失败' });
            }
            loaded += 1;
          }
          reportProgress(onProgress, loaded, photos.length);
        } finally {
          for (const result of results) if (result.status === 'fulfilled') result.value.close();
        }
        await yieldToBrowser();
      }

      if (!photoIndices.length) { releaseCanvas(canvas); continue; }
      const requiredHeight = Math.ceil(photoIndices.length / budget.columns) * budget.cellSize;
      if (canvas.height !== requiredHeight) {
        const trimmed = createCanvas(photoIndices.length);
        const trimmedContext = trimmed.getContext('2d', { alpha: false });
        if (!trimmedContext) throw new Error('浏览器无法创建照片图册。');
        trimmedContext.drawImage(canvas, 0, 0);
        releaseCanvas(canvas);
        canvas = trimmed;
      }
      atlases.push({ canvas, photoIndices, cellRect: budget.cellRect, columns: budget.columns });
    }
    // Publish thumbnail references only after the complete build succeeds.
    for (const atlas of atlases) {
      atlas.photoIndices.forEach((photoIndex, slot) => {
        atlasCells.set(photos[photoIndex], { canvas: atlas.canvas, slot, columns: atlas.columns, rect: atlas.cellRect });
      });
    }
    const bytes = canvasBytes();
    Object.defineProperty(atlases, 'diagnostics', {
      value: {
        inputCount: photos.length, decodedCount, skippedCount: skipped.length, skipped,
        cellSize: budget.cellSize, columns: budget.columns, maxTextureSize: budget.maxTextureSize,
        maxAtlasBytes: budget.maxAtlasBytes, canvasBytes: bytes, peakCanvasBytes,
        estimatedTextureBytes: Math.ceil(bytes * 4 / 3),
        decodeConcurrency: budget.decodeConcurrency, decodePixelBudget: budget.decodePixelBudget,
        maximumConcurrentDecodes: budget.maximumConcurrentDecodes, maximumDecodePixels: budget.maximumDecodePixels,
      },
      enumerable: false,
    });
    return atlases;
  } catch (error) {
    for (const canvas of createdCanvases) releaseCanvas(canvas);
    throw error;
  }
}

/**
 * Local albums reuse the existing atlas: no second full-image decode. The caller
 * owns a returned blob: URL and must revoke it when its gallery page closes.
 * Demo images use their bundled thumbnail URL. Before/after atlas availability,
 * fall back to the existing image URL (which this function does not own).
 */
export async function getPhotoThumbnail(photo, maxEdge = 360) {
  if (photo.source === 'demo') return { url: photo.thumbnailUrl || photo.url, owned: false };
  const cell = atlasCells.get(photo);
  if (!cell?.canvas.width || !cell.canvas.height) return { url: photo.thumbnailUrl || photo.url, owned: false };
  const { canvas: source, slot, columns, rect } = cell;
  const edge = positiveOption(maxEdge, 360, 'maxEdge');
  const scale = Math.min(1, edge / Math.max(rect.width, rect.height));
  const canvas = document.createElement('canvas');
  try {
    canvas.width = Math.max(1, Math.round(rect.width * scale));
    canvas.height = Math.max(1, Math.round(rect.height * scale));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('浏览器无法创建照片缩略图。');
    context.drawImage(source, slot % columns * rect.size + rect.x, Math.floor(slot / columns) * rect.size + rect.y,
      rect.width, rect.height, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve, reject) => canvas.toBlob(value => {
      if (value) resolve(value);
      else reject(new Error('照片缩略图生成失败。'));
    }, 'image/jpeg', 0.85));
    return { url: URL.createObjectURL(blob), owned: true };
  } finally {
    releaseCanvas(canvas);
  }
}
