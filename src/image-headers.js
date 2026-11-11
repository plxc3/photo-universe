/**
 * Zero-dependency binary image header & archival timestamp parsers.
 * Extracts pixel dimensions, EXIF orientation, and capture dates (JPEG APP1 EXIF
 * II/MM, PNG tIME, WebP VP8/VP8L/VP8X, AVIF/HEIF ispe, GIF, BMP, ICO, SVG)
 * from only the first 512 KiB of a Blob without decoding full bitmaps.
 */

const HEADER_BYTES = 512 * 1024;

function ascii(bytes, offset, length) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

export function parseArchiveTimestamp(entry) {
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

export async function readImageDimensions(blob) {
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
