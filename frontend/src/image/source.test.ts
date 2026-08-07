import { afterEach, describe, expect, it, vi } from "vitest";

import { orientationTransform } from "./exif";
import {
  DEFAULT_SOURCE_LIMITS,
  loadSourceImage,
  SourceLoadError,
  TOTAL_BITMAP_BUDGET_BYTES,
} from "./source";
import type { SourceImageDeps } from "./source";

function jpegBytes(width: number, height: number, orientation?: number): Uint8Array {
  const hiLo = (v: number): number[] => [(v >> 8) & 0xff, v & 0xff];
  const seg = (marker: number, payload: number[]): number[] => [
    0xff,
    marker,
    ...hiLo(payload.length + 2),
    ...payload,
  ];
  const tiff = new Array<number>(26).fill(0);
  tiff[0] = 0x49;
  tiff[1] = 0x49;
  tiff[2] = 0x2a;
  tiff[4] = 8;
  tiff[8] = 1;
  tiff[10] = 0x12;
  tiff[11] = 0x01;
  tiff[12] = 3;
  tiff[14] = 1;
  tiff[18] = orientation ?? 1;
  const parts: number[] = [0xff, 0xd8];
  parts.push(...seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 0, 0]));
  parts.push(...seg(0xe1, [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff]));
  parts.push(...seg(0xc0, [8, ...hiLo(height), ...hiLo(width), 1, 0x11, 0x00, 0x00, 0x00]));
  parts.push(0xff, 0xd9);
  return new Uint8Array(parts);
}

function heicBytes(): Uint8Array {
  return new Uint8Array([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0]);
}

function makeFile(bytes: Uint8Array, name = "photo.jpg", type = "image/jpeg"): File {
  return new File([bytes as BlobPart], name, { type });
}

interface FakeDeps {
  createImageBitmap: ReturnType<typeof vi.fn>;
  createCanvas: ReturnType<typeof vi.fn>;
  canvasContext: ReturnType<typeof vi.fn>;
  ctx: { setTransform: ReturnType<typeof vi.fn>; drawImage: ReturnType<typeof vi.fn> };
  canvas: { width: number; height: number };
}

function makeDeps(opts: { rawW: number; rawH: number; failFirstDecode?: boolean }): FakeDeps {
  const ctx = { setTransform: vi.fn(), drawImage: vi.fn() };
  const canvas = { width: 0, height: 0 };
  let firstCall = true;
  const createImageBitmap = vi.fn(async (source: Blob | { width: number; height: number }) => {
    if (firstCall && opts.failFirstDecode) {
      firstCall = false;
      throw new TypeError("ImageBitmapOptions not supported");
    }
    firstCall = false;
    const width = "size" in source ? opts.rawW : source.width;
    const height = "size" in source ? opts.rawH : source.height;
    return { width, height, close: vi.fn() };
  });
  const createCanvas = vi.fn((w: number, h: number) => {
    canvas.width = w;
    canvas.height = h;
    return { width: w, height: h, getContext: () => ctx };
  });
  const canvasContext = vi.fn(() => ctx);
  return { createImageBitmap, createCanvas, canvasContext, ctx, canvas };
}

const revokeSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

/** vi.fn's Mock type is contravariant-incompatible with SourceImageDeps's
 * parameters; tests call through this cast. */
function load(file: File, deps: FakeDeps) {
  return loadSourceImage(file, undefined, deps as unknown as SourceImageDeps);
}

afterEach(() => {
  vi.clearAllMocks();
  revokeSpy.mockClear();
});

describe("loadSourceImage limits (SRC-002)", () => {
  it("rejects files over maxBytes before reading headers", async () => {
    const file = makeFile(new Uint8Array(DEFAULT_SOURCE_LIMITS.maxBytes + 1));
    const deps = makeDeps({ rawW: 100, rawH: 100 });
    await expect(load(file, deps)).rejects.toMatchObject({
      kind: "file-too-large",
    });
    expect(deps.createImageBitmap).not.toHaveBeenCalled();
  });

  it("rejects over-megapixel sources before decoding", async () => {
    const file = makeFile(jpegBytes(6001, 4000)); // 24.004 MP
    const deps = makeDeps({ rawW: 6001, rawH: 4000 });
    await expect(load(file, deps)).rejects.toMatchObject({
      kind: "dimension-too-large",
    });
    expect(deps.createImageBitmap).not.toHaveBeenCalled();
  });

  it("rejects over-edge sources before decoding", async () => {
    const file = makeFile(jpegBytes(8001, 100));
    const deps = makeDeps({ rawW: 8001, rawH: 100 });
    await expect(load(file, deps)).rejects.toMatchObject({
      kind: "dimension-too-large",
    });
    expect(deps.createImageBitmap).not.toHaveBeenCalled();
  });
});

