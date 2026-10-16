import type { KnownBlock } from "@slack/types";
import type { WebClient } from "@slack/web-api";
import { askRag, getBffUrl, isAgentPaused, runAgent } from "./bff";
import {
  buildAgentPausedBlocks,
  buildAgentResolvedBlocks,
  buildBffErrorBlocks,
  buildRagAnswerBlocks,
} from "./blocks";
import { postWorkingPlaceholder, updateChatMessage, workingMessageText } from "./progress";
import type { RetryButtonMeta } from "./types";

export const CLEARANCE_INTENT_RE =
  /\b(clearance summary|production brief|draft brief|launch summary|prepare.*clearance)\b/i;

export const MEDIA_OPS_EMPTY_PROMPT_HELP =
  "Ask a media ops question or request a clearance brief (for example: `Is Harbor Line cleared for EMEA streaming?` or `Prepare clearance summary for Harbor Line S01E04 EMEA launch`). You can also use `/media-ask`, `/media-clearance`, and `/media-status`.";

/** Remove @bot mention tokens from channel messages. */
export function stripLeadingBotMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

export function isClearancePrompt(text: string): boolean {
  return CLEARANCE_INTENT_RE.test(text);
}

/** Stable session id for a Slack thread or DM conversation root. */
export function slackThreadSessionId(channelId: string, threadTs: string): string {
  return `slack-thread-${channelId}-${threadTs}`;
}

/** BFF session anchor: existing thread root, or the ts of a new root/placeholder message. */
export function slackThreadRootTs(existingThreadTs: string | undefined, anchorMessageTs: string): string {
  return existingThreadTs ?? anchorMessageTs;
}

type MediaOpsRoute = "auto" | "rag" | "clearance";

function retryMeta(input: {
  prompt: string;
  channel: string;
  threadRootTs: string;
  route: MediaOpsRoute;
}): RetryButtonMeta {
  return {
    prompt: input.prompt,
    channel: input.channel,
    threadRootTs: input.threadRootTs,
    route: input.route,
  };
}

async function fulfillThreadScopedQuery(input: {
  prompt: string;
  channel: string;
  threadRootTs: string;
  route: MediaOpsRoute;
}): Promise<{ text: string; blocks: KnownBlock[] }> {
  const prompt = input.prompt.trim();
  const sessionId = slackThreadSessionId(input.channel, input.threadRootTs);
  const useClearance =
    input.route === "clearance" ||
    (input.route === "auto" && isClearancePrompt(prompt));

  if (useClearance) {
    const res = await runAgent({ prompt, sessionId, autoApprove: false });
    if (isAgentPaused(res)) {
      return {
        text: `Clearance workflow awaiting approval (${res.thread_id})`,
        blocks: buildAgentPausedBlocks(res),
      };
    }
    return {
      text: res.answer,
      blocks: buildAgentResolvedBlocks(res, {
        threadId: sessionId,
        prompt,
      }),
    };
  }

  const rag = await askRag(prompt, sessionId);
  return {
    text: rag.answer,
    blocks: buildRagAnswerBlocks(rag),
  };
}

async function postBffErrorMessage(input: {
  client: WebClient;
  channel: string;
  messageTs?: string;
  threadTs?: string;
  errorMessage: string;
  retry: RetryButtonMeta;
}): Promise<void> {
  const bffUrl = getBffUrl();
  const text = `Applied AI Platform request failed: ${input.errorMessage}`;
  const blocks = buildBffErrorBlocks(input.errorMessage, input.retry, bffUrl);

  if (input.messageTs) {
    await updateChatMessage(input.client, input.channel, input.messageTs, { text, blocks });
    return;
  }

  await input.client.chat.postMessage({
    channel: input.channel,
    thread_ts: input.threadTs,
    text,
    blocks,
  });
}

