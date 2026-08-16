import "./style.css";
import { DEFAULT_SETTINGS, nestHpgl, packingSummary, serializePlt, type NestResult, type NestSettings, type Packing } from "./nester";
import { renderPreview } from "./preview";

const fileInput = document.querySelector<HTMLInputElement>("#plt-file")!;
const form = document.querySelector<HTMLFormElement>("#settings")!;
const runButton = document.querySelector<HTMLButtonElement>("#run")!;
const status = document.querySelector<HTMLElement>("#status")!;
const results = document.querySelector<HTMLElement>("#results")!;
const selectedFile = document.querySelector<HTMLElement>("#selected-file")!;

function numeric(name: string): number {
  return Number((form.elements.namedItem(name) as HTMLInputElement).value);
}

function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

function makeButton(label: string, handler: () => void | Promise<void>): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "download";
  button.textContent = label;
  button.addEventListener("click", () => void handler());
  return button;
}

function nestInWorker(text: string, settings: Partial<NestSettings>): Promise<NestResult> {
  if (typeof Worker === "undefined") return Promise.resolve(nestHpgl(text, settings));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./nester.worker.ts", import.meta.url), { type: "module" });
    worker.addEventListener("message", (event: MessageEvent<{ ok: boolean; result?: NestResult; error?: string }>) => {
      worker.terminate();
      if (event.data.ok && event.data.result) resolve(event.data.result);
      else reject(new Error(event.data.error ?? "排版失败。"));
    }, { once: true });
    worker.addEventListener("error", () => {
      worker.terminate();
      reject(new Error("排版计算线程失败。"));
    }, { once: true });
    worker.postMessage({ text, settings });
  });
}

function addLayout(title: string, packing: Packing, materialLength: number, result: NestResult, filenameStem: string): void {
  const article = document.createElement("article");
  article.className = "layout";
  const heading = document.createElement("h2");
  heading.textContent = title;
  article.append(heading);
  const summary = packingSummary(packing, result.plan);
  const metrics = document.createElement("p");
  metrics.className = "metrics";
  metrics.textContent = `裁片 ${summary.partCount} 件 | 使用长度 ${summary.usedLengthMm} 毫米 | 外轮廓面积 ${summary.outerAreaMm2} 平方毫米`;
  article.append(metrics);
  const canvas = document.createElement("canvas");
  canvas.className = "preview";
  renderPreview(canvas, packing, result.plan, materialLength);
  article.append(canvas);
  const actions = document.createElement("div");
  actions.className = "actions";
  actions.append(
    makeButton("下载 PLT", () => downloadBlob(`${filenameStem}.plt`, new Blob([serializePlt(packing, result.plan)], { type: "text/plain;charset=utf-8" }))),
    makeButton("下载 PNG", async () => {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (blob) downloadBlob(`${filenameStem}.png`, blob);
    }),
  );
  article.append(actions);
  results.append(article);
}

function createManifest(result: NestResult, sourceName: string): Record<string, unknown> {
  const report: Record<string, unknown> = {
    source: sourceName,
    detectedParts: result.parts.length,
    sourceBoundsMm: {
      minX: Number((result.sourceBounds[0] / result.plan.unitsPerMm).toFixed(1)),
      minY: Number((result.sourceBounds[1] / result.plan.unitsPerMm).toFixed(1)),
      maxX: Number((result.sourceBounds[2] / result.plan.unitsPerMm).toFixed(1)),
      maxY: Number((result.sourceBounds[3] / result.plan.unitsPerMm).toFixed(1)),
    },
    fabricWidthMm: result.settings.fabricWidthMm,
    clearanceMm: result.settings.clearanceMm,
    gridMm: result.settings.gridMm,
    edgeMarginMm: result.settings.edgeMarginMm,
    rotations: result.plan.rotations,
    compact: packingSummary(result.full, result.plan),
  };
  if (result.split) report.split = {
    remainingLengthMm: result.split.remnantLength / result.plan.unitsPerMm,
    ARemnant: packingSummary(result.split.remnant, result.plan),
    BNewMaterial: packingSummary(result.split.newMaterial, result.plan),
  };
  return report;
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  selectedFile.textContent = file ? `${file.name}（${Math.ceil(file.size / 1024)} KB）` : "尚未选择 PLT 文件";
  if (file) status.textContent = "文件已载入，可以开始排版。";
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = fileInput.files?.[0];
  if (!file) {
    status.textContent = "请先选择 PLT 文件。";
    return;
  }
  const remaining = (form.elements.namedItem("remaining") as HTMLInputElement).value.trim();
  const settings = {
    fabricWidthMm: numeric("width"),
    clearanceMm: numeric("clearance"),
    edgeMarginMm: numeric("edge"),
    gridMm: numeric("grid"),
    remainingLengthMm: remaining ? Number(remaining) : null,
    allowQuarterTurns: (form.elements.namedItem("quarter") as HTMLInputElement).checked,
    effort: (form.elements.namedItem("effort") as HTMLSelectElement).value as "quick" | "standard" | "thorough",
  };
  results.replaceChildren();
  runButton.disabled = true;
  status.textContent = "正在本地解析并排版，文件不会上传。";
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  try {
    const result = await nestInWorker(await file.text(), settings);
    const stem = file.name.replace(/\.plt$/i, "").replace(/[^A-Za-z0-9._-]+/g, "_") || "layout";
    addLayout("紧凑总版", result.full, result.fullLength, result, `${stem}_compact`);
    if (result.split) {
      addLayout("A 版：余料", result.split.remnant, result.split.remnantLength, result, `${stem}_A_remnant`);
      addLayout("B 版：新料", result.split.newMaterial, result.split.newMaterialLength, result, `${stem}_B_new_material`);
    }
    const manifest = createManifest(result, file.name);
    const manifestActions = document.createElement("div");
    manifestActions.className = "manifest-action";
    manifestActions.append(makeButton("下载排版清单", () => downloadBlob(`${stem}_manifest.json`, new Blob([`${JSON.stringify(manifest, null, 2)}\n`], { type: "application/json" }))));
    results.prepend(manifestActions);
    status.textContent = `已识别 ${result.parts.length} 个裁片，紧凑排版用料 ${(result.fullLength / result.plan.unitsPerMm).toFixed(1)} 毫米。`;
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "排版失败。";
  } finally {
    runButton.disabled = false;
  }
});

(form.elements.namedItem("width") as HTMLInputElement).value = String(DEFAULT_SETTINGS.fabricWidthMm);
(form.elements.namedItem("clearance") as HTMLInputElement).value = String(DEFAULT_SETTINGS.clearanceMm);
(form.elements.namedItem("edge") as HTMLInputElement).value = String(DEFAULT_SETTINGS.edgeMarginMm);
(form.elements.namedItem("grid") as HTMLInputElement).value = String(DEFAULT_SETTINGS.gridMm);
