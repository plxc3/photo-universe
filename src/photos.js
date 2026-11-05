/**
 * Local-only photo loading and bounded texture preparation. No renderer dependency.
 * One atlas cell represents one successfully decoded photo. A renderer can repeat
 * those cells across particles without changing the number of unique photos.
 */
import { extractPhotoMood } from './post.js';

const MAX_PHOTOS = 3000;
const MAX_FILE_BYTES = 40 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 100_000_000;
const MAX_IMAGE_EDGE = 32768;
const ATLAS_COLUMNS = 16;
const ATLAS_CAPACITY = 256;
const MIB = 1024 * 1024;
const CELL_SIZES = [384, 256, 192, 128, 96, 64, 48, 32, 16];
const HEADER_BYTES = 512 * 1024;
const localFiles = new WeakMap();
const atlasCells = new WeakMap();
let importSequence = 0;
// Gallery pages request only the visible images. Keep their original-image
// decodes serial even when several gallery instances call this module at once.
const thumbnailQueue = [];
let thumbnailDecodeActive = false;

const yieldToBrowser = () => new Promise((resolve) => setTimeout(resolve, 0));

function reportProgress(callback, loaded, total) {
  if (typeof callback === 'function') callback({ loaded, total });
}

function demoBaseUrl(directory = 'editorial/') {
  const base = import.meta.env?.BASE_URL || '/';
  return new URL(directory, new URL(base, globalThis.location?.href || import.meta.url));
}

const EDITORIAL_TITLES = Object.freeze({
  'coast-analogue': '海岸银盐 · Coast Analogue',
  'sea-dark': '黑礁暗涌 · Dark Tide',
  'sea-mist': '雾海潮声 · Mist Breaker',
  'mountain-dividing-line': '云岭分界 · Ridge Divide',
  'architecture-geometry': '混凝土几何 · Concrete Geometry',
  'brutalist-figure': '粗野阶梯 · Brutalist Ascent',
  'alpine-mist': '高山薄雾 · Alpine Mist',
  'traveller-coast': '远岸行者 · Coastal Gazer',
  'architecture-triangle': '三角天际 · Brutalist Apex',
  'shore-grey': '灰岸微光 · Pale Shore',
  'sea-long-exposure': '慢门海浪 · Long Exposure Tide',
  'shore-analogue': '礁岸胶片 · Rocky Tideline',
  'mountain-switzerland': '雪峰幽影 · Helvetic Peak',
  'mountain-glishorn': '格利斯峰 · Clouded Glishorn',
  'road-fading': '雾隐长路 · Vanishing Road',
  'road-forest': '林间迷雾 · Fir Corridor',
  'train-window': '车窗掠影 · Carriage Frame',
  'train-traveller': '铁道凝望 · Window Passage',
  'train-woman': '列车旅人 · Quiet Compartment',
  'hand-on-glass': '玻璃微温 · Hand on Glass',
  'stairs-shadows': '光影阶梯 · Sunlit Steps',
  'stairs-metal': '金属扶栏 · Shadow Railings',
  'barbican-stairs': '巴比肯阶 · Barbican Stairs',
  'analogue-portrait': '银盐肖像 · Silver Portrait',
});

function parseArchiveTimestamp(entry) {
  if (Number.isInteger(entry?.capturedYear) && entry.capturedYear >= 1900 && entry.capturedYear <= 2100) {
    return {
      capturedYear: entry.capturedYear,
      capturedDate: entry.capturedDate || String(entry.capturedYear),
      dateSource: 'archive',
    };
  }
  const match = String(entry?.downloadUrl || '').match(/photo-(\d{10,13})-/);
  if (!match) return null;
  const raw = Number(match[1]);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const ms = raw < 1e11 ? raw * 1000 : raw;
  const date = new Date(ms);
  const year = date.getUTCFullYear();
  if (year < 1990 || year > 2100) return null;
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return {
    capturedYear: year,
    capturedDate: `${year}-${mm}-${dd}`,
    dateSource: 'archive',
  };
}

