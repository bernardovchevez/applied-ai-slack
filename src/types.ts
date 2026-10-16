/**
 * Shared contract types aligned with applied-ai-platform/platform/bff/openapi.yaml
 */

export type AppEnvironment = "localhost" | "stage" | "production";

export interface SourceCitation {
  file_name: string;
  doc_type?: string | null;
  rights_tier?: string | null;
  sharepoint_path?: string | null;
  chunk_index?: number | null;
  distance?: number | null;
}

export interface ChatDonePayload {
  session_id?: string;
  provider?: string;
  latency_ms?: number;
  prompt_version?: string;
  client_platform?: string;
  final_answer?: string;
}

export type ChatStreamEvent =
  | { type: "sources"; sources: SourceCitation[] }
  | { type: "token"; text: string }
  | { type: "done"; payload: ChatDonePayload }
  | { type: "error"; error: string; message: string };

export interface RagAnswerResult {
  question: string;
  answer: string;
  sources: SourceCitation[];
  sessionId: string;
  provider?: string;
  latencyMs?: number;
  promptVersion?: string;
}

export interface AgentRunResponse {
  answer: string;
  sources: SourceCitation[];
  tool_trace: Record<string, unknown>[];
  status?: "approved" | "completed" | "rejected";
}

export interface AgentPausedResponse {
  thread_id: string;
  message: string;
  proposed_output?: string | null;
  prompt?: string | null;
  sources?: SourceCitation[];
  tool_trace?: Record<string, unknown>[];
}

export interface HealthReport {
  status: "ok" | "degraded";
  version: string;
  environment?: AppEnvironment;
  state_store?: "sqlite" | "postgres";
  pgvector:
    | { status: "ok"; chunk_count: number; document_count: number }
    | { status: "unreachable"; error: string };
  llm:
    | { provider: string; status: "ok" }
    | { provider: string; status: "unreachable"; error: string };
}

export interface FeedbackButtonMeta {
  sessionId: string;
  prompt: string;
  responseSnippet: string;
}

/** Payload for Block Kit **Retry** after a failed RAG or agent call. */
export interface RetryButtonMeta {
  prompt: string;
  channel: string;
  threadRootTs: string;
  route: "rag" | "clearance" | "auto";
}
