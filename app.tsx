import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  definePluginApp,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { PortSnapshot, VisiblePort, WorkspacePorts } from "./contract";
import type { rpcContract } from "./contract";
import { Button } from "@/components/ui/button";
import type { ButtonProps } from "@/components/ui/button";
import { Icon, type IconName } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";

function formatAddress(address: string, port: number): string {
  const displayAddress = address === "0.0.0.0" || address === "::" ? "localhost" : address;
  return `${displayAddress}:${port}`;
}

function shortenPath(path: string | null): string {
  if (!path) return "No working directory";
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path;
}

function matchesQuery(port: VisiblePort, query: string): boolean {
  if (!query) return true;
  const haystack = `${port.port} ${port.command} ${port.address} ${port.cwd ?? ""} ${port.hostName}`.toLowerCase();
  return haystack.includes(query);
}

type IconActionProps = {
  className?: string;
  disabled?: boolean;
  icon: IconName;
  label: string;
  onClick(): void;
  variant?: ButtonProps["variant"];
};

function IconAction({ className, disabled, icon, label, onClick, variant = "ghost" }: IconActionProps) {
  return (
    <Button asChild size="icon" variant={variant} className={className} disabled={disabled}>
      <button type="button" title={label} aria-label={label} onClick={onClick} disabled={disabled}>
        <Icon name={icon} aria-hidden="true" />
      </button>
    </Button>
  );
}

type PortRowProps = {
  isCopied: boolean;
  isCopying: boolean;
  isOpening: boolean;
  isPendingKill: boolean;
  isKilling: boolean;
  onCancelKill(): void;
  onCopy(): void;
  onKill(): void;
  onOpen(): void;
  port: VisiblePort;
  requestKill(): void;
};

function PortRow({
  isCopied,
  isCopying,
  isOpening,
  isPendingKill,
  isKilling,
  onCancelKill,
  onCopy,
  onKill,
  onOpen,
  port,
  requestKill,
}: PortRowProps) {
  return (
    <div className="flex items-center gap-3 border-b border-border/60 px-4 py-3 last:border-b-0 hover:bg-state-hover">
      <button
        type="button"
        className="w-16 shrink-0 cursor-pointer text-left font-mono text-lg font-semibold tabular-nums text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={onOpen}
        aria-label={`Open port ${port.port}`}
      >
        {port.port}
      </button>

      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground" title={port.command}>
          {port.command}
        </div>
        <div className="truncate text-xs text-muted-foreground" title={port.cwd ?? undefined}>
          {formatAddress(port.address, port.port)}
          <span className="px-1.5 text-border">·</span>
          {shortenPath(port.cwd)}
        </div>
      </div>

      {isPendingKill ? (
        <div className="flex shrink-0 items-center gap-1.5" role="group" aria-label={`Confirm killing ${port.command}`}>
          <span className="hidden text-xs text-muted-foreground sm:inline">Stop process?</span>
          <IconAction
            icon={isKilling ? "Loading" : "Check"}
            label={isKilling ? "Stopping process" : `Confirm kill for port ${port.port}`}
            variant="destructive"
            onClick={onKill}
            disabled={isKilling}
            className={isKilling ? "[&_svg]:animate-spin" : undefined}
          />
          <IconAction icon="X" label="Cancel kill" onClick={onCancelKill} disabled={isKilling} />
        </div>
      ) : (
        <div className="flex shrink-0 items-center gap-0.5">
          <IconAction
            icon="ExternalLink"
            label={`Open port ${port.port}`}
            variant="outline"
            onClick={onOpen}
            disabled={isOpening}
          />
          <IconAction
            icon={isCopied ? "Check" : "Copy"}
            label={isCopied ? "URL copied" : `Copy URL for port ${port.port}`}
            onClick={onCopy}
            disabled={isCopying}
          />
          <IconAction
            icon="Trash2"
            label={`Kill ${port.command} on port ${port.port}`}
            className="text-destructive hover:text-destructive"
            onClick={requestKill}
          />
        </div>
      )}
    </div>
  );
}

