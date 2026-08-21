import { execFile } from "node:child_process";
import { readlink } from "node:fs/promises";
import process from "node:process";
import { promisify } from "node:util";

import type { ListeningPort } from "./contract.js";

const execFileAsync = promisify(execFile);
const LSOF_MAX_BUFFER = 4 * 1024 * 1024;

type ParsedEndpoint = Pick<ListeningPort, "address" | "port">;

function parseEndpoint(value: string): ParsedEndpoint | null {
  const match = value.match(/^(.*):(\d+)$/);
  if (!match) return null;

  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;

  let address = match[1];
  if (address.startsWith("[") && address.endsWith("]")) {
    address = address.slice(1, -1);
  }
  if (address === "*") address = "0.0.0.0";

  return { address, port };
}

/** Parse lsof's stable machine-readable `-Fpcn` output. */
export function parseLsofOutput(output: string): Array<{
  address: string;
  command: string;
  pid: number;
  port: number;
}> {
  const records: Array<{
    address: string;
    command: string;
    pid: number;
    port: number;
  }> = [];
  let current:
    | {
        command: string;
        endpoints: ParsedEndpoint[];
        pid: number;
      }
    | undefined;

  const flush = () => {
    if (!current) return;
    for (const endpoint of current.endpoints) {
      records.push({
        address: endpoint.address,
        command: current.command,
        pid: current.pid,
        port: endpoint.port,
      });
    }
  };

  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;

    if (line.startsWith("p")) {
      flush();
      const pid = Number(line.slice(1));
      current = Number.isInteger(pid) && pid > 0 ? { command: "unknown", endpoints: [], pid } : undefined;
      continue;
    }

    if (!current) continue;
    if (line.startsWith("c")) {
      current.command = line.slice(1) || "unknown";
      continue;
    }
    if (line.startsWith("n")) {
      const endpoint = parseEndpoint(line.slice(1));
      if (endpoint) current.endpoints.push(endpoint);
    }
  }
  flush();

  const unique = new Map<string, (typeof records)[number]>();
  for (const record of records) {
    const key = `${record.pid}:${record.port}`;
    const previous = unique.get(key);
    if (!previous || addressPriority(record.address) > addressPriority(previous.address)) {
      unique.set(key, record);
    }
  }
  return [...unique.values()];
}

function addressPriority(address: string): number {
  if (address === "0.0.0.0" || address === "::") return 2;
  if (address === "127.0.0.1" || address === "::1") return 0;
  return 1;
}

function errorCode(error: unknown): number | string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" || typeof code === "string" ? code : undefined;
}

function errorStdout(error: unknown): string {
  if (!error || typeof error !== "object" || !("stdout" in error)) return "";
  const stdout = (error as { stdout?: unknown }).stdout;
  return typeof stdout === "string" ? stdout : "";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Port scan was cancelled.");
}

async function readProcessCwd(pid: number): Promise<string | null> {
  if (process.platform === "linux") {
    try {
      return await readlink(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }

  try {
    const { stdout } = await execFileAsync(
      "lsof",
      ["-a", "-p", String(pid), "-d", "cwd", "-Fn"],
      { maxBuffer: 64 * 1024 },
    );
    const cwd = stdout
      .split(/\r?\n/)
      .find((line: string) => line.startsWith("n"))
      ?.slice(1);
    return cwd || null;
  } catch {
    return null;
  }
}

export async function listListeningPorts(signal?: AbortSignal): Promise<ListeningPort[]> {
  if (process.platform !== "darwin" && process.platform !== "linux" && process.platform !== "freebsd") {
    throw new Error("This host platform is not supported; active-port scanning requires macOS or Linux.");
  }

  throwIfAborted(signal);

  let stdout = "";
  try {
    ({ stdout } = await execFileAsync(
      "lsof",
      ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-Fpcn"],
      { maxBuffer: LSOF_MAX_BUFFER },
    ));
  } catch (error) {
    if (errorCode(error) === 1 && errorStdout(error).trim() === "") return [];
    throw new Error(
      `Unable to inspect listening ports: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const parsed = parseLsofOutput(stdout);
  const cwdByPid = new Map<number, string | null>();
  await Promise.all(
    [...new Set(parsed.map((record) => record.pid))].map(async (pid) => {
      cwdByPid.set(pid, await readProcessCwd(pid));
    }),
  );

  throwIfAborted(signal);
  return parsed
    .map((record) => ({ ...record, cwd: cwdByPid.get(record.pid) ?? null }))
    .sort((left, right) => left.port - right.port || left.pid - right.pid);
}
