import fs from "node:fs";
import path from "node:path";
import {
  callMcpTool,
  MCP_RESOURCES,
  MCP_TOOLS,
  readMcpResource,
  type McpContext,
} from "./tools.js";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export const MCP_PROTOCOL_VERSION = "2024-11-05";

export class McpServer {
  private readonly ctx: McpContext;

  constructor(options: {
    workspaceRoot?: string;
    knowledgePath?: string;
    skillsRoot?: string;
  } = {}) {
    const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
    const knowledgeDir = path.join(workspaceRoot, "knowledge");
    const prebuiltIndex = path.join(workspaceRoot, "build", "knowledge-index.json");
    const defaultKnowledgePath = options.knowledgePath
      ? path.resolve(workspaceRoot, options.knowledgePath)
      : fs.existsSync(knowledgeDir)
        ? workspaceRoot
        : prebuiltIndex;
    const defaultSkillsRoot = options.skillsRoot
      ? path.resolve(workspaceRoot, options.skillsRoot)
      : path.join(workspaceRoot, "skills");

    this.ctx = {
      workspaceRoot,
      defaultKnowledgePath,
      defaultSkillsRoot,
    };
  }

  async handleMessage(raw: unknown): Promise<JsonRpcResponse | null> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid JSON-RPC request object." },
      };
    }

    const req = raw as Partial<JsonRpcRequest>;
    const hasId = req.id !== undefined;
    const id = req.id ?? null;

    if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
      return hasId
        ? { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid JSON-RPC 2.0 envelope." } }
        : null;
    }

    // Notifications (no id) never return a response
    if (!hasId) {
      return null;
    }

    const params = req.params && typeof req.params === "object" ? req.params : {};

    try {
      switch (req.method) {
        case "initialize": {
          const clientVersion =
            typeof params.protocolVersion === "string" ? params.protocolVersion : MCP_PROTOCOL_VERSION;
          return {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: clientVersion,
              capabilities: {
                tools: { listChanged: false },
                resources: { subscribe: false, listChanged: false },
              },
              serverInfo: {
                name: "defect-intelligence-mcp",
                version: "0.1.0",
              },
            },
          };
        }

        case "ping":
          return { jsonrpc: "2.0", id, result: {} };

        case "tools/list":
          return { jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } };

        case "tools/call": {
          const toolName = params.name;
          if (typeof toolName !== "string") {
            return {
              jsonrpc: "2.0",
              id,
              error: { code: -32602, message: "tools/call requires params.name (string)." },
            };
          }
          const known = MCP_TOOLS.some((t) => t.name === toolName);
          if (!known) {
            return {
              jsonrpc: "2.0",
              id,
              error: { code: -32602, message: `Unknown tool: ${toolName}` },
            };
          }
          const toolArgs =
            params.arguments && typeof params.arguments === "object"
              ? (params.arguments as Record<string, unknown>)
              : {};
          try {
            const data = await callMcpTool(this.ctx, toolName, toolArgs);
            return {
              jsonrpc: "2.0",
              id,
              result: {
                content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
                isError: false,
              },
            };
          } catch (toolErr) {
            const msg = toolErr instanceof Error ? toolErr.message : String(toolErr);
            return {
              jsonrpc: "2.0",
              id,
              result: {
                content: [{ type: "text", text: JSON.stringify({ error: msg }) }],
                isError: true,
              },
            };
          }
        }

        case "resources/list":
          return { jsonrpc: "2.0", id, result: { resources: MCP_RESOURCES } };

        case "resources/read": {
          const uri = params.uri;
          if (typeof uri !== "string") {
            return {
              jsonrpc: "2.0",
              id,
              error: { code: -32602, message: "resources/read requires params.uri (string)." },
            };
          }
          const text = await readMcpResource(this.ctx, uri);
          return {
            jsonrpc: "2.0",
            id,
            result: {
              contents: [{ uri, mimeType: "application/json", text }],
            },
          };
        }

        default:
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Method not found: ${req.method}` },
          };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message },
      };
    }
  }
}
