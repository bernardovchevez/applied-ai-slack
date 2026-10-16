import type { KnownBlock } from "@slack/types";
import type {
  AgentPausedResponse,
  AgentRunResponse,
  FeedbackButtonMeta,
  HealthReport,
  RagAnswerResult,
  RetryButtonMeta,
  SourceCitation,
} from "./types";

/** Convert standard markdown bold (**text**) to Slack mrkdwn (*text*) and trim length. */
export function toSlackMrkdwn(text: string, maxChars = 2800): string {
  const converted = text.replace(/\*\*([^*]+)\*\*/g, "*$1*").trim();
  if (converted.length <= maxChars) return converted;
  return `${converted.slice(0, maxChars - 12)}\n...(truncated)`;
}

export function formatSourcesLine(sources: SourceCitation[] | undefined): string {
  if (!sources || sources.length === 0) return "Sources: none cited";
  const unique = Array.from(new Set(sources.map((s) => s.file_name).filter(Boolean)));
  const items = unique.slice(0, 5).map((name) => {
    const match = sources.find((s) => s.file_name === name);
    const tier = match?.rights_tier ? ` [${match.rights_tier}]` : "";
    return `\`${name}\`${tier}`;
  });
  return `Sources: ${items.join(", ")}`;
}

export function encodeFeedbackValue(meta: FeedbackButtonMeta): string {
  // Slack button value max length is 2000 chars.
  return JSON.stringify({
    sessionId: meta.sessionId.slice(0, 120),
    prompt: meta.prompt.slice(0, 400),
    responseSnippet: meta.responseSnippet.slice(0, 600),
  });
}

export function decodeFeedbackValue(raw: string): FeedbackButtonMeta {
  const parsed = JSON.parse(raw) as Partial<FeedbackButtonMeta>;
  return {
    sessionId: parsed.sessionId ?? "slack-session",
    prompt: parsed.prompt ?? "Slack query",
    responseSnippet: parsed.responseSnippet ?? "Slack response",
  };
}

export function encodeRetryValue(meta: RetryButtonMeta): string {
  return JSON.stringify({
    prompt: meta.prompt.slice(0, 400),
    channel: meta.channel.slice(0, 32),
    threadRootTs: meta.threadRootTs.slice(0, 32),
    route: meta.route,
  });
}

export function decodeRetryValue(raw: string): RetryButtonMeta {
  const parsed = JSON.parse(raw) as Partial<RetryButtonMeta>;
  return {
    prompt: parsed.prompt ?? "",
    channel: parsed.channel ?? "",
    threadRootTs: parsed.threadRootTs ?? "",
    route: parsed.route ?? "auto",
  };
}

/** Block Kit card when the BFF or SSE stream fails; includes a **Retry** button. */
export function buildBffErrorBlocks(
  errorMessage: string,
  retry: RetryButtonMeta,
  bffUrl: string,
): KnownBlock[] {
  const promptLine = retry.prompt
    ? `*Request:* ${toSlackMrkdwn(retry.prompt, 320)}`
    : "_No prompt recorded._";

  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "Applied AI Platform request failed",
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:warning: ${toSlackMrkdwn(errorMessage, 600)}\n\n${promptLine}`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `BFF: \`${bffUrl}\` · Session thread: \`${retry.threadRootTs}\``,
        },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: "bff_retry",
          style: "primary",
          text: { type: "plain_text", text: "Retry", emoji: true },
          value: encodeRetryValue(retry),
        },
      ],
    },
  ];
}

/**
 * Build Slack Block Kit message for a grounded RAG answer (/media-ask or @media-ops).
 */
