import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  identifyParts,
  layoutBounds,
  nestHpgl,
  packingSummary,
  parseHpgl,
  serializePlt,
  transformPoint,
  type NestResult,
  type Packing,
} from "./nester";

const server = new McpServer({
  name: "plt-fabric-nester",
  version: "1.0.0",
});

const commonSettings = {
  fabricWidthMm: z.number().positive().default(1450).describe("可用布宽，单位毫米"),
  clearanceMm: z.number().min(0).default(1).describe("裁片最小间距，单位毫米"),
  edgeMarginMm: z.number().min(0).default(5).describe("布边留量，单位毫米"),
  gridMm: z.number().positive().default(1).describe("排版栅格，单位毫米"),
  unitsPerMm: z.number().positive().default(40).describe("HP-GL 每毫米单位数"),
  remainingLengthMm: z.number().positive().optional().describe("余料长度，填写后生成 A/B 分版"),
  allowQuarterTurns: z.boolean().default(false).describe("是否允许 90 度旋转"),
  effort: z.enum(["quick", "standard", "thorough"]).default("quick").describe("排版搜索强度"),
};

function jsonText(value: unknown): { type: "text"; text: string } {
  return { type: "text", text: JSON.stringify(value, null, 2) };
}

function resourceText(uri: string, mimeType: string, text: string): { type: "resource"; resource: { uri: string; mimeType: string; text: string } } {
  return { type: "resource", resource: { uri, mimeType, text } };
}

function errorResult(error: unknown): { isError: true; content: [{ type: "text"; text: string }] } {
  return {
    isError: true,
    content: [{ type: "text", text: error instanceof Error ? error.message : "MCP 工具执行失败。" }],
  };
}

