import http from "node:http";
import https from "node:https";

const SHARED_HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 4 });
const SHARED_HTTP_AGENT = new http.Agent({ keepAlive: true, maxSockets: 4 });

function nativeHttpPost(
  endpoint: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Promise<{ status: number; ok: boolean; text: () => Promise<string>; json: () => Promise<unknown> }> {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    const isHttps = url.protocol === "https:";
    const mod = isHttps ? https : http;
    const req = mod.request(
      url,
      {
        method: "POST",
        headers: {
          ...headers,
          "Content-Length": Buffer.byteLength(body, "utf8"),
        },
        agent: isHttps ? SHARED_HTTPS_AGENT : SHARED_HTTP_AGENT,
        family: 4,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          resolve({
            status,
            ok: status >= 200 && status < 300,
            text: async () => raw,
            json: async () => JSON.parse(raw),
          });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error(`HTTPS request timed out after ${timeoutMs}ms`));
    });
    req.on("error", (err) => reject(err));
    req.write(body, "utf8");
    req.end();
  });
}

export interface LlmConfig {
  endpoint?: string;
  model?: string;
  apiKey?: string;
  timeoutMs?: number;
  maxTokens?: number;
  /** Optional injected fetch implementation for deterministic offline unit tests. */
  fetchImpl?: typeof fetch;
}

export interface LlmJsonResponse<T = Record<string, unknown>> {
  data: T;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

const DEFAULT_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "deepseek/deepseek-v3.2";

function stripThinkingAndFences(raw: string): string {
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```[a-zA-Z0-9_-]*\s*/u, "").replace(/\s*```$/u, "").trim();
  }
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }
  return cleaned;
}

function assertAllowedEndpoint(endpoint: string): void {
  const parsed = new URL(endpoint);
  const isLoopback =
    parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
    throw new Error(`Refused non-HTTPS remote LLM endpoint: ${parsed.origin}`);
  }
}

export class LlmClient {
  readonly endpoint: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly maxTokens: number;
  private readonly apiKey: string;
  private readonly fetchImpl?: typeof fetch;
  private callCount = 0;
  private totalPromptTokens = 0;
  private totalCompletionTokens = 0;

  constructor(config: LlmConfig = {}) {
    this.endpoint =
      config.endpoint ??
      process.env.SKILL_GRAPH_LLM_ENDPOINT ??
      DEFAULT_ENDPOINT;
    this.model =
      config.model ??
      process.env.SKILL_GRAPH_LLM_MODEL ??
      DEFAULT_MODEL;
    this.apiKey =
      config.apiKey ??
      process.env.SKILL_GRAPH_LLM_API_KEY ??
      process.env.OPENROUTER_API_KEY ??
      process.env.OPENAI_API_KEY ??
      "";
    this.timeoutMs = config.timeoutMs ?? 90_000;
    this.maxTokens = config.maxTokens ?? 2000;
    if (config.fetchImpl) {
      this.fetchImpl = config.fetchImpl;
    }
    assertAllowedEndpoint(this.endpoint);
  }

  getStats() {
    return {
      model: this.model,
      calls: this.callCount,
      promptTokens: this.totalPromptTokens,
      completionTokens: this.totalCompletionTokens,
    };
  }

  async completeJson<T = Record<string, unknown>>(
    systemPrompt: string,
    userPrompt: string,
  ): Promise<LlmJsonResponse<T>> {
    const isLoopback = ["127.0.0.1", "localhost", "::1"].includes(new URL(this.endpoint).hostname);
    if (!this.apiKey && !isLoopback) {
      throw new Error(
        "Missing LLM API key. Provide OPENROUTER_API_KEY or SKILL_GRAPH_LLM_API_KEY in environment.",
      );
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Title": "Defect-Intelligence-SkillGraph",
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const payload = {
      model: this.model,
      temperature: 0,
      max_tokens: this.maxTokens,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    };

    let lastErr: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const bodyStr = JSON.stringify(payload);
        const resp = this.fetchImpl
          ? await this.fetchImpl(this.endpoint, {
              method: "POST",
              headers,
              body: bodyStr,
              signal: controller.signal,
            })
          : await nativeHttpPost(this.endpoint, headers, bodyStr, this.timeoutMs);
        clearTimeout(timer);

        if (resp.status === 429 || resp.status >= 500) {
          const snippet = (await resp.text().catch(() => "")).slice(0, 200);
          lastErr = new Error(`LLM HTTP ${resp.status}: ${snippet}`);
          if (attempt < 4) {
            await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
            continue;
          }
          throw lastErr;
        }
        if (!resp.ok) {
          const snippet = (await resp.text().catch(() => "")).slice(0, 300);
          throw new Error(`LLM HTTP ${resp.status}: ${snippet}`);
        }

        const body = (await resp.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const content = body.choices?.[0]?.message?.content ?? "";
        if (!content.trim()) {
          throw new Error("LLM returned empty message content.");
        }
        const parsed = JSON.parse(stripThinkingAndFences(content)) as T;
        const promptTokens = body.usage?.prompt_tokens ?? 0;
        const completionTokens = body.usage?.completion_tokens ?? 0;
        this.callCount += 1;
        this.totalPromptTokens += promptTokens;
        this.totalCompletionTokens += completionTokens;
        return {
          data: parsed,
          model: this.model,
          promptTokens,
          completionTokens,
          latencyMs: Date.now() - started,
        };
      } catch (err) {
        clearTimeout(timer);
        lastErr = err;
        const isTransient =
          err instanceof SyntaxError ||
          err instanceof TypeError ||
          (err instanceof Error &&
            /fetch failed|ETIMEDOUT|ECONNRESET|UND_ERR|AbortError|timeout|socket/i.test(
              `${err.name} ${err.message}`,
            ));
        if (attempt < 4 && isTransient) {
          await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }
}
