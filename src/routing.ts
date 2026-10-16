import type { WebClient } from "@slack/web-api";
import { askRag, isAgentPaused, runAgent } from "./bff";
import {
  buildAgentPausedBlocks,
  buildAgentResolvedBlocks,
  buildRagAnswerBlocks,
} from "./blocks";
import { postWorkingPlaceholder, updateChatMessage } from "./progress";

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

/**
 * Route a user prompt to clearance agent or RAG Q&A (shared by @mentions and DMs).
 * Posts a "Working on it…" placeholder, then updates the same message when the BFF returns.
 */
export async function dispatchMediaOpsQuery(input: {
  prompt: string;
  sessionId: string;
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

  const prompt = input.prompt.trim();
  let placeholder: { channel: string; ts: string } | undefined;

  try {
    placeholder = await postWorkingPlaceholder(
      input.client,
      input.channel,
      threadTs,
      prompt,
    );

    if (isClearancePrompt(prompt)) {
      const res = await runAgent({ prompt, sessionId: input.sessionId, autoApprove: false });
      if (isAgentPaused(res)) {
        await updateChatMessage(input.client, placeholder.channel, placeholder.ts, {
          text: `Clearance workflow awaiting approval (${res.thread_id})`,
          blocks: buildAgentPausedBlocks(res),
        });
      } else {
        await updateChatMessage(input.client, placeholder.channel, placeholder.ts, {
          text: res.answer,
          blocks: buildAgentResolvedBlocks(res, {
            threadId: input.sessionId,
            prompt,
          }),
        });
      }
    } else {
      const rag = await askRag(prompt, input.sessionId);
      await updateChatMessage(input.client, placeholder.channel, placeholder.ts, {
        text: rag.answer,
        blocks: buildRagAnswerBlocks(rag),
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "BFF request failed";
    const errorText = `Error communicating with Applied AI Platform BFF: ${msg}`;
    if (placeholder) {
      await updateChatMessage(input.client, placeholder.channel, placeholder.ts, {
        text: errorText,
      });
    } else {
      await input.client.chat.postMessage({
        channel: input.channel,
        thread_ts: threadTs,
        text: errorText,
      });
    }
  }
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