function sourceSummary(plt: string, unitsPerMm: number, minPartAreaMm2 = 1000): Record<string, unknown> {
  const paths = parseHpgl(plt);
  const parts = identifyParts(paths, unitsPerMm, minPartAreaMm2);
  const bounds = [
    Math.min(...paths.map((path) => path.bounds[0])),
    Math.min(...paths.map((path) => path.bounds[1])),
    Math.max(...paths.map((path) => path.bounds[2])),
    Math.max(...paths.map((path) => path.bounds[3])),
  ];
  return {
    pathCount: paths.length,
    partCount: parts.length,
    sourceBoundsMm: {
      minX: Number((bounds[0] / unitsPerMm).toFixed(1)),
      minY: Number((bounds[1] / unitsPerMm).toFixed(1)),
      maxX: Number((bounds[2] / unitsPerMm).toFixed(1)),
      maxY: Number((bounds[3] / unitsPerMm).toFixed(1)),
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

function layoutFromName(result: NestResult, layout: "compact" | "A" | "B"): { packing: Packing; materialLength: number; label: string } {
  if (layout === "A" && result.split) return { packing: result.split.remnant, materialLength: result.split.remnantLength, label: "A 余料版" };
  if (layout === "B" && result.split) return { packing: result.split.newMaterial, materialLength: result.split.newMaterialLength, label: "B 新料版" };
  return { packing: result.full, materialLength: result.fullLength, label: "紧凑总版" };
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll("\"", "&quot;");
}

function svgPreview(result: NestResult, packing: Packing, materialLength: number): string {
  const units = result.plan.unitsPerMm;
  const widthMm = result.plan.fabricWidth / units;
  const heightMm = materialLength / units;
  const scale = Math.min(1400 / widthMm, 4000 / Math.max(heightMm, 1));
  const marginLeft = 72;
  const marginTop = 42;
  const marginRight = 18;
  const marginBottom = 22;
  const width = Math.ceil(widthMm * scale) + marginLeft + marginRight;
  const height = Math.ceil(heightMm * scale) + marginTop + marginBottom;
  const project = ([x, y]: [number, number]): [number, number] => [
    marginLeft + (x / units) * scale,
    height - marginBottom - (y / units) * scale,
  ];
  const colors = ["#165e80", "#a94b2a", "#397e52", "#834f97", "#b67513", "#207a7a", "#a9385b", "#5b651f"];
  const pathsFor = (points: Array<[number, number]>) => points.map((point, index) => `${index ? "L" : "M"}${project(point)[0].toFixed(1)},${project(point)[1].toFixed(1)}`).join(" ");
  const elements: string[] = [];
  elements.push(`<rect width="${width}" height="${height}" fill="#fbfbf8"/>`);
  elements.push(`<rect x="${marginLeft}" y="${marginTop}" width="${width - marginLeft - marginRight}" height="${height - marginTop - marginBottom}" fill="none" stroke="#303030"/>`);
  elements.push(`<text x="8" y="16" font-family="sans-serif" font-size="12">长=${xml(heightMm.toFixed(1))} 毫米</text>`);
  elements.push(`<text x="${width / 2}" y="16" text-anchor="middle" font-family="sans-serif" font-size="12">宽=${xml(widthMm.toFixed(1))} 毫米</text>`);
  packing.placements.forEach((placement) => {
    const color = colors[(placement.part.index - 1) % colors.length];
    const outer = placement.part.outer.points.map((point) => transformPoint(point, placement, result.plan));
    elements.push(`<path d="${pathsFor(outer)}" fill="${color}20" stroke="${color}" stroke-width="1"/>`);
    placement.part.paths.forEach((path) => {
      const points = path.points.map((point) => transformPoint(point, placement, result.plan));
      elements.push(`<path d="${pathsFor(points)}" fill="none" stroke="${color}" stroke-width="1"/>`);
    });
    const bounds = layoutBounds({ placements: [placement], skipped: [], usedHeight: placement.shape.height }, result.plan);
    const center = project([(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2]);
    elements.push(`<text x="${center[0].toFixed(1)}" y="${center[1].toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-family="monospace" font-size="10" fill="#181818">${placement.part.index}</text>`);
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${elements.join("")}</svg>\n`;
}

server.registerTool("analyze_plt", {
  title: "分析 PLT",
  description: "分析 PLT 路径、裁片数量、原始尺寸和每个裁片的包围盒，不执行排版。",
  inputSchema: {
    plt: z.string().min(1).describe("完整 HP-GL PLT 文本"),
    unitsPerMm: z.number().positive().default(40).describe("HP-GL 每毫米单位数"),
  },
}, async ({ plt, unitsPerMm }) => {
  try {
    return { content: [jsonText(sourceSummary(plt, unitsPerMm))] };
  } catch (error) {
    return errorResult(error);
  }
});

server.registerTool("nest_plt", {
  title: "紧凑排版 PLT",
  description: "按布宽和间距生成紧凑总版；余料不足时同时生成 A 余料版和 B 新料版，并返回可保存的 PLT 资源。",
  inputSchema: {
    plt: z.string().min(1).describe("完整 HP-GL PLT 文本"),
    ...commonSettings,
  },
}, async ({ plt, ...settings }) => {
  try {
    const result = nestHpgl(plt, settings);
    const output = {
      detectedParts: result.parts.length,
      settings: result.settings,
      compact: packingSummary(result.full, result.plan),
      split: result.split ? {
        remainingLengthMm: result.split.remnantLength / result.plan.unitsPerMm,
        A: packingSummary(result.split.remnant, result.plan),
        B: packingSummary(result.split.newMaterial, result.plan),
      } : null,
    };
    const compactPlt = serializePlt(result.full, result.plan);
    return {
      content: [
        jsonText(output),
        resourceText("urn:plt-fabric-nester/compact.plt", "application/x-hpgl", compactPlt),
        ...(result.split ? [
          resourceText("urn:plt-fabric-nester/A-remnant.plt", "application/x-hpgl", serializePlt(result.split.remnant, result.plan)),
          resourceText("urn:plt-fabric-nester/B-new-material.plt", "application/x-hpgl", serializePlt(result.split.newMaterial, result.plan)),
        ] : []),
      ],
    };
  } catch (error) {
    return errorResult(error);
  }
});

server.registerTool("preview_plt", {
  title: "生成 PLT 预览",
  description: "生成紧凑排版的 SVG 审核预览，包含裁片编号、布宽和排版长度。",
  inputSchema: {
    plt: z.string().min(1).describe("完整 HP-GL PLT 文本"),
    layout: z.enum(["compact", "A", "B"]).default("compact").describe("预览总版、A 余料版或 B 新料版"),
    ...commonSettings,
  },
}, async ({ plt, layout, ...settings }) => {
  try {
    const result = nestHpgl(plt, settings);
    const selected = layoutFromName(result, layout);
    return {
      content: [
        jsonText({ layout: selected.label, summary: packingSummary(selected.packing, result.plan) }),
        resourceText(`urn:plt-fabric-nester/${layout}.svg`, "image/svg+xml", svgPreview(result, selected.packing, selected.materialLength)),
      ],
    };
  } catch (error) {
    return errorResult(error);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
