export type Point = [number, number];
export type Bounds = [number, number, number, number];

export interface CutPath {
  index: number;
  points: Point[];
  bounds: Bounds;
  closed: boolean;
  area: number;
}

export interface Part {
  index: number;
  outer: CutPath;
  paths: CutPath[];
  bounds: Bounds;
  width: number;
  height: number;
}

export interface NestSettings {
  fabricWidthMm: number;
  remainingLengthMm: number | null;
  unitsPerMm: number;
  clearanceMm: number;
  edgeMarginMm: number;
  gridMm: number;
  allowQuarterTurns: boolean;
  effort: "quick" | "standard" | "thorough";
  minPartAreaMm2: number;
}

export interface NestPlan {
  unitsPerMm: number;
  step: number;
  edge: number;
  fabricWidth: number;
  widthCells: number;
  rotations: number[];
}

export interface Shape {
  part: Part;
  rotation: number;
  rows: bigint[];
  nonemptyRows: Array<[number, bigint]>;
  width: number;
  height: number;
  pad: number;
}

export interface Placement {
  part: Part;
  shape: Shape;
  x: number;
  y: number;
}

export interface Packing {
  placements: Placement[];
  skipped: Part[];
  usedHeight: number;
}

export interface SplitLayout {
  remnant: Packing;
  newMaterial: Packing;
  remnantLength: number;
  newMaterialLength: number;
}

export interface NestResult {
  parts: Part[];
  sourceBounds: Bounds;
  plan: NestPlan;
  settings: NestSettings;
  full: Packing;
  fullLength: number;
  split: SplitLayout | null;
}

export const DEFAULT_SETTINGS: NestSettings = {
  fabricWidthMm: 1450,
  remainingLengthMm: null,
  unitsPerMm: 40,
  clearanceMm: 1,
  edgeMarginMm: 5,
  gridMm: 1,
  allowQuarterTurns: false,
  effort: "quick",
  minPartAreaMm2: 1000,
};

function makePath(index: number, points: Point[]): CutPath {
  if (!points.length) throw new Error("Empty cutting path.");
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const closed = points.length > 2 && points[0][0] === points.at(-1)![0] && points[0][1] === points.at(-1)![1];
  let area = 0;
  if (closed) {
    for (let index = 0; index < points.length - 1; index += 1) {
      const [x1, y1] = points[index];
      const [x2, y2] = points[index + 1];
      area += x1 * y2 - x2 * y1;
    }
    area = Math.abs(area) / 2;
  }
  return { index, points, bounds: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], closed, area };
}

function parsePoints(payload: string): Point[] {
  const values = [...payload.matchAll(/-?\d+/g)].map((match) => Number(match[0]));
  if (values.length % 2) throw new Error(`坐标列表格式无效：${payload}`);
  const points: Point[] = [];
  for (let index = 0; index < values.length; index += 2) points.push([values[index], values[index + 1]]);
  return points;
}

export function parseHpgl(text: string): CutPath[] {
  const paths: CutPath[] = [];
  let current: Point[] | null = null;
  for (const rawToken of text.replace(/\r/g, "").split(";")) {
    const token = rawToken.trim();
    if (token.length < 2) continue;
    const command = token.slice(0, 2).toUpperCase();
    if (command !== "PU" && command !== "PD") continue;
    const points = parsePoints(token.slice(2));
    if (command === "PU") {
      if (current?.length) paths.push(makePath(paths.length + 1, current));
      current = points;
    } else if (points.length) {
      current ??= [];
      current.push(...points);
    }
  }
  if (current?.length) paths.push(makePath(paths.length + 1, current));
  if (!paths.length) throw new Error("PLT 中没有找到绝对坐标 PU/PD 路径。");
  return paths;
}