async function dispatchThreadScopedQuery(input: {
  prompt: string;
  channel: string;
  /** When set, post in this thread; when omitted, post a new channel message (its ts becomes the root). */
  threadTs?: string;
  client: WebClient;
  route: MediaOpsRoute;
}): Promise<void> {
  const prompt = input.prompt.trim();
  let placeholder: { channel: string; ts: string } | undefined;
  let threadRootTs: string | undefined;

  try {
    placeholder = await postWorkingPlaceholder(
      input.client,
      input.channel,
      input.threadTs,
      prompt,
    );
    threadRootTs = slackThreadRootTs(input.threadTs, placeholder.ts);
    const result = await fulfillThreadScopedQuery({
      prompt,
      channel: input.channel,
      threadRootTs,
      route: input.route,
    });
    await updateChatMessage(input.client, placeholder.channel, placeholder.ts, result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "BFF request failed";
    const rootTs =
      threadRootTs ??
      (placeholder ? slackThreadRootTs(input.threadTs, placeholder.ts) : input.threadTs);
    if (!rootTs) {
      await input.client.chat.postMessage({
        channel: input.channel,
        thread_ts: input.threadTs,
        text: `Error communicating with Applied AI Platform BFF: ${msg}`,
      });
      return;
    }
    await postBffErrorMessage({
      client: input.client,
      channel: placeholder?.channel ?? input.channel,
      messageTs: placeholder?.ts,
      threadTs: input.threadTs,
      errorMessage: msg,
      retry: retryMeta({
        prompt,
        channel: input.channel,
        threadRootTs: rootTs,
        route: input.route,
      }),
    });
  }
}

/**
 * Re-run a failed RAG or agent request from the Block Kit **Retry** button (updates the same message).
 */
export async function retryThreadScopedQuery(input: {
  client: WebClient;
  channel: string;
  messageTs: string;
  meta: RetryButtonMeta;
}): Promise<void> {
  const prompt = input.meta.prompt.trim();
  if (!prompt || !input.meta.threadRootTs) {
    throw new Error("Retry payload is missing prompt or thread session");
  }

  const clearance =
    input.meta.route === "clearance" ||
    (input.meta.route === "auto" && isClearancePrompt(prompt));

  await updateChatMessage(input.client, input.channel, input.messageTs, {
    text: workingMessageText(prompt, clearance),
    blocks: [],
  });

  try {
    const result = await fulfillThreadScopedQuery({
      prompt,
      channel: input.meta.channel || input.channel,
      threadRootTs: input.meta.threadRootTs,
      route: input.meta.route,
    });
    await updateChatMessage(input.client, input.channel, input.messageTs, result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "BFF request failed";
    await postBffErrorMessage({
      client: input.client,
      channel: input.channel,
      messageTs: input.messageTs,
      errorMessage: msg,
      retry: {
        ...input.meta,
        channel: input.meta.channel || input.channel,
        prompt,
      },
    });
  }
}

/**
 * Route a user prompt to clearance agent or RAG Q&A (shared by @mentions and DMs).
 * Posts a "Working on it…" placeholder, then updates the same message when the BFF returns.
 */
export async function dispatchMediaOpsQuery(input: {
  prompt: string;
  channel: string;
  threadTs?: string;
  client: WebClient;
}): Promise<void> {
  const threadTs = input.threadTs;

  if (!input.prompt.trim()) {
    await input.client.chat.postMessage({
      channel: input.channel,
      thread_ts: threadTs,
      text: MEDIA_OPS_EMPTY_PROMPT_HELP,
    });
    return;
  }

  await dispatchThreadScopedQuery({
    prompt: input.prompt,
    channel: input.channel,
    threadTs,
    client: input.client,
    route: "auto",
  });
}

/**
 * `/media-ask` and `/media-clearance`: same thread-scoped BFF session as @media-ops and DMs.
 * Uses `command.thread_ts` when the slash command is run inside a thread.
 */
export async function dispatchSlashQuery(input: {
  prompt: string;
  channel: string;
  threadTs?: string;
  client: WebClient;
  route: "rag" | "clearance";
}): Promise<void> {
  await dispatchThreadScopedQuery({
    prompt: input.prompt,
    channel: input.channel,
    threadTs: input.threadTs,
    client: input.client,
    route: input.route,
  });
}

/** True for direct messages to the bot (message.im / App Home Messages tab). */
export function isDirectMessage(message: { channel_type?: string }): boolean {
  return message.channel_type === "im";
}

/** Ignore bot, edit, and other non-user message subtypes. */
export function isUserTextMessage(message: {
  subtype?: string;
  text?: string;
  bot_id?: string;
}): boolean {
  if (message.bot_id) return false;
  if (message.subtype && message.subtype !== "file_share") return false;
  return Boolean(message.text?.trim());
}
