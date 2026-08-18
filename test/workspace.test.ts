import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BayWorkspaceProvider, LocalWorkspaceProvider, normalizeSandboxId, normalizeWorkspacePath, workspaceRef } from "../src/workspace.ts";

test("normalizes workspace-relative paths and rejects escapes", () => {
  assert.equal(normalizeWorkspacePath("/workspace/input/pattern.plt"), "input/pattern.plt");
  assert.equal(normalizeWorkspacePath("input/../output/result.plt"), "output/result.plt");
  assert.throws(() => normalizeWorkspacePath("../secret.plt"));
  assert.throws(() => normalizeWorkspacePath("/etc/passwd"));
});

test("accepts Bay sandbox IDs with or without the sandbox- prefix", () => {
  assert.equal(normalizeSandboxId("28a0ae9198b4"), "sandbox-28a0ae9198b4");
  assert.equal(normalizeSandboxId("sandbox-28a0ae9198b4"), "sandbox-28a0ae9198b4");
  assert.throws(() => normalizeSandboxId("sandbox-../escape"));
});

test("local provider confines reads and writes to its configured root", async () => {
  const root = await mkdtemp(join(tmpdir(), "plt-fabric-nester-workspace-"));
  const provider = new LocalWorkspaceProvider({ root });
  try {
    const textRef = workspaceRef("local", undefined, "input/pattern.plt");
    await provider.writeText(textRef, "PU0,0;PD40000,0,40000,20000,0,20000,0,0;");
    assert.match(await provider.readText(textRef), /PU0,0/);

    const imageRef = workspaceRef("local", undefined, "output/preview.png");
    await provider.writeBinary(imageRef, new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "image/png");
    assert.deepEqual(await readFile(join(root, "output", "preview.png")), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    assert.throws(() => workspaceRef("local", undefined, "../../outside.plt"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Bay provider reads through the sandbox filesystem API", async () => {
  const originalFetch = globalThis.fetch;
  let url = "";
  let authorization = "";
  globalThis.fetch = (async (input, init) => {
    url = String(input);
    authorization = new Headers(init?.headers).get("Authorization") ?? "";
    return new Response(JSON.stringify({ content: "PU0,0;" }), { status: 200 });
  }) as typeof fetch;

  try {
    const provider = new BayWorkspaceProvider({ baseUrl: "https://bay.example/", accessToken: "test-token" });
    const content = await provider.readText(workspaceRef("bay", "abc123", "/workspace/input/pattern.plt"));
    assert.equal(content, "PU0,0;");
    assert.equal(url, "https://bay.example/v1/sandboxes/sandbox-abc123/filesystem/files?path=input%2Fpattern.plt");
    assert.equal(authorization, "Bearer test-token");

    await provider.readText(workspaceRef("bay", "sandbox-abc123", "input/pattern.plt"));
    assert.equal(url, "https://bay.example/v1/sandboxes/sandbox-abc123/filesystem/files?path=input%2Fpattern.plt");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
