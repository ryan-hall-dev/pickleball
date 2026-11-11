// Test-only: decodes a clean QR module matrix (no camera image, no damage) so
// tests can prove what a QR code says without a decoder dependency. It reads
// the format bits, unmasks, walks the codewords in the standard zigzag
// order, de-interleaves the blocks and parses byte-mode segments. Error
// correction isn't applied: a matrix straight from the encoder has no
// errors. Versions 1-10 only (the check-in link needs about version 4).

/** Error correction codewords per block and blocks, at level M, versions 1-10. */
const LEVEL_M_BLOCKS: Record<
  number,
  { eccCodewordsPerBlock: number; blockCount: number }
> = {
  1: { eccCodewordsPerBlock: 10, blockCount: 1 },
  2: { eccCodewordsPerBlock: 16, blockCount: 1 },
  3: { eccCodewordsPerBlock: 26, blockCount: 1 },
  4: { eccCodewordsPerBlock: 18, blockCount: 2 },
  5: { eccCodewordsPerBlock: 24, blockCount: 2 },
  6: { eccCodewordsPerBlock: 16, blockCount: 4 },
  7: { eccCodewordsPerBlock: 18, blockCount: 4 },
  8: { eccCodewordsPerBlock: 22, blockCount: 4 },
  9: { eccCodewordsPerBlock: 22, blockCount: 5 },
  10: { eccCodewordsPerBlock: 26, blockCount: 5 },
};

const ERROR_CORRECTION_LEVEL_BY_FORMAT_BITS = ["M", "L", "H", "Q"] as const;
const FORMAT_MASK = 0x5412;
const BYTE_MODE = 0b0100;
const TERMINATOR_MODE = 0b0000;

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

export interface DecodedQrCode {
  text: string;
  errorCorrectionLevel: "L" | "M" | "Q" | "H";
  version: number;
}

/**
 * `modules[y][x]` is true for dark, without a quiet zone. `isDataModule`
 * says which modules carry codewords (not finder, timing, alignment,
 * format or version patterns).
 */
export function decodeQrModules(
  modules: boolean[][],
  isDataModule: (x: number, y: number) => boolean,
): DecodedQrCode {
  const size = modules.length;
  const version = (size - 17) / 4;
  const dark = (x: number, y: number) => modules[y][x];

  // Format bits, first copy, laid out as the encoder draws them.
  let formatBits = 0;
  const formatBit = (index: number, isDark: boolean) => {
    if (isDark) formatBits |= 1 << index;
  };
  for (let index = 0; index <= 5; index += 1) formatBit(index, dark(8, index));
  formatBit(6, dark(8, 7));
  formatBit(7, dark(8, 8));
  formatBit(8, dark(7, 8));
  for (let index = 9; index < 15; index += 1)
    formatBit(index, dark(14 - index, 8));
  const formatData = (formatBits ^ FORMAT_MASK) >> 10;
  const errorCorrectionLevel =
    ERROR_CORRECTION_LEVEL_BY_FORMAT_BITS[formatData >> 3];
  const isMasked = MASKS[formatData & 0b111];

  // Codeword bits in zigzag order, two columns at a time from the right.
  const bits: number[] = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical += 1) {
      for (let offset = 0; offset < 2; offset += 1) {
        const x = right - offset;
        const isUpward = ((right + 1) & 2) === 0;
        const y = isUpward ? size - 1 - vertical : vertical;
        if (!isDataModule(x, y)) continue;
        bits.push(dark(x, y) !== isMasked(x, y) ? 1 : 0);
      }
    }
  }
  const rawCodewordCount = Math.floor(bits.length / 8);
  const codewords = Array.from({ length: rawCodewordCount }, (_, index) =>
    bits
      .slice(index * 8, index * 8 + 8)
      .reduce((byte, bit) => (byte << 1) | bit, 0),
  );

  if (errorCorrectionLevel !== "M") {
    throw new Error(`Only level M is supported, got ${errorCorrectionLevel}.`);
  }
  const blockLayout = LEVEL_M_BLOCKS[version];
  if (!blockLayout) throw new Error(`Unsupported QR version ${version}.`);
  const { eccCodewordsPerBlock, blockCount } = blockLayout;
  const shortBlockCount = blockCount - (rawCodewordCount % blockCount);
  const shortBlockLength = Math.floor(rawCodewordCount / blockCount);
  const shortBlockDataLength = shortBlockLength - eccCodewordsPerBlock;

  // Undo the interleaving: short blocks skip the column long blocks have extra.
  const blocks: number[][] = Array.from({ length: blockCount }, () => []);
  let nextCodeword = 0;
  for (let column = 0; column <= shortBlockLength; column += 1) {
    for (let block = 0; block < blockCount; block += 1) {
      // The encoder pads short blocks with a placeholder at this column.
      if (column === shortBlockDataLength && block < shortBlockCount) continue;
      blocks[block].push(codewords[nextCodeword]);
      nextCodeword += 1;
    }
  }
  const dataCodewords = blocks.flatMap((block, blockIndex) =>
    block.slice(
      0,
      shortBlockDataLength + (blockIndex < shortBlockCount ? 0 : 1),
    ),
  );

  // Byte-mode segments up to the terminator.
  const dataBits = dataCodewords.flatMap((byte) =>
    Array.from({ length: 8 }, (_, index) => (byte >> (7 - index)) & 1),
  );
  let position = 0;
  const read = (bitCount: number) => {
    let value = 0;
    for (let index = 0; index < bitCount; index += 1) {
      value = (value << 1) | dataBits[position];
      position += 1;
    }
    return value;
  };
  const bytes: number[] = [];
  while (position + 4 <= dataBits.length) {
    const mode = read(4);
    if (mode === TERMINATOR_MODE) break;
    if (mode !== BYTE_MODE) throw new Error(`Unsupported QR mode ${mode}.`);
    const byteCount = read(version <= 9 ? 8 : 16);
    for (let index = 0; index < byteCount; index += 1) bytes.push(read(8));
  }
  return {
    text: new TextDecoder("utf-8", { fatal: true }).decode(
      new Uint8Array(bytes),
    ),
    errorCorrectionLevel,
    version,
  };
}