function containsBounds(outer: Bounds, inner: Bounds, tolerance = 2): boolean {
  return outer[0] - tolerance <= inner[0] && outer[1] - tolerance <= inner[1]
    && outer[2] + tolerance >= inner[2] && outer[3] + tolerance >= inner[3];
}

function pointOnSegment(point: Point, start: Point, end: Point, tolerance = 2): boolean {
  const [px, py] = point;
  const [ax, ay] = start;
  const [bx, by] = end;
  const cross = (px - ax) * (by - ay) - (py - ay) * (bx - ax);
  if (Math.abs(cross) > tolerance * Math.max(1, Math.abs(bx - ax) + Math.abs(by - ay))) return false;
  return px >= Math.min(ax, bx) - tolerance && px <= Math.max(ax, bx) + tolerance
    && py >= Math.min(ay, by) - tolerance && py <= Math.max(ay, by) + tolerance;
}

function pointInPolygon(point: Point, polygon: Point[]): boolean {
  const [x, y] = point;
  let inside = false;
  for (let index = 0; index < polygon.length - 1; index += 1) {
    const start = polygon[index];
    const end = polygon[index + 1];
    if (pointOnSegment(point, start, end)) return true;
    const [x1, y1] = start;
    const [x2, y2] = end;
    if ((y1 > y) !== (y2 > y)) {
      const crossing = ((x2 - x1) * (y - y1)) / (y2 - y1) + x1;
      if (crossing >= x) inside = !inside;
    }
  }
  return inside;
}

function boundsDistance(first: Bounds, second: Bounds): number {
  const dx = Math.max(first[0] - second[2], second[0] - first[2], 0);
  const dy = Math.max(first[1] - second[3], second[1] - first[3], 0);
  return Math.hypot(dx, dy);
}

export function identifyParts(paths: CutPath[], unitsPerMm: number, minPartAreaMm2: number): Part[] {
  const minArea = minPartAreaMm2 * unitsPerMm * unitsPerMm;
  const contours = paths.filter((path) => path.closed && path.area >= minArea);
  if (!contours.length) throw new Error("没有找到可用于排版的闭合裁剪轮廓。");
  const outerPaths = contours.filter((contour) => !contours.some((candidate) => candidate !== contour
    && candidate.area > contour.area
    && containsBounds(candidate.bounds, contour.bounds)
    && pointInPolygon(contour.points[0], candidate.points)));
  outerPaths.sort((first, second) => first.index - second.index);
  const parts: Part[] = outerPaths.map((outer, index) => ({
    index: index + 1,
    outer,
    paths: [],
    bounds: [0, 0, 0, 0],
    width: 0,
    height: 0,
  }));
  const ownerByPath = new Map<number, Part>(parts.map((part) => [part.outer.index, part]));
  for (const path of paths) {
    const directOwner = ownerByPath.get(path.index);
    if (directOwner) {
      directOwner.paths.push(path);
      continue;
    }
    const contained = parts.filter((part) => containsBounds(part.outer.bounds, path.bounds)
      && pointInPolygon(path.points[0], part.outer.points));
    const owner = contained.length
      ? contained.reduce((smallest, part) => part.outer.area < smallest.outer.area ? part : smallest)
      : parts.reduce((nearest, part) => boundsDistance(part.outer.bounds, path.bounds) < boundsDistance(nearest.outer.bounds, path.bounds) ? part : nearest);
    owner.paths.push(path);
  }
  for (const part of parts) {
    const allBounds = part.paths.map((path) => path.bounds);
    const minX = Math.min(...allBounds.map((bounds) => bounds[0]));
    const minY = Math.min(...allBounds.map((bounds) => bounds[1]));
    const maxX = Math.max(...allBounds.map((bounds) => bounds[2]));
    const maxY = Math.max(...allBounds.map((bounds) => bounds[3]));
    part.bounds = [minX, minY, maxX, maxY];
    part.width = maxX - minX;
    part.height = maxY - minY;
  }
  return parts;
}

