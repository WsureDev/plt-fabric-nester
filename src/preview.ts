import { layoutBounds, transformPoint, type NestPlan, type Packing, type Point } from "./nester";

const PALETTE = ["#165e80", "#a94b2a", "#397e52", "#834f97", "#b67513", "#207a7a", "#a9385b", "#5b651f", "#3f5da0", "#855335"];

function rulerValues(length: number): number[] {
  const tick = length >= 1000 ? 100 : 50;
  const values = Array.from({ length: Math.floor(length / tick) + 1 }, (_, index) => index * tick);
  if (Math.abs(values.at(-1)! - length) > 0.01) values.push(length);
  return values;
}

function formatMm(value: number): string {
  return Number.isInteger(Math.round(value * 10) / 10) ? String(Math.round(value)) : value.toFixed(1);
}

function drawPath(context: CanvasRenderingContext2D, points: Point[]): void {
  if (!points.length) return;
  context.beginPath();
  context.moveTo(points[0][0], points[0][1]);
  points.slice(1).forEach(([x, y]) => context.lineTo(x, y));
}

export function renderPreview(canvas: HTMLCanvasElement, packing: Packing, plan: NestPlan, materialLength: number): void {
  const widthMm = plan.fabricWidth / plan.unitsPerMm;
  const lengthMm = materialLength / plan.unitsPerMm;
  const left = 68;
  const top = 50;
  const right = 20;
  const bottom = 24;
  const desiredWidth = 1400;
  const desiredHeight = 4000;
  const scale = Math.min((desiredWidth - left - right) / widthMm, (desiredHeight - top - bottom) / Math.max(1, lengthMm));
  canvas.width = Math.max(260, Math.ceil(widthMm * scale) + left + right);
  canvas.height = Math.max(220, Math.ceil(lengthMm * scale) + top + bottom);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas rendering is unavailable in this browser.");
  context.fillStyle = "#fbfbf8";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.lineJoin = "round";
  context.lineCap = "round";

  const project = ([x, y]: Point): Point => [left + (x / plan.unitsPerMm) * scale, canvas.height - bottom - (y / plan.unitsPerMm) * scale];
  const border: Point[] = [project([0, 0]), project([plan.fabricWidth, 0]), project([plan.fabricWidth, materialLength]), project([0, materialLength])];
  context.strokeStyle = "#303030";
  context.lineWidth = 1;
  drawPath(context, [...border, border[0]]);
  context.stroke();

  const rulerY = top - 16;
  context.strokeStyle = "#777";
  context.beginPath();
  context.moveTo(border[0][0], rulerY);
  context.lineTo(border[1][0], rulerY);
  context.stroke();
  context.textAlign = "center";
  context.textBaseline = "alphabetic";
  context.font = "10px ui-monospace, SFMono-Regular, Consolas, monospace";
  context.fillStyle = "#333";
  rulerValues(widthMm).forEach((value) => {
    const x = border[0][0] + (border[1][0] - border[0][0]) * value / widthMm;
    const major = Math.abs(value % 500) < 0.01 || Math.abs(value - widthMm) < 0.01;
    context.beginPath();
    context.moveTo(x, rulerY);
    context.lineTo(x, rulerY - (major ? 8 : 4));
    context.stroke();
    if (major) context.fillText(formatMm(value), x, rulerY - 10);
  });

  const rulerX = left - 16;
  context.beginPath();
  context.moveTo(rulerX, border[3][1]);
  context.lineTo(rulerX, border[0][1]);
  context.stroke();
  context.textAlign = "right";
  context.textBaseline = "middle";
  rulerValues(lengthMm).forEach((value) => {
    const y = border[0][1] - (border[0][1] - border[3][1]) * value / lengthMm;
    const major = Math.abs(value % 500) < 0.01 || Math.abs(value - lengthMm) < 0.01;
    context.beginPath();
    context.moveTo(rulerX, y);
    context.lineTo(rulerX - (major ? 8 : 4), y);
    context.stroke();
    if (major) context.fillText(formatMm(value), rulerX - 11, y);
  });
  context.textBaseline = "top";
  context.textAlign = "left";
  context.font = "600 11px ui-monospace, SFMono-Regular, Consolas, monospace";
  context.fillText(`长度=${formatMm(lengthMm)} 毫米`, 4, 4);
  context.textAlign = "center";
  context.fillText(`宽度=${formatMm(widthMm)} 毫米`, canvas.width / 2, 4);

  packing.placements.forEach((placement) => {
    const color = PALETTE[(placement.part.index - 1) % PALETTE.length];
    const outer = placement.part.outer.points.map((point) => project(transformPoint(point, placement, plan)));
    context.fillStyle = `${color}20`;
    context.strokeStyle = color;
    context.lineWidth = 1;
    drawPath(context, outer);
    context.fill();
    context.stroke();
  });
  packing.placements.forEach((placement) => {
    const color = PALETTE[(placement.part.index - 1) % PALETTE.length];
    context.strokeStyle = color;
    context.lineWidth = 1;
    placement.part.paths.forEach((path) => {
      drawPath(context, path.points.map((point) => project(transformPoint(point, placement, plan))));
      context.stroke();
    });
    const outer = placement.part.outer.points.map((point) => transformPoint(point, placement, plan));
    const bounds: [number, number, number, number] = [Math.min(...outer.map(([x]) => x)), Math.min(...outer.map(([, y]) => y)), Math.max(...outer.map(([x]) => x)), Math.max(...outer.map(([, y]) => y))];
    const center = project([(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2]);
    context.fillStyle = "#181818";
    context.font = "10px ui-monospace, SFMono-Regular, Consolas, monospace";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(String(placement.part.index), center[0], center[1]);
  });
  const usedEnd = layoutBounds(packing, plan)[3] + plan.edge;
  if (usedEnd > 0 && usedEnd < materialLength) {
    const y = project([0, usedEnd])[1];
    context.strokeStyle = "#be3535";
    context.setLineDash([6, 5]);
    context.beginPath();
    context.moveTo(border[0][0], y);
    context.lineTo(border[1][0], y);
    context.stroke();
    context.setLineDash([]);
  }
}
