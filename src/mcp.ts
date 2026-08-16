import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { deflateSync } from "node:zlib";
import {
  identifyParts,
  nestHpgl,
  packingSummary,
  parseHpgl,
  serializePlt,
  transformPoint,
  type NestResult,
  type Packing,
  type Point,
} from "./nester";

const server = new McpServer({ name: "plt-fabric-nester", version: "1.0.0" });
const outputRoot = resolve(process.env.MCP_OUTPUT_DIR ?? join(tmpdir(), "plt-fabric-nester"));
const fileHost = process.env.MCP_FILE_HOST ?? "127.0.0.1";
const requestedFilePort = Number(process.env.MCP_FILE_PORT ?? "8765");
let publicBaseUrl = process.env.MCP_PUBLIC_BASE_URL?.replace(/\/$/, "");

const commonSettings = {
  fabricWidthMm: z.number().positive().default(1450).describe("可用布宽，单位毫米"),
  clearanceMm: z.number().min(0).default(1).describe("裁片最小间距，单位毫米"),
  edgeMarginMm: z.number().min(0).default(5).describe("布边留量，单位毫米"),
  gridMm: z.number().positive().default(1).describe("排版栅格，单位毫米"),
  unitsPerMm: z.number().positive().default(40).describe("HP-GL 每毫米单位数"),
  remainingLengthMm: z.number().positive().nullable().default(null).describe("余料长度，填写后生成 A/B 分版；不填写则为 null"),
  allowQuarterTurns: z.boolean().default(false).describe("是否允许 90 度旋转"),
  effort: z.enum(["quick", "standard", "thorough"]).default("quick").describe("排版搜索强度"),
};

function jsonText(value: unknown): { type: "text"; text: string } {
  return { type: "text", text: JSON.stringify(value, null, 2) };
}

function errorResult(error: unknown): { isError: true; content: [{ type: "text"; text: string }] } {
  return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "MCP 工具执行失败。" }] };
}

function sourceSummary(plt: string, unitsPerMm: number, minPartAreaMm2 = 1000): Record<string, unknown> {
  const paths = parseHpgl(plt);
  const parts = identifyParts(paths, unitsPerMm, minPartAreaMm2);
  const bounds = [
    Math.min(...paths.map((path) => path.bounds[0])), Math.min(...paths.map((path) => path.bounds[1])),
    Math.max(...paths.map((path) => path.bounds[2])), Math.max(...paths.map((path) => path.bounds[3])),
  ];
  return {
    pathCount: paths.length,
    partCount: parts.length,
    sourceBoundsMm: {
      minX: Number((bounds[0] / unitsPerMm).toFixed(1)), minY: Number((bounds[1] / unitsPerMm).toFixed(1)),
      maxX: Number((bounds[2] / unitsPerMm).toFixed(1)), maxY: Number((bounds[3] / unitsPerMm).toFixed(1)),
    },
    parts: parts.map((part) => ({
      id: part.index,
      pathCount: part.paths.length,
      widthMm: Number((part.width / unitsPerMm).toFixed(1)),
      heightMm: Number((part.height / unitsPerMm).toFixed(1)),
      outerAreaMm2: Number((part.outer.area / (unitsPerMm * unitsPerMm)).toFixed(1)),
    })),
  };
}

function selectedLayout(result: NestResult, layout: "compact" | "A" | "B"): { packing: Packing; materialLength: number; label: string; fileStem: string } {
  if (layout === "A" && result.split) return { packing: result.split.remnant, materialLength: result.split.remnantLength, label: "A 余料版", fileStem: "A-remnant" };
  if (layout === "B" && result.split) return { packing: result.split.newMaterial, materialLength: result.split.newMaterialLength, label: "B 新料版", fileStem: "B-new-material" };
  return { packing: result.full, materialLength: result.fullLength, label: "紧凑总版", fileStem: "compact" };
}

type Rgb = [number, number, number];

class Raster {
  readonly pixels: Uint8Array;

  constructor(readonly width: number, readonly height: number) {
    this.pixels = new Uint8Array(width * height * 3);
    this.pixels.fill(250);
    for (let index = 2; index < this.pixels.length; index += 3) this.pixels[index] = 248;
  }