function rotateLocal(point: Point, part: Part, rotation: number): Point {
  const x = point[0] - part.bounds[0];
  const y = point[1] - part.bounds[1];
  if (rotation === 0) return [x, y];
  if (rotation === 90) return [part.height - y, x];
  if (rotation === 180) return [part.width - x, part.height - y];
  if (rotation === 270) return [y, part.width - x];
  throw new Error(`Unsupported rotation: ${rotation}`);
}

function rotatedSize(part: Part, rotation: number): [number, number] {
  return rotation === 0 || rotation === 180 ? [part.width, part.height] : [part.height, part.width];
}

function polygonRows(points: Point[], width: number, height: number, step: number): bigint[] {
  const rows = Array<bigint>(height).fill(0n);
  for (let row = 0; row < height; row += 1) {
    const y = (row + 0.5) * step;
    const crossings: number[] = [];
    for (let index = 0; index < points.length - 1; index += 1) {
      const [x1, y1] = points[index];
      const [x2, y2] = points[index + 1];
      if ((y1 <= y && y < y2) || (y2 <= y && y < y1)) crossings.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1));
    }
    crossings.sort((first, second) => first - second);
    let bits = 0n;
    for (let index = 0; index + 1 < crossings.length; index += 2) {
      const first = Math.max(0, Math.floor(Math.min(crossings[index], crossings[index + 1]) / step));
      const last = Math.min(width - 1, Math.floor(Math.max(crossings[index], crossings[index + 1]) / step));
      if (last >= first) bits |= ((1n << BigInt(last - first + 1)) - 1n) << BigInt(first);
    }
    rows[row] = bits;
  }
  for (let index = 0; index < points.length - 1; index += 1) {
    const [x1, y1] = points[index];
    const [x2, y2] = points[index + 1];
    const samples = Math.max(1, Math.ceil(Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1)) / step));
    for (let sample = 0; sample <= samples; sample += 1) {
      const ratio = sample / samples;
      const column = Math.max(0, Math.min(width - 1, Math.floor((x1 + (x2 - x1) * ratio) / step)));
      const row = Math.max(0, Math.min(height - 1, Math.floor((y1 + (y2 - y1) * ratio) / step)));
      rows[row] |= 1n << BigInt(column);
    }
  }
  return rows;
}

function makeShape(part: Part, rotation: number, step: number, clearance: number): Shape {
  const [rawWidth, rawHeight] = rotatedSize(part, rotation);
  const baseWidth = Math.max(1, Math.ceil(rawWidth / step) + 1);
  const baseHeight = Math.max(1, Math.ceil(rawHeight / step) + 1);
  const polygon = part.outer.points.map((point) => rotateLocal(point, part, rotation));
  const baseRows = polygonRows(polygon, baseWidth, baseHeight, step);
  const radius = Math.max(1, Math.ceil(clearance / step));
  const pad = radius + 1;
  const rows = Array<bigint>(baseHeight + 2 * pad).fill(0n);
  for (let baseY = 0; baseY < baseRows.length; baseY += 1) {
    const bits = baseRows[baseY];
    if (!bits) continue;
    for (let dy = -radius; dy <= radius; dy += 1) {
      const dx = Math.floor(Math.sqrt(radius * radius - dy * dy));
      let expanded = 0n;
      for (let shift = -dx; shift <= dx; shift += 1) expanded |= bits << BigInt(pad + shift);
      rows[baseY + pad + dy] |= expanded;
    }
  }
  const nonemptyRows: Array<[number, bigint]> = [];
  rows.forEach((bits, row) => { if (bits) nonemptyRows.push([row, bits]); });
  return { part, rotation, rows, nonemptyRows, width: baseWidth + 2 * pad, height: rows.length, pad };
}

