import { type BbPluginApi } from "@get-bb/plugin-sdk";

import {
  hostContract,
  portSnapshotSchema,
  rpcContract,
  type ListeningPort,
} from "./contract.js";

export { rpcContract } from "./contract.js";
export type { PortSnapshot, VisiblePort, WorkspacePorts } from "./contract.js";

type ConnectedHost = {
  id: string;
  name: string;
  status: "connected" | "disconnected";
};

type WorkspaceLocation = {
  hostId: string;
  id: string;
  name: string;
  path: string;
};

type PortScan = {
  host: ConnectedHost;
  ports: ListeningPort[];
  error?: string;
};

type HostPortScanner = (hostId: string) => Promise<{ ports: ListeningPort[] }>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized || "/";
}

function isWithinPath(candidate: string, root: string): boolean {
  const normalizedCandidate = normalizePath(candidate);
  const normalizedRoot = normalizePath(root);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

function shortWorkspaceName(projectName: string | undefined, environmentName: string | null): string {
  if (projectName && environmentName && environmentName !== projectName) {
    return `${projectName} · ${environmentName}`;
  }
  return projectName ?? environmentName ?? "Workspace";
}

async function listOpenThreads(bb: BbPluginApi): Promise<Awaited<ReturnType<typeof bb.sdk.threads.list>>> {
  const threads: Awaited<ReturnType<typeof bb.sdk.threads.list>> = [];
  const pageSize = 200;
  for (let offset = 0; ; offset += pageSize) {
    const page = await bb.sdk.threads.list({
      archived: false,
      includeHidden: true,
      limit: pageSize,
      offset,
    });
    threads.push(...page);
    if (page.length < pageSize) return threads;
  }
}

async function collectWorkspaceLocations(bb: BbPluginApi): Promise<WorkspaceLocation[]> {
  const [projects, threads] = await Promise.all([
    bb.sdk.projects.list({ includePersonal: true }),
    listOpenThreads(bb),
  ]);
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const environmentIds = [
    ...new Set(threads.flatMap((thread) => (thread.environmentId ? [thread.environmentId] : []))),
  ];
  const environments = await Promise.all(
    environmentIds.map(async (environmentId) => {
      try {
        return await bb.sdk.environments.get({ environmentId });
      } catch {
        return null;
      }
    }),
  );

  const locations: WorkspaceLocation[] = [];
  for (const environment of environments) {
    if (!environment?.path) continue;
    const project = projectById.get(environment.projectId);
    locations.push({
      hostId: environment.hostId,
      id: `environment:${environment.id}`,
      name: shortWorkspaceName(project?.name, environment.name),
      path: environment.path,
    });
  }

  for (const project of projects) {
    for (const source of project.sources) {
      locations.push({
        hostId: source.hostId,
        id: `project:${project.id}:${source.id}`,
        name: project.name,
        path: source.path,
      });
    }
  }

  return locations.sort((left, right) => right.path.length - left.path.length);
}

function findLocation(port: ListeningPort, hostId: string, locations: WorkspaceLocation[]): WorkspaceLocation | null {
  if (!port.cwd) return null;
  return locations.find((location) => location.hostId === hostId && isWithinPath(port.cwd!, location.path)) ?? null;
}

function visiblePort(port: ListeningPort, host: ConnectedHost) {
  return {
    ...port,
    hostId: host.id,
    hostName: host.name,
    key: `${host.id}:${port.pid}:${port.port}`,
  };
}

async function scanHosts(bb: BbPluginApi, scanHost: HostPortScanner): Promise<PortScan[]> {
  const hosts = (await bb.sdk.hosts.list()).map((host) => ({
    id: host.id,
    name: host.name,
    status: host.status,
  }));
  const connectedHosts = hosts.filter((host) => host.status === "connected");
  return Promise.all(
    connectedHosts.map(async (host) => {
      try {
        return { host, ports: (await scanHost(host.id)).ports };
      } catch (error) {
        return { host, ports: [], error: errorMessage(error) };
      }
    }),
  );
}

function localPortUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export default async function plugin(bb: BbPluginApi) {
  const hostRpc = bb.hosts.experimental_client({ contract: hostContract });
  const scanHost: HostPortScanner = (hostId) =>
    hostRpc.call("listListeningPorts", null, { hostId });

  bb.rpc.register(rpcContract, {
    async listPorts() {
      const [scans, locations] = await Promise.all([
        scanHosts(bb, scanHost),
        collectWorkspaceLocations(bb),
      ]);
      const workspaces = new Map<
        string,
        {
          hostId: string;
          hostName: string;
          id: string;
          name: string;
          path: string | null;
          ports: ReturnType<typeof visiblePort>[];
        }
      >();
      const external: ReturnType<typeof visiblePort>[] = [];
      const errors: Array<{ hostId: string; hostName: string; message: string }> = [];

      for (const scan of scans) {
        if (scan.error) {
          errors.push({ hostId: scan.host.id, hostName: scan.host.name, message: scan.error });
        }
        for (const port of scan.ports) {
          const item = visiblePort(port, scan.host);
          const location = findLocation(port, scan.host.id, locations);
          if (!location) {
            external.push(item);
            continue;
          }

          const groupId = `${scan.host.id}:${location.id}`;
          const group = workspaces.get(groupId) ?? {
            hostId: scan.host.id,
            hostName: scan.host.name,
            id: groupId,
            name: location.name,
            path: location.path,
            ports: [],
          };
          group.ports.push(item);
          workspaces.set(groupId, group);
        }
      }

      const sortedWorkspaces = [...workspaces.values()]
        .filter((workspace) => workspace.ports.length > 0)
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const workspace of sortedWorkspaces) {
        workspace.ports.sort((left, right) => left.port - right.port || left.pid - right.pid);
      }
      external.sort((left, right) => left.port - right.port || left.pid - right.pid);

      return portSnapshotSchema.parse({
        checkedAt: Date.now(),
        errors,
        external,
        hostCount: scans.length,
        totalPorts: sortedWorkspaces.reduce((total, workspace) => total + workspace.ports.length, 0) + external.length,
        workspaces: sortedWorkspaces,
      });
    },

    async openPort({ hostId, port }) {
      const host = (await bb.sdk.hosts.list()).find((candidate) => candidate.id === hostId);
      if (!host || host.status !== "connected") {
        throw new Error("That host is not connected. Refresh the Ports panel and try again.");
      }

      const result = await hostRpc.call("listListeningPorts", null, { hostId });
      if (!result.ports.some((candidate) => candidate.port === port)) {
        throw new Error(`Port ${port} is no longer listening. Refresh the Ports panel and try again.`);
      }

      const storageKey = `exposed-ports:${hostId}`;
      const previous = (await bb.storage.kv.get<number[]>(storageKey)) ?? [];
      const activePorts = new Set(result.ports.map((candidate) => candidate.port));
      const exposedPorts = [...new Set([...previous, port])].filter((candidate) => activePorts.has(candidate));

      try {
        const tunnel = await bb.hosts.ensureSharedPortTunnel(hostId);
        bb.hosts.declareSharedPorts(hostId, exposedPorts);
        await bb.storage.kv.set(storageKey, exposedPorts);
        return {
          url: `https://${tunnel.label}--${port}.${tunnel.baseDomain}`,
          viaTunnel: true,
        };
      } catch (error) {
        bb.log.debug(`Shared port tunnel unavailable for ${hostId}: ${errorMessage(error)}`);
        return { url: localPortUrl(port), viaTunnel: false };
      }
    },

    async killPort({ hostId, pid, port }) {
      const host = (await bb.sdk.hosts.list()).find((candidate) => candidate.id === hostId);
      if (!host || host.status !== "connected") {
        throw new Error("That host is not connected. Refresh the Ports panel and try again.");
      }

      const result = await hostRpc.call("killProcess", { pid, port }, { hostId });
      bb.realtime.publish("ports.changed", { hostId, pid, port });
      return { hostId, killed: result.killed, pid: result.pid, port: result.port };
    },
  });
}