type PortSectionProps = {
  emptyLabel?: string;
  label: string;
  ports: VisiblePort[];
  renderPort: (port: VisiblePort) => ReactNode;
};

function PortSection({ emptyLabel, label, ports, renderPort }: PortSectionProps) {
  if (ports.length === 0 && !emptyLabel) return null;

  return (
    <section className="border-b border-border last:border-b-0" aria-label={label}>
      <div className="flex items-center justify-between bg-muted/35 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Icon
            name={label === "External ports" ? "Globe" : "FolderOpen"}
            className="size-4 text-muted-foreground"
            aria-hidden="true"
          />
          <h2 className="truncate text-sm font-medium text-foreground">{label}</h2>
        </div>
        <span className="rounded-full bg-background px-2 py-0.5 text-xs tabular-nums text-muted-foreground">
          {ports.length}
        </span>
      </div>
      {ports.length > 0 ? (
        <div>{ports.map(renderPort)}</div>
      ) : (
        <p className="px-4 py-4 text-sm text-muted-foreground">{emptyLabel}</p>
      )}
    </section>
  );
}

function PortsPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const connectionState = useRealtimeConnectionState();
  const [snapshot, setSnapshot] = useState<PortSnapshot | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [copyingKey, setCopyingKey] = useState<string | null>(null);
  const [openingKey, setOpeningKey] = useState<string | null>(null);
  const [pendingKillKey, setPendingKillKey] = useState<string | null>(null);
  const [killingKey, setKillingKey] = useState<string | null>(null);
  const copyResetTimer = useRef<number | null>(null);
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    const currentRequest = ++requestId.current;
    setLoading(true);
    try {
      const next = await rpc.call("listPorts");
      if (currentRequest === requestId.current) {
        setSnapshot(next);
        setError(
          next.errors.length > 0
            ? next.errors.map((scanError) => `${scanError.hostName}: ${scanError.message}`).join(" · ")
            : null,
        );
      }
    } catch (refreshError) {
      if (currentRequest === requestId.current) {
        setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
      }
    } finally {
      if (currentRequest === requestId.current) setLoading(false);
    }
  }, [rpc]);

  useRealtime(
    "ports.changed",
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    if (connectionState === "connected") void refresh();
  }, [connectionState, refresh]);

  useEffect(
    () => () => {
      if (copyResetTimer.current !== null) window.clearTimeout(copyResetTimer.current);
    },
    [],
  );

  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const filterPorts = (ports: VisiblePort[]) => ports.filter((port) => matchesQuery(port, normalizedQuery));
    const workspaces = (snapshot?.workspaces ?? [])
      .map((workspace) => ({ ...workspace, ports: filterPorts(workspace.ports) }))
      .filter((workspace) => workspace.ports.length > 0);
    return { external: filterPorts(snapshot?.external ?? []), workspaces };
  }, [query, snapshot]);

  const resolvePortUrl = useCallback(
    (port: VisiblePort) => rpc.call("openPort", { hostId: port.hostId, port: port.port }),
    [rpc],
  );

  const openPort = useCallback(
    async (port: VisiblePort) => {
      setOpeningKey(port.key);
      setError(null);
      try {
        const result = await resolvePortUrl(port);
        const opened = window.open(result.url, "_blank", "noopener,noreferrer");
        if (!opened) window.location.assign(result.url);
      } catch (openError) {
        setError(openError instanceof Error ? openError.message : String(openError));
      } finally {
        setOpeningKey(null);
      }
    },
    [resolvePortUrl],
  );

  const copyPortUrl = useCallback(
    async (port: VisiblePort) => {
      setCopyingKey(port.key);
      setError(null);
      try {
        const result = await resolvePortUrl(port);
        if (!navigator.clipboard?.writeText) {
          throw new Error("Clipboard access is unavailable in this browser.");
        }
        await navigator.clipboard.writeText(result.url);
        setCopiedKey(port.key);
        if (copyResetTimer.current !== null) window.clearTimeout(copyResetTimer.current);
        copyResetTimer.current = window.setTimeout(() => {
          setCopiedKey((current) => (current === port.key ? null : current));
          copyResetTimer.current = null;
        }, 1600);
      } catch (copyError) {
        setError(copyError instanceof Error ? copyError.message : String(copyError));
      } finally {
        setCopyingKey(null);
      }
    },
    [resolvePortUrl],
  );

  const killPort = useCallback(
    async (port: VisiblePort) => {
      setKillingKey(port.key);
      setError(null);
      try {
        await rpc.call("killPort", { hostId: port.hostId, pid: port.pid, port: port.port });
        setPendingKillKey(null);
        await refresh();
      } catch (killError) {
        setError(killError instanceof Error ? killError.message : String(killError));
      } finally {
        setKillingKey(null);
      }
    },
    [refresh, rpc],
  );

  const workspaceCount = snapshot?.workspaces.length ?? 0;
  const externalCount = snapshot?.external.length ?? 0;
  const summary = snapshot
    ? `${workspaceCount} workspace${workspaceCount === 1 ? "" : "s"} · ${externalCount} external`
    : "Scanning hosts…";

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground" aria-busy={loading}>
      <div className="border-b border-border bg-card/40 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">Listening now</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{summary}</p>
          </div>
          <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter ports, processes, or paths"
            aria-label="Filter active ports"
          />
          <span className="hidden whitespace-nowrap text-xs text-muted-foreground sm:inline">
            {connectionState === "reconnecting" ? "Reconnecting…" : "Auto-refresh 10s"}
          </span>
        </div>
      </div>

      {error ? (
        <div className="mx-4 mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
          {error}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {filtered.workspaces.length === 0 && filtered.external.length === 0 ? (
          <div className="flex min-h-56 flex-col items-center justify-center px-6 text-center">
            <p className="text-sm font-medium">{query ? "No matching ports" : "No active ports"}</p>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              {query ? "Try a different process name, port number, or path." : "Ports listening on connected hosts will appear here."}
            </p>
          </div>
        ) : (
          <>
            {filtered.workspaces.map((workspace: WorkspacePorts) => (
              <PortSection
                key={workspace.id}
                label={workspace.name}
                ports={workspace.ports}
                renderPort={(port) => (
                  <PortRow
                    key={port.key}
                    isCopied={copiedKey === port.key}
                    isCopying={copyingKey === port.key}
                    port={port}
                    isOpening={openingKey === port.key}
                    isPendingKill={pendingKillKey === port.key}
                    isKilling={killingKey === port.key}
                    onOpen={() => void openPort(port)}
                    onCopy={() => void copyPortUrl(port)}
                    requestKill={() => setPendingKillKey(port.key)}
                    onCancelKill={() => setPendingKillKey(null)}
                    onKill={() => void killPort(port)}
                  />
                )}
              />
            ))}
            <PortSection
              label="External ports"
              ports={filtered.external}
              emptyLabel={query ? "No external ports match the filter." : undefined}
              renderPort={(port) => (
                <PortRow
                  key={port.key}
                  isCopied={copiedKey === port.key}
                  isCopying={copyingKey === port.key}
                  port={port}
                  isOpening={openingKey === port.key}
                  isPendingKill={pendingKillKey === port.key}
                  isKilling={killingKey === port.key}
                  onOpen={() => void openPort(port)}
                  onCopy={() => void copyPortUrl(port)}
                  requestKill={() => setPendingKillKey(port.key)}
                  onCancelKill={() => setPendingKillKey(null)}
                  onKill={() => void killPort(port)}
                />
              )}
            />
          </>
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "ports",
    title: "Ports",
    icon: "ElectricPlugs",
    path: "ports",
    component: PortsPanel,
  });
});