function canPlace(occupied: bigint[], shape: Shape, x: number, y: number, width: number, maxHeight: number | null): boolean {
  if (x < 0 || y < 0 || x + shape.width > width || (maxHeight !== null && y + shape.height > maxHeight)) return false;
  for (const [row, bits] of shape.nonemptyRows) {
    if (((occupied[y + row] ?? 0n) & (bits << BigInt(x))) !== 0n) return false;
  }
  return true;
}

function addShape(occupied: bigint[], shape: Shape, x: number, y: number): void {
  while (occupied.length < y + shape.height) occupied.push(0n);
  for (const [row, bits] of shape.nonemptyRows) occupied[y + row] |= bits << BigInt(x);
}

function candidateXs(placements: Placement[], shape: Shape, width: number): number[] {
  const candidates = new Set<number>([0, width - shape.width]);
  for (const placement of placements) {
    const left = placement.x;
    const right = placement.x + placement.shape.width;
    [left, right, left - shape.width, right - shape.width].forEach((value) => candidates.add(value));
  }
  const available = width - shape.width;
  for (let numerator = 1; numerator < 12 && available > 0; numerator += 1) candidates.add(Math.floor((available * numerator) / 12));
  return [...candidates].filter((value) => value >= 0 && value <= width - shape.width).sort((first, second) => first - second);
}

function findPosition(occupied: bigint[], placements: Placement[], shape: Shape, width: number, usedHeight: number, maxHeight: number | null): [number, number] | null {
  const topLimit = maxHeight === null ? usedHeight : maxHeight - shape.height;
  if (topLimit < 0) return null;
  let best: [number, number, number] | null = null;
  for (const x of candidateXs(placements, shape, width)) {
    for (let y = 0; y <= topLimit; y += 1) {
      if (!canPlace(occupied, shape, x, y, width, maxHeight)) continue;
      const score: [number, number, number] = [Math.max(usedHeight, y + shape.height), y, x];
      if (!best || score[0] < best[0] || (score[0] === best[0] && (score[1] < best[1] || (score[1] === best[1] && score[2] < best[2])))) best = score;
      break;
    }
  }
  return best ? [best[2], best[1]] : null;
}

function seedShuffle<T>(items: T[], seed: number): T[] {
  const output = [...items];
  let state = seed >>> 0;
  for (let index = output.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const target = state % (index + 1);
    [output[index], output[target]] = [output[target], output[index]];
  }
  return output;
}

function packingOrder(parts: Part[], variant: number): Part[] {
  if (variant === 0) return [...parts].sort((first, second) => second.outer.area - first.outer.area || Math.max(second.width, second.height) - Math.max(first.width, first.height) || first.index - second.index);
  if (variant === 1) return [...parts].sort((first, second) => second.height - first.height || second.width - first.width || first.index - second.index);
  if (variant === 2) return [...parts].sort((first, second) => second.width - first.width || second.height - first.height || first.index - second.index);
  if (variant === 3) return [...parts].sort((first, second) => Math.min(second.width, second.height) - Math.min(first.width, first.height) || second.outer.area - first.outer.area || first.index - second.index);
  return seedShuffle(parts, 20260816 + variant * 7919);
}

function packOnce(parts: Part[], shapes: Map<string, Shape>, rotations: number[], width: number, maxHeight: number | null, variant: number): Packing {
  const occupied: bigint[] = maxHeight === null ? [] : Array<bigint>(maxHeight).fill(0n);
  const placements: Placement[] = [];
  const skipped: Part[] = [];
  let usedHeight = 0;
  const tryPlace = (part: Part): boolean => {
    let best: { score: [number, number, number]; shape: Shape; x: number; y: number } | null = null;
    for (const rotation of rotations) {
      const shape = shapes.get(`${part.index}:${rotation}`)!;
      const position = findPosition(occupied, placements, shape, width, usedHeight, maxHeight);
      if (!position) continue;
      const [x, y] = position;
      const score: [number, number, number] = [Math.max(usedHeight, y + shape.height), y, x];
      if (!best || score[0] < best.score[0] || (score[0] === best.score[0] && (score[1] < best.score[1] || (score[1] === best.score[1] && score[2] < best.score[2])))) best = { score, shape, x, y };
    }
    if (!best) return false;
    addShape(occupied, best.shape, best.x, best.y);
    placements.push({ part, shape: best.shape, x: best.x, y: best.y });
    usedHeight = Math.max(usedHeight, best.y + best.shape.height);
    return true;
  };
  for (const part of packingOrder(parts, variant)) if (!tryPlace(part)) skipped.push(part);
  const unresolved: Part[] = [];
  for (const part of [...skipped].sort((first, second) => first.outer.area - second.outer.area || first.index - second.index)) if (!tryPlace(part)) unresolved.push(part);
  return { placements, skipped: unresolved, usedHeight };
}

