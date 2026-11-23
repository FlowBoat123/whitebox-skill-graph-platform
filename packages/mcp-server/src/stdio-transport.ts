import type { Readable, Writable } from "node:stream";
import type { McpServer } from "./server.js";

/**
 * Attach an McpServer to stdio (or any Readable/Writable stream pair).
 * Supports both MCP standard newline-delimited JSON-RPC AND Content-Length framed messages.
 * Never logs diagnostics to stdout; only protocol responses are written to output.
 */
export function startStdioTransport(
  server: McpServer,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): { stop: () => void } {
  let buffer = Buffer.alloc(0);
  let framingMode: "auto" | "newline" | "content-length" = "auto";
  let processing = Promise.resolve();

  const writeResponse = (payload: unknown) => {
    const body = JSON.stringify(payload);
    if (framingMode === "content-length") {
      const bytes = Buffer.byteLength(body, "utf8");
      output.write(`Content-Length: ${bytes}\r\n\r\n${body}`);
    } else {
      output.write(`${body}\n`);
    }
  };

  const dispatchText = (jsonText: string) => {
    processing = processing.then(async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonText);
      } catch {
        writeResponse({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error: invalid JSON." },
        });
        return;
      }
      const resp = await server.handleMessage(parsed);
      if (resp !== null) {
        writeResponse(resp);
      }
    });
  };

  const drainBuffer = () => {
    while (buffer.length > 0) {
      // Skip leading whitespace before deciding framing mode
      const trimmedStart = buffer.toString("utf8", 0, Math.min(buffer.length, 64));
      if (framingMode === "auto") {
        if (/^\s*Content-Length:/i.test(trimmedStart)) {
          framingMode = "content-length";
        } else if (trimmedStart.trim().startsWith("{")) {
          framingMode = "newline";
        } else if (!trimmedStart.includes("\n")) {
          return;
        } else {
          // Drop blank line
          const nl = buffer.indexOf(0x0a);
          buffer = buffer.subarray(nl + 1);
          continue;
        }
      }

      if (framingMode === "content-length") {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        const headerText = buffer.subarray(0, headerEnd).toString("ascii");
        const m = /Content-Length:\s*(\d+)/i.exec(headerText);
        if (!m?.[1]) {
          buffer = buffer.subarray(headerEnd + 4);
          continue;
        }
        const len = Number.parseInt(m[1], 10);
        const bodyStart = headerEnd + 4;
        if (buffer.length < bodyStart + len) return;
        const body = buffer.subarray(bodyStart, bodyStart + len).toString("utf8");
        buffer = buffer.subarray(bodyStart + len);
        dispatchText(body);
      } else {
        const nl = buffer.indexOf(0x0a);
        if (nl === -1) return;
        const line = buffer.subarray(0, nl).toString("utf8").trim();
        buffer = buffer.subarray(nl + 1);
        if (line.length > 0) {
          dispatchText(line);
        }
      }
    }
  };

  const onData = (chunk: Buffer | string) => {
    const chunkBuf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    buffer = Buffer.concat([buffer, chunkBuf]);
    drainBuffer();
  };

  input.on("data", onData);
  return {
    stop: () => {
      input.off("data", onData);
    },
  };
}
