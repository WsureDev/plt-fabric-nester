import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, posix, resolve, relative, sep } from "node:path";

export interface WorkspaceRef {
  provider: string;
  sandboxId?: string;
  path: string;
}

export interface WorkspaceProvider {
  readonly name: string;
  readText(ref: WorkspaceRef): Promise<string>;
  writeText(ref: WorkspaceRef, content: string): Promise<void>;
  writeBinary(ref: WorkspaceRef, content: Uint8Array, contentType: string): Promise<void>;
}

export interface WorkspaceProviderRegistry {
  readonly defaultProvider: string;
  resolve(name: string): WorkspaceProvider;
}

export function normalizeWorkspacePath(input: string): string {
  const raw = input.trim().replaceAll("\\", "/");
  if (!raw || raw.includes("\0")) throw new Error("workspace path 不能为空或包含非法字符。");

  const relativeInput = raw === "/workspace"
    ? "."
    : raw.startsWith("/workspace/")
      ? raw.slice("/workspace/".length)
      : raw;
  if (relativeInput.startsWith("/")) throw new Error("workspace path 必须是相对 /workspace 的路径。");

  const normalized = posix.normalize(relativeInput);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error("workspace path 不能越过 workspace 根目录。");
  }
  return normalized;
}

function validateProviderName(name: string): string {
  const normalized = name.trim();
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(normalized)) {
    throw new Error(`无效的 workspace provider：${name}`);
  }
  return normalized;
}

export function normalizeSandboxId(input: string): string {
  const raw = input.trim();
  if (!raw || raw.length > 200 || /[\r\n]/.test(raw)) throw new Error("sandbox_id 无效。");
  const canonical = raw.startsWith("sandbox-") ? raw : `sandbox-${raw}`;
  if (!/^sandbox-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(canonical)) throw new Error("sandbox_id 无效。");
  return canonical;
}

function requireSandboxId(ref: WorkspaceRef): string {
  const sandboxId = ref.sandboxId?.trim();
  if (!sandboxId) throw new Error(`provider=${ref.provider} 需要 sandbox_id。`);
  return normalizeSandboxId(sandboxId);
}

function joinWorkspacePath(directory: string, fileName: string): string {
  return normalizeWorkspacePath(posix.join(directory, fileName));
}

async function responseError(response: Response): Promise<Error> {
  const body = await response.text().catch(() => "");
  const detail = body.length > 500 ? `${body.slice(0, 500)}...` : body;
  return new Error(`workspace provider 请求失败（HTTP ${response.status}）：${detail || response.statusText}`);
}

export interface BayWorkspaceProviderOptions {
  baseUrl: string;
  accessToken?: string;
  timeoutMs?: number;
}

/** Generic provider for Shipyard Neo/Bay sandboxes. */
export class BayWorkspaceProvider implements WorkspaceProvider {
  readonly name = "bay";
  private readonly baseUrl: string;
  private readonly accessToken?: string;
  private readonly timeoutMs: number;