function placedArea(packing: Packing): number {
  return packing.placements.reduce((total, placement) => total + placement.part.outer.area, 0);
}

function choosePacking(parts: Part[], shapes: Map<string, Shape>, rotations: number[], width: number, maxHeight: number | null, effort: number, preferArea = false): Packing {
  let best: Packing | null = null;
  for (let variant = 0; variant < effort; variant += 1) {
    const candidate = packOnce(parts, shapes, rotations, width, maxHeight, variant);
    if (!best) {
      best = candidate;
      continue;
    }
    const candidateArea = placedArea(candidate);
    const bestArea = placedArea(best);
    const better = preferArea
      ? candidateArea > bestArea || (candidateArea === bestArea && candidate.usedHeight < best.usedHeight)
      : candidate.skipped.length < best.skipped.length || (candidate.skipped.length === best.skipped.length && (candidate.usedHeight < best.usedHeight || (candidate.usedHeight === best.usedHeight && candidateArea > bestArea)));
    if (better) best = candidate;
  }
  return best!;
}

export function transformPoint(point: Point, placement: Placement, plan: NestPlan): Point {
  const [localX, localY] = rotateLocal(point, placement.part, placement.shape.rotation);
  return [
    Math.round(plan.edge + (placement.x + placement.shape.pad) * plan.step + localX),
    Math.round(plan.edge + (placement.y + placement.shape.pad) * plan.step + localY),
  ];
}

export function layoutBounds(packing: Packing, plan: NestPlan): Bounds {
  const points = packing.placements.flatMap((placement) => placement.part.paths.flatMap((path) => path.points.map((point) => transformPoint(point, placement, plan))));
  if (!points.length) return [0, 0, 0, 0];
  return [Math.min(...points.map(([x]) => x)), Math.min(...points.map(([, y]) => y)), Math.max(...points.map(([x]) => x)), Math.max(...points.map(([, y]) => y))];
}

export function usedLength(packing: Packing, plan: NestPlan): number {
  return Math.max(layoutBounds(packing, plan)[3] + plan.edge, 0);
}

export function serializePlt(packing: Packing, plan: NestPlan): string {
  const lines = ["IN;", "DF;", "SP1;", "PA;"];
  for (const placement of [...packing.placements].sort((first, second) => first.part.index - second.part.index)) {
    for (const path of placement.part.paths) {
      const points = path.points.map((point) => transformPoint(point, placement, plan));
      if (!points.length) continue;
      lines.push(`PU${points[0][0]},${points[0][1]};`);
      points.slice(1).forEach(([x, y]) => lines.push(`PD${x},${y};`));
    }
  }
  lines.push("PU0,0;", "SP0;", "PG;");
  return `${lines.join("\n")}\n`;
}

