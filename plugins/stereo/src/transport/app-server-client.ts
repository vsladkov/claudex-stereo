import fs from "node:fs";
import net from "node:net";
import process from "node:process";
import { spawn } from "node:child_process";
import readline from "node:readline";
import type { ChildProcessByStdio } from "node:child_process";
import type { Interface as ReadlineInterface } from "node:readline";
import type { Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import { parseBrokerEndpoint } from "../broker/endpoint.ts";
import { ensureBrokerSession, loadBrokerSession } from "../broker/lifecycle.ts";
import { terminateProcessTree } from "../platform/process.ts";
import type {
  AppServerMethod,
  AppServerNotification,
  AppServerNotificationHandler,
  AppServerRequestParams,
  AppServerResponse,
  ClientInfo,
  CodexAppServerClientOptions,
  InitializeCapabilities
} from "../protocol/app-server.ts";

type ProtocolError = Error & { data?: unknown; rpcCode?: number };

interface PendingRequest {
  // The pending map is heterogeneous across methods, so the per-method result
  // type is erased at the storage boundary.
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  method: string;
}

const PLUGIN_MANIFEST_URL = new URL("../../.claude-plugin/plugin.json", import.meta.url);
const PLUGIN_MANIFEST = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_URL, "utf8"));

export const BROKER_ENDPOINT_ENV = "CODEX_COMPANION_APP_SERVER_ENDPOINT";
export const BROKER_BUSY_RPC_CODE = -32001;

const DEFAULT_CLIENT_INFO: ClientInfo = {
  title: "Codex Plugin",
  name: "Claude Code",
  version: PLUGIN_MANIFEST.version ?? "0.0.0"
};

const DEFAULT_CAPABILITIES: InitializeCapabilities = {
  experimentalApi: false,
  requestAttestation: false,
  optOutNotificationMethods: [
    "item/agentMessage/delta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
    "item/reasoning/textDelta"
  ]
};

function buildJsonRpcError(code: number, message: string, data?: unknown): { code: number; message: string; data?: unknown } {
  return data === undefined ? { code, message } : { code, message, data };
}

function createProtocolError(message: string, data?: unknown): ProtocolError {
  const error = new Error(message) as ProtocolError;
  error.data = data;
  const typedData = data as { code?: number } | null | undefined;
  if (typedData?.code !== undefined) {
    error.rpcCode = typedData.code;
  }
  return error;
}

class AppServerClientBase {
  declare cwd: string;
  declare options: CodexAppServerClientOptions;
  declare pending: Map<number, PendingRequest>;
  declare nextId: number;
  declare stderr: string;
  declare closed: boolean;
  declare exitResolved: boolean;
  declare exitError: Error | null;
  declare notificationHandler: AppServerNotificationHandler | null;
  declare lineBuffer: string;
  declare transport: string;
  declare exitPromise: Promise<unknown>;
  declare resolveExit: (value?: unknown) => void;

  constructor(cwd: string, options: CodexAppServerClientOptions = {}) {
    this.cwd = cwd;
    this.options = options;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.closed = false;
    this.exitResolved = false;
    this.exitError = null;
    this.notificationHandler = null;
    this.lineBuffer = "";
    this.transport = "unknown";

    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  setNotificationHandler(handler: AppServerNotificationHandler | null): void {
    this.notificationHandler = handler;
  }

  request<M extends AppServerMethod>(method: M, params: AppServerRequestParams<M>): Promise<AppServerResponse<M>> {
    if (this.closed) {
      return Promise.reject(new Error("codex app-server client is closed."));
    }
    if (this.exitResolved) {
      return Promise.reject(this.exitError ?? new Error("codex app-server connection closed."));
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.sendMessage({ id, method, params });
    });
  }

  notify(method: string, params: unknown = {}): void {
    if (this.closed) {
      return;
    }
    this.sendMessage({ method, params });
  }

  handleChunk(chunk: string | Buffer): void {
    this.lineBuffer += chunk;
    let newlineIndex = this.lineBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.lineBuffer.slice(0, newlineIndex);
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.lineBuffer.indexOf("\n");
    }
  }

  handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.handleExit(createProtocolError(`Failed to parse codex app-server JSONL: ${(error as Error).message}`, { line }));
      return;
    }

    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(createProtocolError(message.error.message ?? `codex app-server ${pending.method} failed.`, message.error));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (message.method && this.notificationHandler) {
      this.notificationHandler(message as AppServerNotification);
    }
  }

  handleServerRequest(message: { id?: unknown; method?: unknown }): void {
    process.stderr.write(`Unsupported codex app-server request: ${message.method}\n`);
    try {
      this.sendMessage({
        id: message.id,
        error: buildJsonRpcError(-32601, `Unsupported server request: ${message.method}`)
      });
    } catch {
      // The transport may already be gone; dropping the reply is fine.
    }
  }

  handleExit(error?: Error | null): void {
    if (this.exitResolved) {
      return;
    }

    this.exitResolved = true;
    this.exitError = error ?? null;

    for (const pending of this.pending.values()) {
      pending.reject(this.exitError ?? new Error("codex app-server connection closed."));
    }
    this.pending.clear();
    this.resolveExit(undefined);
  }

  sendMessage(_message: unknown): void {
    throw new Error("sendMessage must be implemented by subclasses.");
  }
}

