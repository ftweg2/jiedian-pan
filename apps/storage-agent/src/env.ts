import { resolve } from "node:path";

export interface AgentEnv {
  port: number;
  host: string;
  dataDir: string;
  agentToken: string;
  nodeId?: string;
}

export function loadEnv(): AgentEnv {
  const agentToken = process.env.AGENT_TOKEN;
  if (!agentToken || agentToken.length < 24) {
    throw new Error("AGENT_TOKEN must be set and at least 24 characters long.");
  }

  return {
    port: Number(process.env.PORT ?? 4010),
    host: process.env.HOST ?? "0.0.0.0",
    dataDir: resolve(process.env.AGENT_DATA_DIR ?? "./data/objects"),
    agentToken,
    nodeId: process.env.NODE_ID
  };
}