export function packingSummary(packing: Packing, plan: NestPlan): Record<string, unknown> {
  const bounds = layoutBounds(packing, plan);
  const units = plan.unitsPerMm;
  return {
    partCount: packing.placements.length,
    partIds: packing.placements.map((placement) => placement.part.index).sort((first, second) => first - second),
    usedLengthMm: Number((usedLength(packing, plan) / units).toFixed(1)),
    boundsMm: { minX: Number((bounds[0] / units).toFixed(1)), minY: Number((bounds[1] / units).toFixed(1)), maxX: Number((bounds[2] / units).toFixed(1)), maxY: Number((bounds[3] / units).toFixed(1)) },
    outerAreaMm2: Number((placedArea(packing) / (units * units)).toFixed(1)),
  };
}

export function nestHpgl(text: string, requested: Partial<NestSettings> = {}): NestResult {
  const settings = { ...DEFAULT_SETTINGS, ...requested };
  if (settings.fabricWidthMm <= 0 || settings.unitsPerMm <= 0 || settings.gridMm <= 0 || settings.clearanceMm < 0) throw new Error("布宽、单位换算和栅格必须为正数，裁片间距不能为负数。");
  const paths = parseHpgl(text);
  const parts = identifyParts(paths, settings.unitsPerMm, settings.minPartAreaMm2);
  const step = Math.max(1, Math.round(settings.gridMm * settings.unitsPerMm));
  const edge = Math.max(0, Math.round(settings.edgeMarginMm * settings.unitsPerMm));
  const clearance = Math.max(0, Math.round(settings.clearanceMm * settings.unitsPerMm));
  const fabricWidth = Math.round(settings.fabricWidthMm * settings.unitsPerMm);
  const widthCells = Math.floor((fabricWidth - edge * 2) / step);
  if (widthCells <= 0) throw new Error("布宽小于当前设置的边缘留量。");
  const rotations = settings.allowQuarterTurns ? [0, 90, 180, 270] : [0, 180];
  const plan: NestPlan = { unitsPerMm: settings.unitsPerMm, step, edge, fabricWidth, widthCells, rotations };
  const shapes = new Map<string, Shape>();
  for (const part of parts) for (const rotation of rotations) shapes.set(`${part.index}:${rotation}`, makeShape(part, rotation, step, clearance));
  const unavailable = parts.filter((part) => !rotations.some((rotation) => shapes.get(`${part.index}:${rotation}`)!.width <= widthCells));
  if (unavailable.length) throw new Error(`以下裁片超过布宽：${unavailable.map((part) => part.index).join("、")}`);
  const effort = settings.effort === "quick" ? 4 : settings.effort === "thorough" ? 30 : 12;
  const full = choosePacking(parts, shapes, rotations, widthCells, null, effort);
  if (full.skipped.length) throw new Error(`以下裁片无法排入：${full.skipped.map((part) => part.index).join("、")}`);
  const fullLength = usedLength(full, plan);
  let split: SplitLayout | null = null;
  if (settings.remainingLengthMm !== null && settings.remainingLengthMm < fullLength / settings.unitsPerMm) {
    const remnantLength = Math.round(settings.remainingLengthMm * settings.unitsPerMm);
    const heightCells = Math.floor((remnantLength - edge * 2) / step);
    if (heightCells <= 0) throw new Error("余料长度小于当前设置的边缘留量。");
    const remnant = choosePacking(parts, shapes, rotations, widthCells, heightCells, effort, true);
    const newMaterial = choosePacking(remnant.skipped, shapes, rotations, widthCells, null, effort);
    if (newMaterial.skipped.length) throw new Error(`B 版以下裁片无法排入：${newMaterial.skipped.map((part) => part.index).join("、")}`);
    split = { remnant, newMaterial, remnantLength, newMaterialLength: usedLength(newMaterial, plan) };
  }
  const sourceBounds: Bounds = [Math.min(...paths.map((path) => path.bounds[0])), Math.min(...paths.map((path) => path.bounds[1])), Math.max(...paths.map((path) => path.bounds[2])), Math.max(...paths.map((path) => path.bounds[3]))];
  return { parts, sourceBounds, plan, settings, full, fullLength, split };
}
