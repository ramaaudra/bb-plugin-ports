import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const portNumberSchema = z.number().int().min(1).max(65_535);
const processIdSchema = z.number().int().positive();

export const listeningPortSchema = z
  .object({
    address: z.string(),
    command: z.string(),
    cwd: z.string().nullable(),
    pid: processIdSchema,
    port: portNumberSchema,
  })
  .strict();

export const hostContract = defineRpcContract({
  listListeningPorts: {
    input: z.null(),
    output: z
      .object({
        ports: z.array(listeningPortSchema),
      })
      .strict(),
  },
  killProcess: {
    input: z
      .object({
        pid: processIdSchema,
        port: portNumberSchema,
      })
      .strict(),
    output: z
      .object({
        killed: z.literal(true),
        pid: processIdSchema,
        port: portNumberSchema,
        signal: z.literal("SIGTERM"),
      })
      .strict(),
  },
});

export const visiblePortSchema = listeningPortSchema
  .extend({
    hostId: z.string(),
    hostName: z.string(),
    key: z.string(),
  })
  .strict();

export const workspacePortsSchema = z
  .object({
    hostId: z.string(),
    hostName: z.string(),
    id: z.string(),
    name: z.string(),
    path: z.string().nullable(),
    ports: z.array(visiblePortSchema),
  })
  .strict();

export const scanErrorSchema = z
  .object({
    hostId: z.string(),
    hostName: z.string(),
    message: z.string(),
  })
  .strict();

export const portSnapshotSchema = z
  .object({
    checkedAt: z.number().int().nonnegative(),
    errors: z.array(scanErrorSchema),
    external: z.array(visiblePortSchema),
    hostCount: z.number().int().nonnegative(),
    totalPorts: z.number().int().nonnegative(),
    workspaces: z.array(workspacePortsSchema),
  })
  .strict();

export const rpcContract = defineRpcContract({
  listPorts: {
    input: z.null(),
    output: portSnapshotSchema,
  },
  openPort: {
    input: z
      .object({
        hostId: z.string().min(1),
        port: portNumberSchema,
      })
      .strict(),
    output: z
      .object({
        url: z.string().url(),
        viaTunnel: z.boolean(),
      })
      .strict(),
  },
  killPort: {
    input: z
      .object({
        hostId: z.string().min(1),
        pid: processIdSchema,
        port: portNumberSchema,
      })
      .strict(),
    output: z
      .object({
        hostId: z.string(),
        killed: z.literal(true),
        pid: processIdSchema,
        port: portNumberSchema,
      })
      .strict(),
  },
});

export type ListeningPort = z.infer<typeof listeningPortSchema>;
export type PortSnapshot = z.infer<typeof portSnapshotSchema>;
export type VisiblePort = z.infer<typeof visiblePortSchema>;
export type WorkspacePorts = z.infer<typeof workspacePortsSchema>;