class SpawnedCodexAppServerClient extends AppServerClientBase {
  declare proc?: ChildProcessByStdio<Writable, Readable, Readable>;
  declare readline?: ReadlineInterface;

  constructor(cwd: string, options: CodexAppServerClientOptions = {}) {
    super(cwd, options);
    this.transport = "direct";
  }

  async initialize(): Promise<void> {
    this.proc = spawn("codex", ["app-server"], {
      cwd: this.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32" ? (process.env.SHELL || true) : false,
      windowsHide: true
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });

    this.proc.on("error", (error) => {
      this.handleExit(error);
    });

    this.proc.on("exit", (code, signal) => {
      const stderr = this.stderr.trim();
      const detail =
        code === 0
          ? null
          : createProtocolError(
              `codex app-server exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).${stderr ? `\n${stderr}` : ""}`
            );
      this.handleExit(detail);
    });

    this.readline = readline.createInterface({ input: this.proc.stdout });
    this.readline.on("line", (line) => {
      this.handleLine(line);
    });

    await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
    });
    this.notify("initialized", {});
  }

  async close(): Promise<void> {
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;

    if (this.readline) {
      this.readline.close();
    }

    if (this.proc && !this.proc.killed) {
      this.proc.stdin.end();
      setTimeout(() => {
        if (this.proc && !this.proc.killed && this.proc.exitCode === null) {
          // On Windows with shell: true, the direct child is cmd.exe.
          // Use terminateProcessTree to kill the entire tree including
          // the grandchild node process.
          if (process.platform === "win32") {
            try {
              terminateProcessTree(this.proc.pid as number);
            } catch {
              // Best-effort cleanup inside an unref'd timer — swallow errors
              // to avoid crashing the host process during shutdown.
            }
          } else {
            this.proc.kill("SIGTERM");
          }
        }
      }, 50).unref?.();
    }

    await this.exitPromise;
  }

  override sendMessage(message: unknown): void {
    const line = `${JSON.stringify(message)}\n`;
    const stdin = this.proc?.stdin;
    if (!stdin) {
      throw new Error("codex app-server stdin is not available.");
    }
    stdin.write(line);
  }
}

class BrokerCodexAppServerClient extends AppServerClientBase {
  declare endpoint: string | undefined;
  declare socket?: Socket;

  constructor(cwd: string, options: CodexAppServerClientOptions = {}) {
    super(cwd, options);
    this.transport = "broker";
    this.endpoint = options.brokerEndpoint;
  }

  async initialize(): Promise<void> {
    await new Promise((resolve, reject) => {
      const target = parseBrokerEndpoint(this.endpoint as string);
      this.socket = net.createConnection({ path: target.path });
      this.socket.setEncoding("utf8");
      this.socket.on("connect", resolve);
      this.socket.on("data", (chunk) => {
        this.handleChunk(chunk);
      });
      this.socket.on("error", (error) => {
        if (!this.exitResolved) {
          reject(error);
        }
        this.handleExit(error);
      });
      this.socket.on("close", () => {
        this.handleExit(this.exitError);
      });
    });

    await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
    });
    this.notify("initialized", {});
  }

  async close(): Promise<void> {
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;
    if (this.socket) {
      this.socket.end();
    }
    await this.exitPromise;
  }

  override sendMessage(message: unknown): void {
    const line = `${JSON.stringify(message)}\n`;
    const socket = this.socket;
    if (!socket) {
      throw new Error("codex app-server broker connection is not connected.");
    }
    socket.write(line);
  }
}

export class CodexAppServerClient {
  static async connect(cwd: string, options: CodexAppServerClientOptions = {}): Promise<SpawnedCodexAppServerClient | BrokerCodexAppServerClient> {
    let brokerEndpoint: string | null | undefined = null;
    if (!options.disableBroker) {
      brokerEndpoint = options.brokerEndpoint ?? options.env?.[BROKER_ENDPOINT_ENV] ?? process.env[BROKER_ENDPOINT_ENV] ?? null;
      if (!brokerEndpoint && options.reuseExistingBroker) {
        brokerEndpoint = loadBrokerSession(cwd)?.endpoint ?? null;
      }
      if (!brokerEndpoint && !options.reuseExistingBroker) {
        const brokerSession = await ensureBrokerSession(cwd, { env: options.env });
        brokerEndpoint = brokerSession?.endpoint ?? null;
      }
    }
    const client = brokerEndpoint
      ? new BrokerCodexAppServerClient(cwd, { ...options, brokerEndpoint })
      : new SpawnedCodexAppServerClient(cwd, options);
    try {
      await client.initialize();
    } catch (error) {
      // initialize() establishes the transport before the RPC; a failed RPC
      // must not leak the spawned child process or broker socket.
      await client.close().catch(() => {});
      throw error;
    }
    return client;
  }
}
