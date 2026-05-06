/**
 * P228: Cubic Runtime Abstraction — RuntimeProvider interface
 *
 * Each execution backend (subprocess, container, remote) implements RuntimeProvider.
 * The SubprocessProvider wraps Node.js child_process.spawn for local CLI execution.
 *
 * Message passing (send/recv) delegates to the A2AMessenger for inter-agent comms.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

// ─── RuntimeProvider interface ────────────────────────────────────────────────

export interface SpawnOptions {
  cwd: string;
  modelOverride?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  stdin?: string;
}

export interface SpawnedAgent {
  processId: string;
  /** Optional status/health URL if the backend exposes one */
  statusUrl?: string;
}

export interface AgentMessage {
  type: string;
  content: unknown;
}

export interface HealthStatus {
  status: "running" | "idle" | "error";
  uptime_ms?: number;
  memory_mb?: number;
}

export interface ShutdownResult {
  exit_code: number | null;
  output?: string;
}

export interface RuntimeProvider {
  /** Spawn a new agent process/container with the given task. */
  spawn(task: string, options: SpawnOptions): Promise<SpawnedAgent>;

  /** Send a message from this runtime to a running agent. */
  send(agentId: string, message: AgentMessage): Promise<void>;

  /** Receive the next pending message for an agent (null = no message within timeout). */
  recv(agentId: string, timeoutMs?: number): Promise<AgentMessage | null>;

  /** Health check for a spawned agent. */
  health(processId: string): Promise<HealthStatus>;

  /** Graceful shutdown: SIGTERM → wait → SIGKILL. */
  shutdown(processId: string, timeoutMs?: number): Promise<ShutdownResult>;

  /** Cleanup stale processes or resources. */
  cleanup(): Promise<void>;
}

// ─── SubprocessProvider ───────────────────────────────────────────────────────

interface ProcessEntry {
  child: ChildProcess;
  argv: string[];
  startedAt: number;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  done: boolean;
}

/**
 * SubprocessProvider: local CLI subprocess execution backend.
 *
 * Each spawn() forks a child process. Messages are NOT supported inline
 * (use A2AMessenger for inter-agent comms). Health() polls the OS process
 * table. Shutdown() sends SIGTERM then escalates to SIGKILL.
 */
export class SubprocessProvider implements RuntimeProvider {
  private processes = new Map<string, ProcessEntry>();

  async spawn(task: string, options: SpawnOptions): Promise<SpawnedAgent> {
    const processId = randomUUID();
    const argv = ["claude", "--print", task];
    if (options.modelOverride) {
      argv.splice(2, 0, "--model", options.modelOverride);
    }

    const env = {
      ...process.env,
      ...options.env,
    } as Record<string, string>;

    const child: ChildProcess = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env,
      stdio: [
        options.stdin !== undefined ? "pipe" : "ignore",
        "pipe",
        "pipe",
      ],
    });

    const entry: ProcessEntry = {
      child,
      argv,
      startedAt: Date.now(),
      stdout: "",
      stderr: "",
      exitCode: null,
      done: false,
    };

    child.stdout?.on("data", (d: Buffer) => {
      entry.stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      entry.stderr += d.toString();
    });
    child.on("close", (code) => {
      entry.exitCode = code;
      entry.done = true;
    });

    if (options.stdin !== undefined) {
      child.stdin?.end(options.stdin);
    }

    if (options.timeoutMs) {
      setTimeout(() => {
        if (!entry.done) {
          child.kill("SIGTERM");
          setTimeout(() => {
            if (!entry.done && !child.killed) {
              child.kill("SIGKILL");
            }
          }, 10_000);
        }
      }, options.timeoutMs);
    }

    this.processes.set(processId, entry);
    return { processId };
  }

  async send(_agentId: string, _message: AgentMessage): Promise<void> {
    // Delegates to A2AMessenger — SubprocessProvider does not own the message channel.
    // Callers should use A2AMessenger.send() for inter-agent communication.
  }

  async recv(_agentId: string, _timeoutMs?: number): Promise<AgentMessage | null> {
    // Delegates to A2AMessenger
    return null;
  }

  async health(processId: string): Promise<HealthStatus> {
    const entry = this.processes.get(processId);
    if (!entry) {
      return { status: "error" };
    }

    if (entry.done) {
      return {
        status: entry.exitCode === 0 ? "idle" : "error",
        uptime_ms: Date.now() - entry.startedAt,
      };
    }

    // Process is alive: check OS-level liveness
    const alive = isProcessAlive(entry.child.pid);
    const memMb = getProcessMemoryMb(entry.child.pid);

    return {
      status: alive ? "running" : "error",
      uptime_ms: Date.now() - entry.startedAt,
      memory_mb: memMb ?? undefined,
    };
  }

  async shutdown(
    processId: string,
    timeoutMs = 8_000,
  ): Promise<ShutdownResult> {
    const entry = this.processes.get(processId);
    if (!entry) {
      return { exit_code: null, output: "process not found" };
    }
    if (entry.done) {
      return { exit_code: entry.exitCode, output: entry.stdout.slice(-500) };
    }

    entry.child.kill("SIGTERM");

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !entry.done) {
      await new Promise((r) => setTimeout(r, 100));
    }

    if (!entry.done) {
      entry.child.kill("SIGKILL");
      await new Promise((r) => setTimeout(r, 200));
    }

    this.processes.delete(processId);
    return {
      exit_code: entry.exitCode,
      output: entry.stdout.slice(-500),
    };
  }

  async cleanup(): Promise<void> {
    const staleThresholdMs = 10 * 60 * 1000; // 10 minutes
    const now = Date.now();

    for (const [id, entry] of this.processes) {
      if (entry.done || now - entry.startedAt > staleThresholdMs) {
        if (!entry.done) {
          entry.child.kill("SIGKILL");
        }
        this.processes.delete(id);
      }
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0); // signal 0 = check existence
    return true;
  } catch {
    return false;
  }
}

function getProcessMemoryMb(pid: number | undefined): number | null {
  if (!pid) return null;
  try {
    const { execSync } = require("node:child_process");
    const out: string = execSync(`ps -o rss= -p ${pid} 2>/dev/null`, {
      encoding: "utf8",
    }).trim();
    const kb = parseInt(out, 10);
    return isNaN(kb) ? null : Math.round(kb / 1024);
  } catch {
    return null;
  }
}