export function buildRagAnswerBlocks(result: RagAnswerResult): KnownBlock[] {
  const metaParts: string[] = [];
  if (result.provider) metaParts.push(`Provider: \`${result.provider}\``);
  if (typeof result.latencyMs === "number") metaParts.push(`${result.latencyMs} ms`);
  if (result.promptVersion) metaParts.push(`Prompt: \`${result.promptVersion}\``);

  const feedbackValue = encodeFeedbackValue({
    sessionId: result.sessionId,
    prompt: result.question,
    responseSnippet: result.answer,
  });

  const blocks: KnownBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Q:* ${toSlackMrkdwn(result.question, 400)}\n\n${toSlackMrkdwn(result.answer)}`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: [formatSourcesLine(result.sources), ...metaParts].join(" · "),
        },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: "feedback_up",
          text: { type: "plain_text", text: "Helpful", emoji: true },
          value: feedbackValue,
        },
        {
          type: "button",
          action_id: "feedback_down",
          text: { type: "plain_text", text: "Needs work", emoji: true },
          value: feedbackValue,
        },
      ],
    },
  ];

  return blocks;
}

/**
 * Build Slack Block Kit card for a paused 202 human-in-the-loop clearance run.
 */
export function buildAgentPausedBlocks(paused: AgentPausedResponse): KnownBlock[] {
  const draft = toSlackMrkdwn(paused.proposed_output ?? "No draft output generated.", 2400);
  const traceCount = paused.tool_trace?.length ?? 0;

  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "Clearance Workflow: Awaiting Human Approval",
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: paused.prompt
          ? `*Request:* ${toSlackMrkdwn(paused.prompt, 400)}\n*Status:* Paused at human approval gate (\`202 Accepted\`)`
          : "*Status:* Paused at human approval gate (`202 Accepted`)",
      },
    },
    {
      type: "divider",
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Proposed Draft:*\n${draft}`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `${formatSourcesLine(paused.sources)} · Tool steps: ${traceCount} · Thread: \`${paused.thread_id}\``,
        },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: "agent_approve",
          style: "primary",
          text: { type: "plain_text", text: "Approve & Publish", emoji: true },
          value: paused.thread_id,
        },
        {
          type: "button",
          action_id: "agent_reject",
          style: "danger",
          text: { type: "plain_text", text: "Reject Draft", emoji: true },
          value: paused.thread_id,
        },
      ],
    },
  ];
}

/**
 * Build Slack Block Kit card after a human approves or rejects a clearance run.
 */
export function buildAgentResolvedBlocks(
  result: AgentRunResponse,
  options: { threadId: string; reviewerUserId?: string; prompt?: string },
): KnownBlock[] {
  const approved = result.status === "approved";
  const headerText = approved
    ? "Clearance Workflow: Published (Human Approved)"
    : result.status === "rejected"
      ? "Clearance Workflow: Draft Rejected & Withheld"
      : "Clearance Workflow: Completed";

  const reviewerTag = options.reviewerUserId ? ` by <@${options.reviewerUserId}>` : "";
  const statusLine = approved
    ? `*Decision:* Approved & published to workflow${reviewerTag}`
    : result.status === "rejected"
      ? `*Decision:* Rejected & withheld${reviewerTag}`
      : "*Decision:* Completed";

  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: headerText,
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: options.prompt
          ? `*Request:* ${toSlackMrkdwn(options.prompt, 400)}\n${statusLine}`
          : statusLine,
      },
    },
  ];

  if (result.answer) {
    blocks.push(
      { type: "divider" },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: toSlackMrkdwn(result.answer, 2500),
        },
      },
    );
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `${formatSourcesLine(result.sources)} · Thread: \`${options.threadId}\``,
      },
    ],
  });

  return blocks;
}

/**
 * Build Slack Block Kit status card for /media-status.
 */
export function buildHealthBlocks(health: HealthReport, bffUrl: string): KnownBlock[] {
  const statusLabel = health.status === "ok" ? "HEALTHY" : "DEGRADED";
  const pgText =
    health.pgvector.status === "ok"
      ? `ok (${health.pgvector.document_count} docs, ${health.pgvector.chunk_count} chunks)`
      : `unreachable (${health.pgvector.error})`;
  const llmText =
    health.llm.status === "ok"
      ? `ok (\`${health.llm.provider}\`)`
      : `unreachable (\`${health.llm.provider}\`: ${health.llm.error})`;

  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `Applied AI Platform Status: ${statusLabel}`,
        emoji: true,
      },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Environment:*\n\`${health.environment ?? "localhost"}\`` },
        { type: "mrkdwn", text: `*State Store:*\n\`${health.state_store ?? "sqlite"}\`` },
        { type: "mrkdwn", text: `*pgvector Index:*\n${pgText}` },
        { type: "mrkdwn", text: `*LLM Provider:*\n${llmText}` },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `BFF URL: \`${bffUrl}\` · API Version: \`${health.version}\` · Client: \`slack\``,
        },
      ],
    },
  ];
}
