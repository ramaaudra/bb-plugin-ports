<div align="center">

<img src="./assets/port.svg" alt="" width="56" height="56" />

# Ports

Inspect active TCP ports across your BB hosts.

Open a service, copy its resolved URL, or stop its process from one panel.

</div>

Ports is a BB plugin for finding local development services without switching
to a terminal and rebuilding a `lsof` command each time. It scans connected
hosts, matches process working directories to BB workspaces, and keeps
unmatched listeners under **External ports**.

> [!NOTE]
> Ports currently scans TCP listeners. UDP sockets and Unix sockets are not
> included.

## Features

- Lists listening TCP ports from every connected BB host.
- Groups listeners by workspace using the process working directory and BB
  project or environment paths.
- Keeps unmatched listeners visible under **External ports**.
- Opens a port in a new browser tab.
- Copies the resolved URL to the clipboard without opening it.
- Stops a process only after an explicit confirmation and a fresh PID/port
  ownership check.
- Refreshes on demand, every 10 seconds, and after a plugin realtime signal.
- Filters by port number, process name, host, address, or working directory.
- Uses BB shared-port tunnels when available for remote hosts, then falls back
  to `http://127.0.0.1:<port>` when a tunnel cannot be created.

## Requirements

- BB `0.39` or later.
- A connected BB host for each machine you want to scan.
- `lsof` on each target host. macOS includes it by default. Linux and FreeBSD
  hosts need a working `lsof` installation.
- Node.js and npm for development or for building a release.

## Install locally

From the plugin directory:

```bash
npm install --include=dev
bb plugin build
bb plugin install . --yes
bb plugin reload ports
```

Open the **Ports** panel from the BB sidebar. The plugin id is `ports`.

For an installed development copy, use the watch loop:

```bash
bb plugin dev .
```

## Use the panel

Each listener row has three icon actions. Hover or focus an action to see its
label:

| Action | What it does |
| --- | --- |
| Open | Resolves the port URL and opens it in a new browser tab. |
| Copy URL | Resolves the same URL and copies it to the clipboard. |
| Kill | Opens a confirmation state, then sends `SIGTERM` after the host verifies that the listed PID still owns the port. |

Clicking the port number also opens the service. The copy action does not open
the service.

## Workspace matching

The server builds a list of open BB threads and their environment paths. For
each host, it compares those paths with the working directory reported for the
listening process. The longest matching path wins, so nested workspaces are
grouped under the most specific project. A listener that has no matching path
is shown as external.

The scanner reads process working directories on the target host. A missing or
unreadable working directory does not hide the listener; it remains visible
with the available process information.

## Safety behavior

The kill flow is intentionally conservative:

1. The panel asks for confirmation.
2. The server asks the host to scan again.
3. The host checks that the requested PID still owns the requested port.
4. The host sends `SIGTERM`.

The plugin does not force-kill processes. Refresh the panel after a process
exits or a supervisor restarts it.

## Project layout

| File | Responsibility |
| --- | --- |
| `app.tsx` | Ports panel, filtering, realtime refresh, and row actions. |
| `server.ts` | Host scanning, workspace grouping, URL resolution, and RPC handlers. |
| `host.ts` | Target-host scanner and guarded process termination. |
| `port-scanner.ts` | Cross-platform `lsof` parsing and process cwd lookup. |
| `contract.ts` | Shared host and frontend RPC schemas. |
| `assets/port.svg` | Monochrome plug icon used by the plugin branding and README. |
| `dist/` | Built server, app, and host artifacts shipped for Git or npm installs. |

## Development checks

Run these commands before publishing a change:

```bash
npm install --include=dev
npx tsc --noEmit
bb plugin build
bb plugin reload ports
bb plugin list --json
```

The live RPC surface can be checked against a running BB server:

```bash
curl -sS \
  -X POST \
  -H 'content-type: application/json' \
  -d 'null' \
  http://127.0.0.1:38886/api/v1/plugins/ports/rpc/listPorts
```

## Troubleshooting

### No ports appear

Confirm that the host is connected and `lsof` is available on that host:

```bash
lsof -nP -a -iTCP -sTCP:LISTEN
```

Then refresh the panel. The plugin reports per-host scan errors instead of
discarding results from other connected hosts.

### A workspace is listed as external

Check the process working directory. The path must overlap a BB project source
or environment workspace path on the same host. Processes started outside a
known workspace are expected to appear under **External ports**.

### Open returns a loopback URL

The shared-port tunnel was unavailable at the time of the request. The plugin
returns the host-local URL so the service can still be opened from the machine
that owns the port.

## Install from Git

After publishing this repository, install it from Git with:

```bash
bb plugin install git:https://github.com/ramaaudra/bb-plugin-ports@main
```

The repository includes the generated `dist/` artifacts, so a Git install can
load the plugin without requiring the consumer to run the development build.