function mapDemoManifest(manifest, base, prefix, offset = 0, assignAspect = false) {
  const aspectCycle = [1.43, 0.75, 1.0, 1.5, 0.72, 1.33, 0.8, 1.43];
  return manifest.map((entry, index) => {
    const url = new URL(entry.file, base);
    // Demo assets are bundled locally. Credit links are metadata, never fetches.
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
      throw new Error('演示照片必须来自本地演示相册。');
    }
    const thumbnail = entry.thumbnailFile ? new URL(entry.thumbnailFile, base) : url;
    if (thumbnail.origin !== base.origin || !thumbnail.pathname.startsWith(base.pathname)) {
      throw new Error('演示缩略图必须来自本地演示相册。');
    }
    const rawName = entry.name || `Photo ${offset + index + 1}`;
    const photo = {
      id: entry.id || `${prefix}-${offset + index + 1}`,
      name: rawName,
      title: entry.title || EDITORIAL_TITLES[rawName] || rawName,
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
    const stamp = parseArchiveTimestamp(entry);
    if (stamp) {
      photo.capturedYear = stamp.capturedYear;
      photo.capturedDate = stamp.capturedDate;
      photo.dateSource = stamp.dateSource;
    }
    if (assignAspect) photo.displayAspect = aspectCycle[index % aspectCycle.length];
    return photo;
  });
}