  constructor(options: BayWorkspaceProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.accessToken = options.accessToken?.trim() || undefined;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!this.baseUrl) throw new Error("MCP_BAY_BASE_URL 不能为空。");
  }

  private requestUrl(ref: WorkspaceRef, endpoint: "files"): string {
    const sandboxId = encodeURIComponent(requireSandboxId(ref));
    const path = encodeURIComponent(normalizeWorkspacePath(ref.path));
    return `${this.baseUrl}/v1/sandboxes/${sandboxId}/filesystem/${endpoint}?path=${path}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
      ...extra,
    };
  }

  private async fetch(input: string, init: RequestInit): Promise<Response> {
    const response = await globalThis.fetch(input, {
      ...init,
      headers: this.headers((init.headers ?? {}) as Record<string, string>),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw await responseError(response);
    return response;
  }

  async readText(ref: WorkspaceRef): Promise<string> {
    const response = await this.fetch(this.requestUrl(ref, "files"), { method: "GET" });
    const payload = await response.json() as { content?: unknown };
    if (typeof payload.content !== "string") throw new Error("Bay 文件响应缺少文本 content 字段。");
    return payload.content;
  }

  async writeText(ref: WorkspaceRef, content: string): Promise<void> {
    const path = normalizeWorkspacePath(ref.path);
    await this.fetch(`${this.baseUrl}/v1/sandboxes/${encodeURIComponent(requireSandboxId(ref))}/filesystem/files`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, content }),
    });
  }

  async writeBinary(ref: WorkspaceRef, content: Uint8Array, contentType: string): Promise<void> {
    const sandboxId = encodeURIComponent(requireSandboxId(ref));
    const path = normalizeWorkspacePath(ref.path);
    const form = new FormData();
    form.set("path", path);
    const bytes = new Uint8Array(content.byteLength);
    bytes.set(content);
    form.set("file", new Blob([bytes.buffer], { type: contentType }), basename(path));
    await this.fetch(`${this.baseUrl}/v1/sandboxes/${sandboxId}/filesystem/upload`, {
      method: "POST",
      body: form,
    });
  }
}

export interface LocalWorkspaceProviderOptions {
  root: string;
}

/** Provider for a deliberately scoped host directory, useful for shared-volume deployments. */
export class LocalWorkspaceProvider implements WorkspaceProvider {
  readonly name = "local";
  private readonly root: string;

  constructor(options: LocalWorkspaceProviderOptions) {
    this.root = resolve(options.root);
  }

  private filePath(ref: WorkspaceRef): string {
    const filePath = resolve(this.root, normalizeWorkspacePath(ref.path));
    const relativePath = relative(this.root, filePath);
    if (!relativePath || relativePath.startsWith("..") || relativePath.includes(`..${sep}`)) {
      throw new Error("local workspace path 越过了配置的根目录。");
    }
    return filePath;
  }

  async readText(ref: WorkspaceRef): Promise<string> {
    return readFile(this.filePath(ref), "utf8");
  }

  async writeText(ref: WorkspaceRef, content: string): Promise<void> {
    const filePath = this.filePath(ref);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
  }

  async writeBinary(ref: WorkspaceRef, content: Uint8Array): Promise<void> {
    const filePath = this.filePath(ref);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }
}

class Registry implements WorkspaceProviderRegistry {
  readonly defaultProvider: string;
  private readonly providers: Map<string, WorkspaceProvider>;

  constructor(defaultProvider: string, providers: WorkspaceProvider[]) {
    this.defaultProvider = validateProviderName(defaultProvider);
    this.providers = new Map(providers.map((provider) => [provider.name, provider]));
  }

  resolve(name: string): WorkspaceProvider {
    const providerName = validateProviderName(name);
    const provider = this.providers.get(providerName);
    if (!provider) throw new Error(`未配置 workspace provider：${providerName}`);
    return provider;
  }
}

export function createWorkspaceProviderRegistry(): WorkspaceProviderRegistry {
  const defaultProvider = process.env.MCP_WORKSPACE_PROVIDER ?? "bay";
  const providers: WorkspaceProvider[] = [
    new BayWorkspaceProvider({
      baseUrl: process.env.MCP_BAY_BASE_URL ?? "http://host.docker.internal:8114",
      accessToken: process.env.MCP_BAY_ACCESS_TOKEN,
      timeoutMs: Number(process.env.MCP_BAY_TIMEOUT_MS ?? "30000"),
    }),
  ];
  const localRoot = process.env.MCP_LOCAL_WORKSPACE_ROOT?.trim();
  if (localRoot) providers.push(new LocalWorkspaceProvider({ root: localRoot }));
  return new Registry(defaultProvider, providers);
}

export function workspaceRef(provider: string, sandboxId: string | undefined, path: string): WorkspaceRef {
  const normalizedProvider = validateProviderName(provider);
  return {
    provider: normalizedProvider,
    sandboxId: normalizedProvider === "bay" && sandboxId !== undefined ? normalizeSandboxId(sandboxId) : sandboxId,
    path: normalizeWorkspacePath(path),
  };
}

export function workspaceOutputRef(base: WorkspaceRef, directory: string, fileName: string): WorkspaceRef {
  return { ...base, path: joinWorkspacePath(directory, fileName) };
}
