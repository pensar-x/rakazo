import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { DockerSandboxProvider } from "./docker-sandbox.js";

/** The supervisor protocol over a fixed pool; homes are portable rather than host mounts. */
export class PreallocatedSandboxProvider extends DockerSandboxProvider {
  override describe() {
    return { ...super.describe(), id: "preallocated" };
  }

  override async provision(
    request: { botId: string; homePath: string; timezone?: string; language?: string },
    context: AdapterContext,
  ): Promise<ComputerRef> {
    return { ...(await super.provision(request, context)), kind: "preallocated" };
  }

  override isRunning(computer: ComputerRef, context: AdapterContext) {
    return super.isRunning({ ...computer, kind: "docker" }, context);
  }
}