/** Returns demo metadata; images are read once when preparing the atlases. */
export async function loadDemoPhotos(onProgress, options = {}) {
  const base = demoBaseUrl('editorial/');
  const response = await fetch(new URL('manifest.json', base));
  if (!response.ok) throw new Error('无法读取演示相册，请确认照片资源已安装。');
  const manifest = await response.json();
  if (!Array.isArray(manifest)) throw new Error('演示相册清单格式无效。');
  let extraPhotos = [];
  if (options?.extended) {
    try {
      const archiveBase = demoBaseUrl('archive/');
      const archiveResponse = await fetch(new URL('manifest.json', archiveBase));
      if (archiveResponse.ok) {
        const archiveManifest = await archiveResponse.json();
        if (Array.isArray(archiveManifest) && archiveManifest.length) {
          extraPhotos = mapDemoManifest(archiveManifest, archiveBase, 'archive', manifest.length, false);
        }
      }
      if (!extraPhotos.length) {
        const collectionBase = demoBaseUrl('photos/');
        const collectionResponse = await fetch(new URL('manifest.json', collectionBase));
        if (collectionResponse.ok) {
          const collectionManifest = await collectionResponse.json();
          if (Array.isArray(collectionManifest)) {
            extraPhotos = mapDemoManifest(collectionManifest, collectionBase, 'collection', manifest.length, true);
          }
        }
      }
    } catch {
      // Optional supplementary local collection; editorial set remains sufficient.
    }
  }
  const editorialPhotos = mapDemoManifest(manifest, base, 'demo', 0, false);
  const combined = [...editorialPhotos, ...extraPhotos].slice(0, MAX_PHOTOS);
  reportProgress(onProgress, 0, combined.length);
  reportProgress(onProgress, combined.length, combined.length);
  return { photos: combined, skipped: 0 };
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

/** Extract underlying File/Blob objects for opt-in IndexedDB local persistence. */
export function extractLocalPhotoFiles(photos, indices = null) {
  const targetList = Array.isArray(indices)
    ? indices.map(idx => photos?.[idx]).filter(Boolean)
    : (photos || []);
  return targetList.map(photo => localFiles.get(photo)).filter(Boolean);
}

/** Group valid photos into descending capture-year chapters for timeline/gallery navigation. */
export function buildYearChapters(photos, validIndices) {
  const indices = Array.isArray(validIndices)
    ? validIndices
    : Array.from({ length: photos?.length || 0 }, (_, i) => i);
  const byYear = new Map();
  const undated = [];
  for (const photoIndex of indices) {
    const photo = photos?.[photoIndex];
    if (!photo) continue;
    const year = photo.capturedYear;
    if (Number.isInteger(year) && year >= 1900 && year <= 2100) {
      if (!byYear.has(year)) byYear.set(year, []);
      byYear.get(year).push(photoIndex);
    } else {
      undated.push(photoIndex);
    }
  }
  const chapters = [...byYear.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([year, list]) => ({
      key: String(year),
      year,
      label: `${year}`,
      count: list.length,
      firstPhotoIndex: list[0],
      photoIndices: list,
    }));
  if (undated.length && chapters.length) {
    chapters.push({
      key: 'undated',
      year: null,
      label: '未标年份',
      count: undated.length,
      firstPhotoIndex: undated[0],
      photoIndices: undated,
    });
  }
  return chapters;
}

function ascii(bytes, offset, length) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function parseExifDateString(raw) {
  const m = String(raw || '').replace(/\0+$/, '').trim().match(/^(\d{4})[:\-](\d{2})[:\-](\d{2})/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return {
    capturedYear: year,
    capturedDate: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

function readExifAsciiTag(view, bytes, tiff, end, entry, littleEndian) {
  if (view.getUint16(entry + 2, littleEndian) !== 2) return null;
  const count = view.getUint32(entry + 4, littleEndian);
  if (count < 10 || count > 64) return null;
  const valueOffset = count <= 4 ? entry + 8 : tiff + view.getUint32(entry + 8, littleEndian);
  if (valueOffset < tiff || valueOffset + count > end) return null;
  return ascii(bytes, valueOffset, count);
}

function parseExifSegment(view, bytes, offset, length) {
  // APP1 body: Exif\0\0, followed by a TIFF header, IFD0, and optional ExifIFD (0x8769).
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
  let orientation = null;
  let ifd0Date = null;
  let exifIfdOffset = null;

  for (let index = 0; index < count; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > end) break;
    const tag = view.getUint16(entry, littleEndian);
    if (tag === 0x0112
      && view.getUint16(entry + 2, littleEndian) === 3
      && view.getUint32(entry + 4, littleEndian) === 1) {
      const val = view.getUint16(entry + 8, littleEndian);
      if (val >= 1 && val <= 8) orientation = val;
    } else if (tag === 0x0132) {
      ifd0Date = parseExifDateString(readExifAsciiTag(view, bytes, tiff, end, entry, littleEndian)) || ifd0Date;
    } else if (tag === 0x8769
      && view.getUint16(entry + 2, littleEndian) === 4
      && view.getUint32(entry + 4, littleEndian) === 1) {
      exifIfdOffset = tiff + view.getUint32(entry + 8, littleEndian);
    }
  }

  let originalDate = null;
  let digitizedDate = null;
  if (exifIfdOffset !== null && exifIfdOffset >= tiff && exifIfdOffset + 2 <= end) {
    const subCount = view.getUint16(exifIfdOffset, littleEndian);
    for (let index = 0; index < subCount; index += 1) {
      const entry = exifIfdOffset + 2 + index * 12;
      if (entry + 12 > end) break;
      const tag = view.getUint16(entry, littleEndian);
      if (tag === 0x9003) {
        originalDate = parseExifDateString(readExifAsciiTag(view, bytes, tiff, end, entry, littleEndian)) || originalDate;
      } else if (tag === 0x9004) {
        digitizedDate = parseExifDateString(readExifAsciiTag(view, bytes, tiff, end, entry, littleEndian)) || digitizedDate;
      }
    }
  }

  const chosenDate = originalDate || digitizedDate || ifd0Date;
  return {
    orientation,
    capturedYear: chosenDate?.capturedYear ?? null,
    capturedDate: chosenDate?.capturedDate ?? null,
  };
}

async function readImageDimensions(blob) {
  const buffer = await blob.slice(0, HEADER_BYTES).arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (bytes.length < 10) return null;

  if (bytes.length >= 24 && view.getUint32(0) === 0x89504e47 && ascii(bytes, 12, 4) === 'IHDR') {
    const dims = { width: view.getUint32(16), height: view.getUint32(20) };
    let pngOffset = 8;
    while (pngOffset + 12 <= bytes.length) {
      const chunkLen = view.getUint32(pngOffset);
      const chunkType = ascii(bytes, pngOffset + 4, 4);
      const dataStart = pngOffset + 8;
      if (chunkType === 'tIME' && chunkLen >= 7 && dataStart + 7 <= bytes.length) {
        const year = view.getUint16(dataStart);
        const month = bytes[dataStart + 2];
        const day = bytes[dataStart + 3];
        if (year >= 1900 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
          dims.capturedYear = year;
          dims.capturedDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          dims.dateSource = 'exif';
        }
        break;
      }
      if (chunkType === 'IDAT' || chunkType === 'IEND' || chunkLen > bytes.length) break;
      pngOffset = dataStart + chunkLen + 4;
    }
    return dims;
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
    let capturedYear = null;
    let capturedDate = null;
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
      if (marker === 0xe1) {
        const exifMeta = parseExifSegment(view, bytes, offset + 2, length - 2);
        if (exifMeta) {
          orientation = exifMeta.orientation ?? orientation;
          capturedYear = exifMeta.capturedYear ?? capturedYear;
          capturedDate = exifMeta.capturedDate ?? capturedDate;
        }
      }
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)
        && length >= 7) {
        dimensions = { width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) };
      }
      offset += length;
    }
    if (dimensions && orientation >= 5 && orientation <= 8) {
      [dimensions.width, dimensions.height] = [dimensions.height, dimensions.width];
    }
    if (dimensions && capturedYear) {
      dimensions.capturedYear = capturedYear;
      dimensions.capturedDate = capturedDate;
      dimensions.dateSource = 'exif';
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
    : count <= 32 && !mobile && !lowMemory
      ? maxTextureSize >= 6144 ? 384 : maxTextureSize >= 4096 ? 256 : maxTextureSize >= 3072 ? 192 : 128
      : 128;
  const desired = positiveOption(options.cellSize, preferred, 'cellSize');
  const cellSize = CELL_SIZES.find(size => size <= desired && size * ATLAS_COLUMNS <= maxTextureSize
    && plannedCanvasBytes(count, size) <= maxAtlasBytes);
  if (!cellSize) throw new RangeError('照片数量超过当前纹理预算，请提高预算或减少照片。');
  const gutter = Math.max(1, Math.round(cellSize / 64));
  const width = cellSize - gutter * 2;
  const height = Math.max(1, Math.round(width / 1.5));
  const cellRect = Object.freeze({ x: gutter, y: Math.floor((cellSize - height) / 2), width, height, size: cellSize });
  // Geometry samples texel centres; painting and gallery extraction still use
  // cellRect's integer pixel extents. This keeps bilinear taps inside the print.
  const sampleRect = Object.freeze({ ...cellRect, x: cellRect.x + 0.5, y: cellRect.y + 0.5, width: width - 1, height: height - 1 });
  const thumbnailPixelBudget = Math.min(4_000_000, cellSize * cellSize * 32);
  const decodeConcurrency = Math.max(1, Math.min(4, Math.floor(positiveOption(options.decodeConcurrency,
    lowMemory ? 1 : mobile ? 2 : 3, 'decodeConcurrency'))));
  const decodePixelBudget = positiveOption(options.decodePixelBudget, (mobile || lowMemory ? 16 : 32) * 1_000_000, 'decodePixelBudget');
  let pixelsInFlight = 0;
  let activeDecodes = 0;
  const waiting = [];
  const preserveAspect = Boolean(options.preserveAspect);
  const budget = {
    cellSize, cellRect, sampleRect, preserveAspect, thumbnailPixelBudget, maximumThumbnailPixels: 0,
    columns: ATLAS_COLUMNS, maxTextureSize, maxAtlasBytes,
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
  // Decode for the useful 3:2 crop, not the source's longest edge. A tall image
  // otherwise loses most of its horizontal detail before drawCover crops it.
  // Bound the complete resized bitmap too: extreme panoramas must not turn a
  // small atlas cell into a multi-megapixel temporary allocation.
  const targetHeight = budget.preserveAspect ? budget.cellRect.width : budget.cellRect.height;
  const coverScale = Math.max(budget.cellRect.width / width, targetHeight / height) * 2;
  const scale = Math.min(1, coverScale, Math.sqrt(budget.thumbnailPixelBudget / (width * height)));
  let resizeWidth = Math.max(1, Math.floor(width * scale));
  let resizeHeight = Math.max(1, Math.floor(height * scale));
  if (resizeWidth * resizeHeight > budget.thumbnailPixelBudget) {
    // Rounding an extremely thin source up to one pixel can exceed the area cap.
    if (resizeWidth > resizeHeight) resizeWidth = Math.floor(budget.thumbnailPixelBudget / resizeHeight);
    else resizeHeight = Math.floor(budget.thumbnailPixelBudget / resizeWidth);
  }
  const releaseDecode = await budget.acquireDecode(width * height);
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob, {
      resizeWidth,
      resizeHeight,
      resizeQuality: 'medium',
      imageOrientation: 'from-image',
    });
  } finally {
    // The resized bitmap is small; the native full-image decode is now finished.
    releaseDecode();
  }
  budget.maximumThumbnailPixels = Math.max(budget.maximumThumbnailPixels, bitmap.width * bitmap.height);
  if (photo.source !== 'demo' || !photo.width || !photo.height) {
    photo.width = width;
    photo.height = height;
  }
  if (dimensions.capturedYear) {
    photo.capturedYear = dimensions.capturedYear;
    photo.capturedDate = dimensions.capturedDate;
    photo.dateSource = dimensions.dateSource || 'exif';
  } else if (!photo.capturedYear && photo.source === 'local') {
    const fileRef = localFiles.get(photo);
    if (fileRef && Number.isFinite(fileRef.lastModified) && fileRef.lastModified > 0) {
      const d = new Date(fileRef.lastModified);
      const y = d.getFullYear();
      if (y >= 1990 && y <= 2100) {
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        photo.capturedYear = y;
        photo.capturedDate = `${y}-${mm}-${dd}`;
        photo.dateSource = 'mtime';
      }
    }
  }
  return bitmap;
}

