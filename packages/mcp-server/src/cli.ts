import path from "node:path";
import { McpServer } from "./server.js";
import { startStdioTransport } from "./stdio-transport.js";

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

const args = process.argv.slice(2);
const defaultWorkspaceRoot = path.resolve(import.meta.dirname, "../../..");
const workspaceRoot = getFlag(args, "--workspace") ?? defaultWorkspaceRoot;
const knowledgePath = getFlag(args, "--knowledge");
const skillsRoot = getFlag(args, "--skills");

const server = new McpServer({
  workspaceRoot,
  ...(knowledgePath ? { knowledgePath } : {}),
  ...(skillsRoot ? { skillsRoot } : {}),
});

startStdioTransport(server);
