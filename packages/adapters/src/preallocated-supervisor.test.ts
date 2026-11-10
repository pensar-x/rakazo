import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { PreallocatedSandboxProvider } from "./preallocated-sandbox.js";
import { createPreallocatedSupervisor } from "./preallocated-supervisor.js";

const token = "pool-fixture-credential-at-least-32-characters";
const controlToken = "authority-fixture-credential-at-least-32-characters";
const servers: Server[] = [];
const directories: string[] = [];
const context = (spaceId = "space-a"): AdapterContext => ({
  operationId: "fixture",
  traceId: "fixture",
  spaceId,
  userId: "user-a",
  signal: new AbortController().signal,
});

async function listen(server: Server) {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "preallocated-"));
  directories.push(directory);
  const files = new Map<string, string>();
  const machine = await listen(
    createServer(async (request, response) => {
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      let output: unknown;
      switch (request.url) {
        case "/rpc/write":
          files.set(input.path, input.content);
          output = { written: true };
          break;
        case "/rpc/read":
          output = { content: files.get(input.path) };
          break;
        case "/rpc/list":
          output = [...files.keys()].map((key) => ({ path: key, kind: "file", size: 1 }));
          break;
        case "/rpc/exec":
          output = { stdout: "fixture-output", stderr: "", code: 0 };
          break;
        case "/rpc/status":
          output = { active_commands: 0 };
          break;
        case "/rpc/cancel":
          output = { settled: true };
          break;
        case "/rpc/reset":
          files.clear();
          output = { reset: true };
          break;
        default:
          response.writeHead(404).end();
          return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(output));
    }),
  );
  const settings = {
    token,
    controlToken,
    slots: [{ id: "one", url: machine, token }],
    stateFile: path.join(directory, "state.json"),
  };
  const url = await listen(await createPreallocatedSupervisor(settings));
  return { url, settings, provider: new PreallocatedSandboxProvider(url, token), files };
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("preallocated computers", () => {
  it("uses the real provider HTTP contract and keeps its portable kind", async () => {
    const { provider } = await fixture();
    const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context());
    expect(computer.kind).toBe("preallocated");
    expect(provider.describe().id).toBe("preallocated");
    expect(await provider.isRunning(computer, context())).toBe(true);
    await provider.writeFile(
      computer,
      { path: "notes.txt", content: Buffer.from("hello") },
      context(),
    );
    expect(Buffer.from(await provider.readFile(computer, "notes.txt", context())).toString()).toBe(
      "hello",
    );
    const events = [];
    for await (const event of provider.execute(computer, { argv: ["echo", "hello"] }, context()))
      events.push(event);
    expect(events).toEqual([
      { type: "stdout", data: "fixture-output" },
      { type: "exit", code: 0 },
    ]);
  });

  it("reconnects the same owner and rejects over-allocation", async () => {
    const { provider } = await fixture();
    const first = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context());
    const resumed = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context());
    expect(resumed.id).toBe(first.id);
    expect(resumed.fresh).toBe(false);
    expect(resumed.started).toBeUndefined();
    await expect(
      provider.provision({ botId: "bot-b", homePath: "/unused" }, context()),
    ).rejects.toThrow("429");
  });

  it("refuses another space or owner even with a valid pool credential", async () => {
    const { provider } = await fixture();
    const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context());
    await expect(provider.readFile(computer, "notes.txt", context("space-b"))).rejects.toThrow(
      "404",
    );
    await expect(
      provider.readFile({ ...computer, botId: "bot-b" }, "notes.txt", context()),
    ).rejects.toThrow("404");
  });

  it("retains ownership over a supervisor restart", async () => {
    const { provider, settings } = await fixture();
    const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context());
    const secondUrl = await listen(await createPreallocatedSupervisor(settings));
    const second = new PreallocatedSandboxProvider(secondUrl, token);
    expect((await second.provision({ botId: "bot-a", homePath: "/unused" }, context())).id).toBe(
      computer.id,
    );
    await expect(
      second.provision({ botId: "bot-b", homePath: "/unused" }, context()),
    ).rejects.toThrow("429");
  });

  it("requires an authority credential to freeze and keeps the pool frozen after restart", async () => {
    const { provider, url, settings } = await fixture();
    await provider.provision({ botId: "bot-a", homePath: "/unused" }, context());
    const denied = await fetch(`${url}/control/quiesce`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(denied.status).toBe(401);
    const frozen = await fetch(`${url}/control/quiesce`, {
      method: "POST",
      headers: { authorization: `Bearer ${controlToken}` },
    });
    expect(frozen.status).toBe(200);
    await expect(
      provider.provision({ botId: "bot-b", homePath: "/unused" }, context()),
    ).rejects.toThrow("503");
    const restart = new PreallocatedSandboxProvider(
      await listen(await createPreallocatedSupervisor(settings)),
      token,
    );
    await expect(
      restart.provision({ botId: "bot-a", homePath: "/unused" }, context()),
    ).rejects.toThrow("503");
  });
});