function releaseCanvas(canvas) {
  canvas.width = 0;
  canvas.height = 0;
}

function slotCellRect(bitmap, photo, budget) {
  if (!budget.preserveAspect) return budget.cellRect;
  const rawAspect = Number.isFinite(photo?.displayAspect) && photo.displayAspect > 0
    ? photo.displayAspect
    : bitmap.width / Math.max(1, bitmap.height);
  const clamped = Math.max(0.68, Math.min(1.55, rawAspect));
  const maxExtent = budget.cellRect.width;
  const width = clamped >= 1 ? maxExtent : Math.max(2, Math.round(maxExtent * clamped));
  const height = clamped >= 1 ? Math.max(2, Math.round(maxExtent / clamped)) : maxExtent;
  const x = Math.floor((budget.cellSize - width) / 2);
  const y = Math.floor((budget.cellSize - height) / 2);
  return Object.freeze({ x, y, width, height, size: budget.cellSize });
}

function drawCover(context, bitmap, slot, budget, canvas, photo = null) {
  const { cellSize, columns } = budget;
  const cellRect = slotCellRect(bitmap, photo, budget);
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
  // Extend the already-resampled edge pixels across the cell's unused area.
  // Mipmaps and anisotropic filtering now see this photograph's own colours,
  // rather than a dark seam or a neighbouring photograph. No extra canvas.
  const left = x + cellRect.x;
  const top = y + cellRect.y;
  const right = left + cellRect.width;
  const bottom = top + cellRect.height;
  const rightGutter = cellSize - cellRect.x - cellRect.width;
  const bottomGutter = cellSize - cellRect.y - cellRect.height;
  context.drawImage(canvas, left, top, 1, cellRect.height, x, top, cellRect.x, cellRect.height);
  context.drawImage(canvas, right - 1, top, 1, cellRect.height, right, top, rightGutter, cellRect.height);
  // Copy the complete row after its horizontal gutters, including the corners.
  context.drawImage(canvas, x, top, cellSize, 1, x, y, cellSize, cellRect.y);
  context.drawImage(canvas, x, bottom - 1, cellSize, 1, x, bottom, cellSize, bottomGutter);
  return cellRect;
}

