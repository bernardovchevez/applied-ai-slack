import { askRag, isAgentPaused, runAgent } from "./bff";
import {
  buildAgentPausedBlocks,
  buildAgentResolvedBlocks,
  buildRagAnswerBlocks,
} from "./blocks";

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

export type MediaOpsSayPayload = {
  thread_ts?: string;
  text: string;
  blocks?: ReturnType<typeof buildRagAnswerBlocks>;
};

export type MediaOpsSay = (payload: MediaOpsSayPayload) => Promise<unknown>;

/**
 * Route a user prompt to clearance agent or RAG Q&A (shared by @mentions and DMs).
 */
export async function dispatchMediaOpsQuery(input: {
  prompt: string;
  sessionId: string;
  threadTs?: string;
  say: MediaOpsSay;
}): Promise<void> {
  const threadOpts = input.threadTs ? { thread_ts: input.threadTs } : {};

  if (!input.prompt.trim()) {
    await input.say({
      ...threadOpts,
      text: MEDIA_OPS_EMPTY_PROMPT_HELP,
    });
    return;
  }

  const prompt = input.prompt.trim();

  try {
    if (isClearancePrompt(prompt)) {
      const res = await runAgent({ prompt, sessionId: input.sessionId, autoApprove: false });
      if (isAgentPaused(res)) {
        await input.say({
          ...threadOpts,
          text: `Clearance workflow awaiting approval (${res.thread_id})`,
          blocks: buildAgentPausedBlocks(res),
        });
      } else {
        await input.say({
          ...threadOpts,
          text: res.answer,
          blocks: buildAgentResolvedBlocks(res, {
            threadId: input.sessionId,
            prompt,
          }),
        });
      }
    } else {
      const rag = await askRag(prompt, input.sessionId);
      await input.say({
        ...threadOpts,
        text: rag.answer,
        blocks: buildRagAnswerBlocks(rag),
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "BFF request failed";
    await input.say({
      ...threadOpts,
      text: `Error communicating with Applied AI Platform BFF: ${msg}`,
    });
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
