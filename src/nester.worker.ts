import { nestHpgl, type NestSettings } from "./nester";

interface NestRequest {
  text: string;
  settings: Partial<NestSettings>;
}

globalThis.onmessage = (event: MessageEvent<NestRequest>) => {
  try {
    globalThis.postMessage({ ok: true, result: nestHpgl(event.data.text, event.data.settings) });
  } catch (error) {
    globalThis.postMessage({ ok: false, error: error instanceof Error ? error.message : "排版失败。" });
  }
};