/**
 * Returns [{ canvas, photoIndices, cellRect, sampleRect, columns }]. Cell i maps to photos[photoIndices[i]].
 * cellRect describes the rectangular photo area within the budgeted cell; use it
 * for painting and extraction. sampleRect gives the first-to-last pixel centres
 * for computing texture UVs without sampling beyond the photograph's boundary.
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
      const slotRects = [];

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
                const usedRect = drawCover(context, result.value, photoIndices.length, budget, canvas, photo);
                photoIndices.push(photoIndex);
                slotRects.push(usedRect);
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
      const atlas = { canvas, photoIndices, cellRect: budget.cellRect, sampleRect: budget.sampleRect, columns: budget.columns };
      if (budget.preserveAspect) {
        atlas.slotRects = slotRects;
        atlas.slotSampleRects = slotRects.map(r => Object.freeze({ ...r, x: r.x + 0.5, y: r.y + 0.5, width: Math.max(1, r.width - 1), height: Math.max(1, r.height - 1) }));
        atlas.slotAspects = slotRects.map(r => r.width / r.height);
      }
      const finalCtx = canvas.getContext('2d', { alpha: false });
      if (typeof finalCtx?.getImageData === 'function' && canvas.width > 0 && canvas.height > 0) {
        try {
          const { data, width: cw } = finalCtx.getImageData(0, 0, canvas.width, canvas.height);
          const keys = photoIndices.map((photoIndex, slot) => {
            const rect = slotRects[slot] || budget.cellRect;
            const ox = (slot % budget.columns) * budget.cellSize + rect.x;
            const oy = Math.floor(slot / budget.columns) * budget.cellSize + rect.y;
            let rSum = 0, gSum = 0, bSum = 0, samples = 0;
            for (let sy = 0; sy < 5; sy++) {
              const py = oy + Math.floor(((sy + 0.5) * rect.height) / 5);
              for (let sx = 0; sx < 5; sx++) {
                const px = ox + Math.floor(((sx + 0.5) * rect.width) / 5);
                const idx = (py * cw + px) * 4;
                rSum += data[idx];
                gSum += data[idx + 1];
                bSum += data[idx + 2];
                samples++;
              }
            }
            if (samples) {
              const mood = extractPhotoMood(rSum / samples, gSum / samples, bSum / samples);
              photos[photoIndex].spectralKey = mood.spectralKey;
              photos[photoIndex].accentHex = mood.accentHex;
              photos[photoIndex].moodRgb = mood.moodRgb;
              photos[photoIndex].toneLabel = mood.toneLabel;
              return mood.spectralKey;
            }
            photos[photoIndex].spectralKey = 0.5;
            return 0.5;
          });
          atlas.slotSpectralKeys = keys;
        } catch {
          // Non-readable or synthetic test contexts fall back cleanly.
        }
      }
      atlases.push(atlas);
    }
    // Publish thumbnail references only after the complete build succeeds.
    for (const atlas of atlases) {
      atlas.photoIndices.forEach((photoIndex, slot) => {
        atlasCells.set(photos[photoIndex], {
          canvas: atlas.canvas,
          slot,
          columns: atlas.columns,
          rect: atlas.slotRects?.[slot] || atlas.cellRect,
        });
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
        thumbnailPixelBudget: budget.thumbnailPixelBudget, maximumThumbnailPixels: budget.maximumThumbnailPixels,
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
 * Local albums reuse the existing atlas by default. With { quality: true },
 * decode only this visible photograph from the local original, at its native
 * aspect ratio and at most 720px on its longest edge (360px by default). Quality
 * requests share one serial queue and support AbortSignal cancellation.
 * The caller owns a returned blob: URL and must revoke it when the page closes.
 * Demo images use their bundled thumbnail URL. Without a live local original or
 * atlas, fall back to the existing image URL (which this function does not own).
 */