  set(x: number, y: number, color: Rgb): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const index = (y * this.width + x) * 3;
    this.pixels[index] = color[0]; this.pixels[index + 1] = color[1]; this.pixels[index + 2] = color[2];
  }

  line(start: Point, end: Point, color: Rgb): void {
    let [x1, y1] = start; const [x2, y2] = end;
    const dx = Math.abs(x2 - x1); const sx = x1 < x2 ? 1 : -1;
    const dy = -Math.abs(y2 - y1); const sy = y1 < y2 ? 1 : -1;
    let error = dx + dy;
    while (true) {
      this.set(x1, y1, color);
      if (x1 === x2 && y1 === y2) break;
      const twice = 2 * error;
      if (twice >= dy) { error += dy; x1 += sx; }
      if (twice <= dx) { error += dx; y1 += sy; }
    }
  }

  fillPolygon(points: Point[], color: Rgb): void {
    if (points.length < 3) return;
    const minY = Math.max(0, Math.floor(Math.min(...points.map((point) => point[1]))));
    const maxY = Math.min(this.height - 1, Math.ceil(Math.max(...points.map((point) => point[1]))));
    for (let y = minY; y <= maxY; y += 1) {
      const crossings: number[] = [];
      for (let index = 0; index < points.length - 1; index += 1) {
        const [x1, y1] = points[index]; const [x2, y2] = points[index + 1];
        if ((y1 <= y && y < y2) || (y2 <= y && y < y1)) crossings.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
      }
      crossings.sort((first, second) => first - second);
      for (let index = 0; index + 1 < crossings.length; index += 2) {
        for (let x = Math.max(0, Math.ceil(crossings[index])); x <= Math.min(this.width - 1, Math.floor(crossings[index + 1])); x += 1) this.set(x, y, color);
      }
    }
  }

  png(): Buffer {
    const scanlines: Buffer[] = [];
    for (let row = 0; row < this.height; row += 1) {
      const start = row * this.width * 3;
      scanlines.push(Buffer.concat([Buffer.from([0]), Buffer.from(this.pixels.subarray(start, start + this.width * 3))]));
    }
    const chunk = (name: string, data: Buffer): Buffer => {
      const type = Buffer.from(name, "ascii");
      const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, data])), 0);
      const size = Buffer.alloc(4); size.writeUInt32BE(data.length, 0);
      return Buffer.concat([size, type, data, crc]);
    };
    const header = Buffer.alloc(13); header.writeUInt32BE(this.width, 0); header.writeUInt32BE(this.height, 4); header[8] = 8; header[9] = 2;
    return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(scanlines), { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
  }
}

const FONT: Record<string, string[]> = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  "W": ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
  "L": ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  "m": ["00000", "00000", "11010", "10101", "10101", "10101", "10101"],
  "=": ["00000", "11111", "00000", "11111", "00000", "00000", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "00110", "00110"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
};

function drawText(image: Raster, text: string, x: number, y: number, color: Rgb, scale = 2, align: "left" | "center" | "right" = "left"): void {
  const advance = 6 * scale;
  const width = Math.max(0, text.length * advance - scale);
  let left = align === "center" ? x - Math.round(width / 2) : align === "right" ? x - width : x;
  for (const character of text) {
    const glyph = FONT[character] ?? FONT["-"];
    glyph.forEach((row, rowIndex) => {
      [...row].forEach((filled, columnIndex) => {
        if (filled === "1") {
          for (let dy = 0; dy < scale; dy += 1) for (let dx = 0; dx < scale; dx += 1) image.set(left + columnIndex * scale + dx, y + rowIndex * scale + dy, color);
        }
      });
    });
    left += advance;
  }
}

function rulerValues(length: number): number[] {
  const tick = length >= 1000 ? 100 : 50;
  const values = Array.from({ length: Math.floor(length / tick) + 1 }, (_, index) => index * tick);
  if (Math.abs(values.at(-1)! - length) > 0.01) values.push(length);
  return values;
}