describe("loadSourceImage format handling (SRC-001, SRC-004)", () => {
  it("rejects unknown magic bytes", async () => {
    const file = makeFile(
      new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
      "x.bin",
      "image/jpeg",
    );
    const deps = makeDeps({ rawW: 1, rawH: 1 });
    await expect(load(file, deps)).rejects.toMatchObject({
      kind: "unsupported-format",
    });
  });

  it("rejects HEIC with explicit guidance", async () => {
    const file = makeFile(heicBytes(), "photo.heic", "image/heic");
    const deps = makeDeps({ rawW: 1, rawH: 1 });
    await expect(load(file, deps)).rejects.toMatchObject({
      kind: "heif-unsupported",
    });
  });
});

describe("loadSourceImage normalization (SRC-003)", () => {
  it("normalizes EXIF orientation 6 into the canvas transform", async () => {
    const file = makeFile(jpegBytes(400, 300, 6));
    const deps = makeDeps({ rawW: 400, rawH: 300 });
    const source = await load(file, deps);

    expect(source.orientation).toBe(6);
    expect(source.rawWidth).toBe(400);
    expect(source.rawHeight).toBe(300);
    expect(source.width).toBe(300);
    expect(source.height).toBe(400);
    expect(deps.canvas.width).toBe(300);
    expect(deps.canvas.height).toBe(400);
    const t = orientationTransform(6, 400, 300);
    expect(deps.ctx.setTransform).toHaveBeenCalledWith(t);
    expect(deps.ctx.drawImage).toHaveBeenCalledTimes(1);
    expect(source.format).toBe("jpeg");
    expect(source.previewUrl).toMatch(/^blob:/);
  });

  it("falls back to browser-applied EXIF when imageOrientation option is unsupported", async () => {
    const file = makeFile(jpegBytes(400, 300, 6));
    const deps = makeDeps({ rawW: 300, rawH: 400, failFirstDecode: true });
    const source = await load(file, deps);

    // First call fails (options unsupported) → second bare decode
    // succeeds → third normalizes via canvas
    expect(source.orientation).toBe(1);
    expect(source.width).toBe(300);
    expect(source.height).toBe(400);
    expect(deps.createImageBitmap).toHaveBeenCalledTimes(3);
  });

  it("reports decode failure when both decode paths fail", async () => {
    const file = makeFile(jpegBytes(400, 300));
    const deps = {
      ...makeDeps({ rawW: 400, rawH: 300 }),
      createImageBitmap: vi.fn(async () => {
        throw new Error("decoder not available");
      }),
    };
    await expect(load(file, deps)).rejects.toMatchObject({
      kind: "decode-failed",
    });
  });
});

describe("loadSourceImage work bitmap budget (§8.1.2)", () => {
  it("keeps bitmap untouched under 16 MP", async () => {
    const file = makeFile(jpegBytes(2000, 2000));
    const deps = makeDeps({ rawW: 2000, rawH: 2000 });
    const source = await load(file, deps);
    expect(source.width).toBe(2000);
    expect(source.height).toBe(2000);
  });

  it("scales an 18 MP source down to at most 16 MP", async () => {
    const file = makeFile(jpegBytes(6000, 3000)); // 18 MP ≤ 24 MP limit
    const deps = makeDeps({ rawW: 6000, rawH: 3000 });
    const source = await load(file, deps);
    expect(source.width * source.height).toBeLessThanOrEqual(16e6);
    expect(source.width).toBe(5657);
    expect(source.height).toBe(2828);
  });

  it("exposes the total bitmap budget constant", () => {
    expect(TOTAL_BITMAP_BUDGET_BYTES).toBe(128 * 1024 * 1024);
  });
});

describe("loadSourceImage disposal (§8.1.5)", () => {
  it("closes the normalized bitmap and revokes the preview URL", async () => {
    const file = makeFile(jpegBytes(400, 300));
    const deps = makeDeps({ rawW: 400, rawH: 300 });
    const source = await load(file, deps);
    const normalized = source.bitmap as unknown as { close: ReturnType<typeof vi.fn> };

    source.dispose();

    expect(normalized.close).toHaveBeenCalledTimes(1);
    expect(revokeSpy).toHaveBeenCalledWith(source.previewUrl);
  });

  it("produces SourceLoadError with a kind", async () => {
    const file = makeFile(new Uint8Array([0, 0, 0]));
    const deps = makeDeps({ rawW: 1, rawH: 1 });
    try {
      await load(file, deps);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SourceLoadError);
    }
  });
});