export async function getPhotoThumbnail(photo, maxEdge = 360, options = {}) {
  throwIfAborted(options.signal);
  if (photo.source === 'demo') return { url: photo.thumbnailUrl || photo.url, owned: false };
  if (options.quality && localFiles.has(photo)) {
    const edge = Math.min(720, positiveOption(maxEdge, 360, 'maxEdge'));
    return queueThumbnail(() => createQualityThumbnail(photo, edge, options.signal), options.signal);
  }
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
    throwIfAborted(options.signal);
    return { url: URL.createObjectURL(blob), owned: true };
  } finally {
    releaseCanvas(canvas);
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException('照片缩略图请求已取消。', 'AbortError');
}

function queueThumbnail(task, signal) {
  return new Promise((resolve, reject) => {
    const request = { task, resolve, reject, signal, started: false };
    request.onAbort = () => {
      if (request.started) return; // createImageBitmap has no native abort API.
      const index = thumbnailQueue.indexOf(request);
      if (index !== -1) thumbnailQueue.splice(index, 1);
      signal.removeEventListener('abort', request.onAbort);
      reject(new DOMException('照片缩略图请求已取消。', 'AbortError'));
    };
    signal?.addEventListener('abort', request.onAbort, { once: true });
    thumbnailQueue.push(request);
    // Abort may occur between the public precheck and listener registration.
    if (signal?.aborted) request.onAbort();
    pumpThumbnailQueue();
  });
}