function formatMm(value: number): string {
  return Number.isInteger(Math.round(value * 10) / 10) ? String(Math.round(value)) : value.toFixed(1);
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function renderPng(result: NestResult, packing: Packing, materialLength: number): Buffer {
  const units = result.plan.unitsPerMm;
  const widthMm = result.plan.fabricWidth / units;
  const heightMm = materialLength / units;
  const left = 72; const top = 52; const right = 20; const bottom = 20;
  const scale = Math.min((1400 - left - right) / widthMm, (4000 - top - bottom) / Math.max(1, heightMm));
  const width = Math.max(220, Math.ceil(widthMm * scale) + left + right);
  const height = Math.max(180, Math.ceil(heightMm * scale) + top + bottom);
  const image = new Raster(width, height);
  const project = ([x, y]: Point): Point => [Math.round(left + (x / units) * scale), Math.round(height - bottom - (y / units) * scale)];
  const border: Point[] = [project([0, 0]), project([result.plan.fabricWidth, 0]), project([result.plan.fabricWidth, materialLength]), project([0, materialLength]), project([0, 0])];
  const dark: Rgb = [45, 45, 45];
  border.slice(1).forEach((point, index) => image.line(border[index], point, dark));
  const ruler: Rgb = [105, 105, 105];
  const rulerY = top - 18;
  image.line([border[0][0], rulerY], [border[1][0], rulerY], ruler);
  for (const value of rulerValues(widthMm)) {
    const x = Math.round(border[0][0] + (border[1][0] - border[0][0]) * value / widthMm);
    const major = Math.abs(value % 500) < 0.01 || Math.abs(value - widthMm) < 0.01;
    image.line([x, rulerY], [x, rulerY - (major ? 8 : 4)], ruler);
    if (major) drawText(image, formatMm(value), x, rulerY - 24, dark, 2, "center");
  }
  const rulerX = left - 18;
  image.line([rulerX, border[3][1]], [rulerX, border[0][1]], ruler);
  for (const value of rulerValues(heightMm)) {
    const y = Math.round(border[0][1] - (border[0][1] - border[3][1]) * value / heightMm);
    const major = Math.abs(value % 500) < 0.01 || Math.abs(value - heightMm) < 0.01;
    image.line([rulerX, y], [rulerX - (major ? 8 : 4), y], ruler);
    if (major) drawText(image, formatMm(value), rulerX - 12, y - 7, dark, 2, "right");
  }
  drawText(image, `L=${formatMm(heightMm)}mm`, 4, 8, dark, 2);
  drawText(image, `W=${formatMm(widthMm)}mm`, Math.round(width / 2), 8, dark, 2, "center");
  const colors: Rgb[] = [[22, 94, 128], [169, 75, 42], [57, 126, 82], [131, 79, 151], [182, 117, 19], [32, 123, 122], [169, 56, 91], [91, 101, 31]];
  const pale = (color: Rgb): Rgb => color.map((value) => Math.round((value + 5 * 255) / 6)) as Rgb;
  for (const placement of packing.placements) {
    const color = colors[(placement.part.index - 1) % colors.length];
    const outer = placement.part.outer.points.map((point) => project(transformPoint(point, placement, result.plan)));
    image.fillPolygon(outer, pale(color));
    for (let index = 1; index < outer.length; index += 1) image.line(outer[index - 1], outer[index], color);
    for (const path of placement.part.paths) {
      const points = path.points.map((point) => project(transformPoint(point, placement, result.plan)));
      for (let index = 1; index < points.length; index += 1) image.line(points[index - 1], points[index], color);
    }
  }
  return image.png();
}

function contentType(fileName: string): string {
  if (fileName.endsWith(".png")) return "image/png";
  if (fileName.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/x-hpgl; charset=ascii";
}

async function startFileServer(): Promise<void> {
  await mkdir(outputRoot, { recursive: true });
  const httpServer = createServer(async (request, response) => {
    try {
      if (!request.url?.startsWith("/files/")) { response.writeHead(404); response.end("Not found"); return; }
      const requested = decodeURIComponent(request.url.slice("/files/".length).split("?")[0]);
      const filePath = resolve(outputRoot, requested);
      const relativePath = relative(outputRoot, filePath);
      if (!relativePath || relativePath.startsWith("..") || relativePath.includes(`..${sep}`)) { response.writeHead(403); response.end("Forbidden"); return; }
      const data = await readFile(filePath);
      const disposition = filePath.endsWith(".png") ? "inline" : "attachment";
      response.writeHead(200, { "Content-Type": contentType(filePath), "Content-Disposition": `${disposition}; filename="${filePath.split(/[\\/]/).pop()}"`, "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
      response.end(data);
    } catch {
      response.writeHead(404); response.end("Not found");
    }
  });
  await new Promise<void>((resolveListen, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(Number.isFinite(requestedFilePort) ? requestedFilePort : 8765, fileHost, () => resolveListen());
  });
  const address = httpServer.address();
  const port = typeof address === "object" && address !== null ? address.port : (Number.isFinite(requestedFilePort) ? requestedFilePort : 8765);
  publicBaseUrl ??= `http://127.0.0.1:${port}`;
}

interface DownloadFile {
  layout: string;
  pltUrl: string;
  pngUrl: string;
  manifestUrl: string;
  pngBase64: string;
}

async function saveResultFiles(result: NestResult): Promise<DownloadFile[]> {
  const id = randomUUID();
  const directory = join(outputRoot, id);
  await mkdir(directory, { recursive: true });
  const layouts: Array<"compact" | "A" | "B"> = ["compact"];
  if (result.split) layouts.push("A", "B");
  const files: DownloadFile[] = [];
  const base = publicBaseUrl!;
  for (const layout of layouts) {
    const selected = selectedLayout(result, layout);
    const stem = selected.fileStem;
    const pltName = `${stem}.plt`;
    const pngName = `${stem}.png`;
    const manifestName = `${stem}.json`;
    const plt = serializePlt(selected.packing, result.plan);
    const png = renderPng(result, selected.packing, selected.materialLength);
    const manifest = JSON.stringify({ layout: selected.label, summary: packingSummary(selected.packing, result.plan), settings: result.settings }, null, 2) + "\n";
    await Promise.all([writeFile(join(directory, pltName), plt, "ascii"), writeFile(join(directory, pngName), png), writeFile(join(directory, manifestName), manifest, "utf8")]);
    files.push({ layout: selected.label, pltUrl: `${base}/files/${id}/${pltName}`, pngUrl: `${base}/files/${id}/${pngName}`, manifestUrl: `${base}/files/${id}/${manifestName}`, pngBase64: png.toString("base64") });
  }
  return files;
}

server.registerTool("analyze_plt", {
  title: "分析 PLT",
  description: "分析 PLT 路径、裁片数量、原始尺寸和每个裁片的包围盒，不执行排版。",
  inputSchema: { plt: z.string().min(1).describe("完整 HP-GL PLT 文本"), unitsPerMm: z.number().positive().default(40).describe("HP-GL 每毫米单位数") },
}, async ({ plt, unitsPerMm }) => {
  try { return { content: [jsonText(sourceSummary(plt, unitsPerMm))] }; } catch (error) { return errorResult(error); }
});

server.registerTool("nest_plt", {
  title: "紧凑排版 PLT",
  description: "按参数生成紧凑 PLT 文件和 PNG 预览，并返回可下载地址；余料不足时生成 A/B 分版。",
  inputSchema: { plt: z.string().min(1).describe("完整 HP-GL PLT 文本"), ...commonSettings },
}, async ({ plt, ...settings }) => {
  try {
    const result = nestHpgl(plt, settings);
    const files = await saveResultFiles(result);
    const first = files[0];
    return {
      content: [
        jsonText({ settings: result.settings, detectedParts: result.parts.length, compact: packingSummary(result.full, result.plan), split: result.split ? { remainingLengthMm: result.split.remnantLength / result.plan.unitsPerMm, A: packingSummary(result.split.remnant, result.plan), B: packingSummary(result.split.newMaterial, result.plan) } : null, downloads: files.map(({ pngBase64: _png, ...file }) => file) }),
        { type: "image", data: first.pngBase64, mimeType: "image/png" },
      ],
    };
  } catch (error) { return errorResult(error); }
});

server.registerTool("preview_plt", {
  title: "生成 PLT PNG 预览",
  description: "生成指定版次的 PNG 审核预览并返回下载地址，不生成 SVG。",
  inputSchema: { plt: z.string().min(1).describe("完整 HP-GL PLT 文本"), layout: z.enum(["compact", "A", "B"]).default("compact").describe("预览总版、A 余料版或 B 新料版"), ...commonSettings },
}, async ({ plt, layout, ...settings }) => {
  try {
    const result = nestHpgl(plt, settings);
    const files = await saveResultFiles(result);
    const selected = files[layout === "A" ? 1 : layout === "B" ? 2 : 0];
    if (!selected) throw new Error(`当前参数没有生成 ${layout} 版。`);
    return { content: [jsonText({ layout, pngUrl: selected.pngUrl, pltUrl: selected.pltUrl, manifestUrl: selected.manifestUrl }), { type: "image", data: selected.pngBase64, mimeType: "image/png" }] };
  } catch (error) { return errorResult(error); }
});

await startFileServer();
const transport = new StdioServerTransport();
await server.connect(transport);
