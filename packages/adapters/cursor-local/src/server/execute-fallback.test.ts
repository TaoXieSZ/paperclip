import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { execute } from "./execute.js";
import { createPromptContextFixture } from "@paperclipai/adapter-utils/test-fixtures/prompt-context";

describe("cursor modelFallback", () => {
  it("falls back to the next model after a transient failure", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-cursor-fallback-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "agent.sh");
    const callsPath = path.join(root, "calls.txt");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(commandPath, `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(callsPath)}
case "$*" in
  *model-a*)
    printf '%s\\n' 'Error 429: quota exceeded' >&2
    exit 1
    ;;
esac
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"cursor-session-fallback-1","model":"auto"}'
printf '%s\\n' '{"type":"result","subtype":"success","session_id":"cursor-session-fallback-1","result":"ok"}'
`);
    await fs.chmod(commandPath, 0o755);
    const logs: string[] = [];
    try {
      const result = await execute({
        runId: "run-cursor-model-fallback",
        agent: { id: "agent-1", companyId: "company-1", name: "Cursor Coder", adapterType: "cursor", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command: commandPath,
          cwd: workspace,
          model: "model-a",
          modelFallback: ["model-b"],
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: createPromptContextFixture(),
        authToken: "run-jwt-token",
        onLog: async (_stream: string, chunk: string) => { logs.push(chunk); },
      });

      expect(result.exitCode).toBe(0);
      expect(result.model).toBe("model-b");
      const calls = await fs.readFile(callsPath, "utf8");
      const modelArgs = [...calls.matchAll(/--model (\S+)/g)].map((m) => m[1]);
      expect(modelArgs).toEqual(["model-a", "model-b"]);
      expect(logs.join("")).toContain('falling back to "model-b"');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not fall back on non-transient failure", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-cursor-fallback-hard-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "agent.sh");
    const callsPath = path.join(root, "calls.txt");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(commandPath, `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(callsPath)}
printf '%s\\n' 'fatal: invalid configuration' >&2
exit 2
`);
    await fs.chmod(commandPath, 0o755);
    try {
      const result = await execute({
        runId: "run-cursor-model-no-fallback",
        agent: { id: "agent-1", companyId: "company-1", name: "Cursor Coder", adapterType: "cursor", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command: commandPath,
          cwd: workspace,
          model: "model-a",
          modelFallback: ["model-b"],
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: createPromptContextFixture(),
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).not.toBe(0);
      const calls = await fs.readFile(callsPath, "utf8");
      expect([...calls.matchAll(/--model (\S+)/g)].map((m) => m[1])).toEqual(["model-a"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
