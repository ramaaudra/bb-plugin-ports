import process from "node:process";

import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";

import { hostContract } from "./contract.js";
import { listListeningPorts } from "./port-scanner.js";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    async listListeningPorts(_input, context) {
      return { ports: await listListeningPorts(context.signal) };
    },
    async killProcess({ pid, port }, context) {
      const ports = await listListeningPorts(context.signal);
      const ownsPort = ports.some((candidate) => candidate.pid === pid && candidate.port === port);
      if (!ownsPort) {
        throw new Error(`Process ${pid} is no longer listening on port ${port}. Refresh and try again.`);
      }

      try {
        process.kill(pid, "SIGTERM");
      } catch (error) {
        throw new Error(
          `Unable to stop process ${pid}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      return { killed: true, pid, port, signal: "SIGTERM" as const };
    },
  },
});
