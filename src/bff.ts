import type {
  AgentPausedResponse,
  AgentRunResponse,
  AppEnvironment,
  ChatDonePayload,
  ChatStreamEvent,
  HealthReport,
  RagAnswerResult,
  SourceCitation,
} from "./types";

export function normalizeEnv(raw: string | undefined): AppEnvironment {
  const val = (raw ?? "").trim().toLowerCase();
  if (val === "stage" || val === "staging") return "stage";
  if (val === "prod" || val === "production") return "production";
  return "localhost";
}

export const APP_ENV: AppEnvironment = normalizeEnv(process.env.APP_ENV);

export function getBffUrl(): string {
  return (process.env.BFF_URL ?? "http://localhost:8000").replace(/\/$/, "");
}

export function buildBffHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Client-Platform": "slack",
    ...extra,
  };
  const apiKey = process.env.BFF_API_KEY?.trim();
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  return headers;
}

export type SseFrame = { event: string; data: string };

/** Normalize CRLF emitted by sse-starlette before framing. */
export function parseSseFrames(buffer: string): { frames: SseFrame[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const frames: SseFrame[] = [];
  const blocks = normalized.split("\n\n");
  const rest = blocks.pop() ?? "";

  for (const block of blocks) {
    if (!block.trim()) continue;
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^\s/, ""));
    }
    if (dataLines.length > 0) frames.push({ event, data: dataLines.join("\n") });
  }
  return { frames, rest };
}

export function frameToStreamEvent(frame: SseFrame): ChatStreamEvent | null {
  switch (frame.event) {
    case "sources":
      return {
        type: "sources",
        sources: JSON.parse(frame.data.trim()) as SourceCitation[],
      };
    case "token":
      return { type: "token", text: frame.data };
    case "done":
      return {
        type: "done",
        payload: JSON.parse(frame.data.trim()) as ChatDonePayload,
      };
    case "error": {
      const parsed = JSON.parse(frame.data.trim()) as { error?: string; message?: string };
      return {
        type: "error",
        error: parsed.error ?? "error",
        message: parsed.message ?? "BFF stream failed",
      };
    }
    default:
      return null;
  }
}

/**
 * Call POST /v1/chat/stream with format="compact" for Slack and return the full grounded answer.
 */
export async function askRag(
  question: string,
  sessionId: string,
  topK = 4,
): Promise<RagAnswerResult> {
  const res = await fetch(`${getBffUrl()}/v1/chat/stream`, {
    method: "POST",
    headers: buildBffHeaders({ "X-Session-Id": sessionId }),
    body: JSON.stringify({ question, top_k: topK, format: "compact" }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(errText || `BFF returned HTTP ${res.status}`);
  }
  if (!res.body) {
    throw new Error("Empty response body from BFF /v1/chat/stream");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const tokens: string[] = [];
  let sources: SourceCitation[] = [];
  let donePayload: ChatDonePayload = {};

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parsed = parseSseFrames(buffer);
    buffer = parsed.rest;
    for (const frame of parsed.frames) {
      const ev = frameToStreamEvent(frame);
      if (!ev) continue;
      if (ev.type === "sources") sources = ev.sources;
      else if (ev.type === "token") tokens.push(ev.text);
      else if (ev.type === "done") donePayload = ev.payload;
      else if (ev.type === "error") throw new Error(ev.message);
    }
  }

  if (buffer.trim()) {
    const parsed = parseSseFrames(`${buffer}\n\n`);
    for (const frame of parsed.frames) {
      const ev = frameToStreamEvent(frame);
      if (!ev) continue;
      if (ev.type === "sources") sources = ev.sources;
      else if (ev.type === "token") tokens.push(ev.text);
      else if (ev.type === "done") donePayload = ev.payload;
      else if (ev.type === "error") throw new Error(ev.message);
    }
  }

  const finalAnswer = (donePayload.final_answer ?? tokens.join("")).trim();
  return {
    question,
    answer: finalAnswer || "No answer returned from corpus.",
    sources,
    sessionId: donePayload.session_id ?? sessionId,
    provider: donePayload.provider,
    latencyMs: donePayload.latency_ms,
    promptVersion: donePayload.prompt_version,
  };
}

export function isAgentPaused(
  result: AgentRunResponse | AgentPausedResponse,
): result is AgentPausedResponse {
  return "thread_id" in result && !("answer" in result);
}

/**
 * Call POST /v1/agent/run. By default autoApprove=false so Slack renders the 202 human approval card.
 */
export async function runAgent(input: {
  prompt: string;
  sessionId: string;
  autoApprove?: boolean;
}): Promise<AgentRunResponse | AgentPausedResponse> {
  const res = await fetch(`${getBffUrl()}/v1/agent/run`, {
    method: "POST",
    headers: buildBffHeaders({ "X-Session-Id": input.sessionId }),
    body: JSON.stringify({
      prompt: input.prompt,
      auto_approve: input.autoApprove ?? false,
    }),
  });

  const text = await res.text();
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    throw new Error(extractErrorMessage(body, `Agent run failed (${res.status})`));
  }
  return body as unknown as AgentRunResponse | AgentPausedResponse;
}

/**
 * Resume a paused 202 agent workflow from a Slack Block Kit button click (approve | reject).
 */
export async function resumeAgent(input: {
  threadId: string;
  resume: "approve" | "reject";
}): Promise<AgentRunResponse> {
  const res = await fetch(`${getBffUrl()}/v1/agent/run`, {
    method: "POST",
    headers: buildBffHeaders({ "X-Session-Id": input.threadId }),
    body: JSON.stringify({
      thread_id: input.threadId,
      resume: input.resume,
    }),
  });

  const text = await res.text();
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    throw new Error(extractErrorMessage(body, `Agent resume failed (${res.status})`));
  }
  return body as unknown as AgentRunResponse;
}

export async function submitFeedback(input: {
  sessionId: string;
  prompt: string;
  response: string;
  rating: "up" | "down";
}): Promise<void> {
  const res = await fetch(`${getBffUrl()}/v1/feedback`, {
    method: "POST",
    headers: buildBffHeaders({ "X-Session-Id": input.sessionId }),
    body: JSON.stringify({
      session_id: input.sessionId,
      prompt: input.prompt,
      response: input.response,
      rating: input.rating,
      sources: [],
    }),
  });
  if (!res.ok) {
    throw new Error((await res.text()) || `Feedback failed (${res.status})`);
  }
}

export async function fetchHealth(): Promise<HealthReport> {
  const res = await fetch(`${getBffUrl()}/health`, {
    headers: buildBffHeaders(),
  });
  const text = await res.text();
  const data = JSON.parse(text) as HealthReport;
  if (!res.ok && res.status !== 503) {
    throw new Error(`Health check failed (${res.status})`);
  }
  return data;
}

function extractErrorMessage(body: Record<string, unknown>, fallback: string): string {
  const detail = body.detail;
  if (detail && typeof detail === "object" && detail !== null && "message" in detail) {
    return String((detail as { message: unknown }).message);
  }
  if (typeof body.message === "string") return body.message;
  return fallback;
}