function pumpThumbnailQueue() {
  if (thumbnailDecodeActive || !thumbnailQueue.length) return;
  const request = thumbnailQueue.shift();
  request.started = true;
  thumbnailDecodeActive = true;
  Promise.resolve().then(request.task).then(request.resolve, request.reject).finally(() => {
    request.signal?.removeEventListener('abort', request.onAbort);
    thumbnailDecodeActive = false;
    pumpThumbnailQueue();
  });
}

async function createQualityThumbnail(photo, edge, signal) {
  throwIfAborted(signal);
  const blob = localFiles.get(photo);
  if (!blob) throw new DOMException('照片相册已关闭。', 'AbortError');
  const dimensions = photo.width > 0 && photo.height > 0 ? photo : await readImageDimensions(blob);
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0
    || dimensions.width > MAX_IMAGE_EDGE || dimensions.height > MAX_IMAGE_EDGE
    || dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) {
    throw new Error('照片尺寸无效或超出解码预算。');
  }
  throwIfAborted(signal);
  if (!localFiles.has(photo)) throw new DOMException('照片相册已关闭。', 'AbortError');
  const scale = Math.min(1, edge / Math.max(dimensions.width, dimensions.height));
  let bitmap;
  let canvas;
  try {
    bitmap = await createImageBitmap(blob, {
      resizeWidth: Math.max(1, Math.round(dimensions.width * scale)),
      resizeHeight: Math.max(1, Math.round(dimensions.height * scale)),
      resizeQuality: 'high',
      imageOrientation: 'from-image',
    });
    throwIfAborted(signal);
    if (!localFiles.has(photo)) throw new DOMException('照片相册已关闭。', 'AbortError');
    canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('浏览器无法创建照片缩略图。');
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    bitmap = null;
    const thumbnail = await new Promise((resolve, reject) => canvas.toBlob(value => {
      if (value) resolve(value);
      else reject(new Error('照片缩略图生成失败。'));
    }, 'image/jpeg', 0.9));
    throwIfAborted(signal);
    if (!localFiles.has(photo)) throw new DOMException('照片相册已关闭。', 'AbortError');
    return { url: URL.createObjectURL(thumbnail), owned: true };
  } catch (error) {
    throwIfAborted(signal);
    throw error;
  } finally {
    bitmap?.close();
    if (canvas) releaseCanvas(canvas);
  }
}
