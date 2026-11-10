import { randomUUID, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import path from "node:path";
import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { LinuxDesktop, onBotScreen } from "./linux-desktop.js";

interface Slot {
  id: string;
  url: string;
  token: string;
}
interface Allocation {
  id: string;
  slot: string;
  botId: string;
  spaceId: string;
  running: boolean;
}
interface PoolOptions {
  token: string;
  controlToken: string;
  slots: Slot[];
  stateFile: string;
}
const MAX_BYTES = 4 * 1024 * 1024;

/** Socket-free implementation of the supervisor HTTP contract for preallocated machines. */
export async function createPreallocatedSupervisor(options: PoolOptions) {
  if (options.token.length < 32 || options.controlToken.length < 32 || !options.slots.length)
    throw new Error("Invalid pool settings");
  const slots = new Map(options.slots.map((slot) => [slot.id, slot]));
  if (slots.size !== options.slots.length) throw new Error("Duplicate pool slot");
  for (const slot of slots.values()) {
    const url = new URL(slot.url);
    if (url.protocol !== "http:" || url.username || url.password || slot.token.length < 32)
      throw new Error("Invalid pool endpoint");
  }
  let allocations: Allocation[] = [];
  try {
    allocations = JSON.parse(await readFile(options.stateFile, "utf8"));
    if (!Array.isArray(allocations) || allocations.some((item) => !slots.has(item.slot)))
      throw new Error("Invalid pool state");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let stateWrites = Promise.resolve();
  let frozen = false;
  try {
    await readFile(`${options.stateFile}.frozen`);
    frozen = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  async function persist() {
    const state = JSON.stringify(allocations);
    stateWrites = stateWrites.then(async () => {
      await mkdir(path.dirname(options.stateFile), { recursive: true });
      const temporary = `${options.stateFile}.${randomUUID()}`;
      await writeFile(temporary, state, { mode: 0o600 });
      await rename(temporary, options.stateFile);
    });
    await stateWrites;
  }
  function allocation(computer: ComputerRef) {
    const item = allocations.find((item) => item.id === computer.id);
    if (!item) throw new Error("computer not found");
    return item;
  }
  async function call<T>(
    computer: ComputerRef,
    operation: string,
    body: unknown,
    signal: AbortSignal,
  ) {
    const slot = slots.get(allocation(computer).slot)!;
    const response = await fetch(`${slot.url}/rpc/${operation}`, {
      method: "POST",
      headers: { authorization: `Bearer ${slot.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
      redirect: "error",
    });
    if (!response.ok) throw new Error(`Computer operation failed (${response.status})`);
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("Computer response exceeds limit");
    return JSON.parse(text) as T;
  }
  const desktop = new LinuxDesktop({
    environment: async () => ({
      homeDir: "/home/rakazo",
      workspaceDir: "/home/rakazo",
      browserProfilesDir: "/home/rakazo/.browser-profiles",
      displayStart: 20,
      portStart: 6100,
      bindHost: "0.0.0.0",
    }),
    run: (computer, command, context) =>
      call(
        computer,
        "exec",
        {
          argv: ["bash", "-c", command],
          timeoutMs: 120_000,
        },
        context.signal,
      ),
    runWithInput: (computer, command, input, timeoutMs, context) =>
      call(
        computer,
        "exec",
        {
          argv: ["bash", "-c", command],
          stdin: input,
          timeoutMs,
        },
        context.signal,
      ),
    screenUrl: async (computer, port) => {
      const slot = slots.get(allocation(computer).slot)!;
      const { address } = await lookup(new URL(slot.url).hostname);
      const host = address.includes(":") ? `[${address}]` : address;
      return `http://${host}:${port}/vnc.html`;
    },
  });
  async function body(request: IncomingMessage) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_BYTES) throw new Error("Request exceeds limit");
      chunks.push(chunk);
    }
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  }
  function json(response: ServerResponse, value: unknown, status = 200) {
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
  }
  const server = createServer(async (request, response) => {
    const abort = new AbortController();
    response.once("close", () => {
      if (!response.writableEnded) abort.abort();
    });
    try {
      const url = new URL(request.url ?? "/", "http://pool");
      if (url.pathname === "/health" && request.method === "GET") {
        json(response, { ok: true });
        return;
      }
      if (url.pathname === "/control/quiesce" && request.method === "POST") {
        const supplied = Buffer.from(request.headers.authorization ?? "");
        const expected = Buffer.from(`Bearer ${options.controlToken}`);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
          json(response, { error: "Authentication required" }, 401);
          return;
        }
        frozen = true;
        await mkdir(path.dirname(options.stateFile), { recursive: true });
        await writeFile(`${options.stateFile}.frozen`, "quiesced", { mode: 0o600 });
        const outcomes = await Promise.all(
          [...allocations].map(async (item) => {
            const computer: ComputerRef = {
              id: item.id,
              botId: item.botId,
              kind: "preallocated",
              providerRef: item.id,
            };
            await call(computer, "cancel", { all: true }, AbortSignal.timeout(15_000));
            return call<{ active_commands: number }>(
              computer,
              "status",
              {},
              AbortSignal.timeout(10_000),
            );
          }),
        );
        if (outcomes.some((item) => item.active_commands !== 0))
          throw new Error("Commands have not settled");
        json(response, { settled: true, computers: outcomes.length });
        return;
      }
      const supplied = Buffer.from(request.headers.authorization ?? "");
      const expected = Buffer.from(`Bearer ${options.token}`);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        json(response, { error: "Authentication required" }, 401);
        return;
      }
      const spaceId = String(request.headers["x-rakazo-space-id"] ?? "");
      const botId = String(request.headers["x-rakazo-bot-id"] ?? "");
      if (!spaceId || !botId) {
        json(response, { error: "Identity required" }, 400);
        return;
      }
      if (frozen) {
        json(response, { error: "Pool is quiesced" }, 503);
        return;
      }
      if (url.pathname === "/computers" && request.method === "POST") {
        const input = await body(request);
        if (input.botId !== botId || input.spaceId !== spaceId)
          throw new Error("Identity mismatch");
        let item = allocations.find((entry) => entry.botId === botId && entry.spaceId === spaceId);
        const resumed = !!item;
        const started = !item?.running;
        if (!item) {
          const slot = [...slots.keys()].find(
            (id) => !allocations.some((entry) => entry.slot === id),
          );
          if (!slot) {
            json(response, { error: "Computer pool exhausted" }, 429);
            return;
          }
          item = { id: randomUUID(), slot, botId, spaceId, running: true };
          allocations.push(item);
        }
        item.running = true;
        await persist();
        json(response, { id: item.id, resumed, started });
        return;
      }
      const match = /^\/computers\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
      const item =
        match &&
        allocations.find(
          (item) => item.id === match[1] && item.spaceId === spaceId && item.botId === botId,
        );
      if (!item) {
        json(response, { error: "computer not found" }, 404);
        return;
      }
      const computer: ComputerRef = {
        id: item.id,
        botId,
        kind: "preallocated",
        providerRef: item.id,
      };
      const context: AdapterContext = {
        operationId: randomUUID(),
        traceId: randomUUID(),
        spaceId,
        userId: "pool",
        botId: String(request.headers["x-rakazo-screen-id"] ?? botId),
        screenLeaseId: request.headers["x-rakazo-screen-lease-id"] as string | undefined,
        keepScreenWarm: request.headers["x-rakazo-preserve-screen"] === "1",
        cancelRunWork: request.headers["x-rakazo-cancel-run-work"] === "1",
        signal: abort.signal,
      };
      const action = match![2] ?? "";
      if (action === "" && request.method === "GET") {
        const status = await call<object>(computer, "status", {}, abort.signal);
        json(response, { running: item.running, ...status });
        return;
      }
      if ((action === "" && request.method === "DELETE") || action === "stop") {
        await desktop.stopBrowsers(computer, context);
        await call(computer, "cancel", { all: true }, abort.signal);
        if (action === "") {
          await call(computer, "reset", {}, abort.signal);
          allocations = allocations.filter((entry) => entry !== item);
        } else item.running = false;
        await persist();
        json(response, { stopped: true });
        return;
      }
      if (action === "screen" && request.method === "DELETE") {
        await desktop.releaseScreen(computer, context);
        json(response, { released: true });
        return;
      }
      if (action === "files") {
        if (request.method === "GET") {
          const operation = url.searchParams.get("mode") === "list" ? "list" : "read";
          const input = {
            path: url.searchParams.get("path") ?? "",
            ...(url.searchParams.has("maxBytes")
              ? { maxBytes: Number(url.searchParams.get("maxBytes")) }
              : {}),
          };
          json(response, await call(computer, operation, input, abort.signal));
        } else json(response, await call(computer, "write", await body(request), abort.signal));
        return;
      }
      const input = await body(request);
      switch (action) {
        case "exec":
          json(
            response,
            await call(computer, "exec", onBotScreen(input, context, 20), abort.signal),
          );
          break;
        case "browser":
          json(response, await desktop.pageBrowser(computer, input, context));
          break;
        case "screen-mode": {
          if (input.revokeControl !== false && !input.interactive) {
            await desktop.setScreenControl(computer, false, context, input.controlToken);
            json(response, {});
            break;
          }
          const screen = await desktop.connectScreen(
            computer,
            { view: "stream", ...input },
            context,
          );
          json(response, { screenUrl: screen.url });
          break;
        }
        case "terminal":
          json(response, {
            terminalUrl: (await desktop.connectTerminal(computer, input, context)).url,
          });
          break;
        case "input":
          await desktop.sendInput(computer, input.input, context);
          json(response, {});
          break;
        case "observe": {
          const observation = await desktop.observe(computer, context);
          json(response, {
            ...observation,
            image: Buffer.from(observation.image).toString("base64"),
          });
          break;
        }
        case "actions": {
          const result = await desktop.act(computer, input, context);
          json(response, {
            ...result,
            ...(result.observation
              ? {
                  observation: {
                    ...result.observation,
                    image: Buffer.from(result.observation.image).toString("base64"),
                  },
                }
              : {}),
          });
          break;
        }
        default:
          json(response, { error: "Unknown operation" }, 404);
      }
    } catch {
      if (!response.headersSent) json(response, { error: "Computer operation failed" }, 400);
      else response.destroy();
    }
  });
  return server;
}
