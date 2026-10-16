import type { KnownBlock } from "@slack/types";
import type { WebClient } from "@slack/web-api";

const CLEARANCE_INTENT_RE =
  /\b(clearance summary|production brief|draft brief|launch summary|prepare.*clearance)\b/i;

/** Slack mrkdwn shown while the BFF request is in flight. */
export function workingMessageText(prompt: string, clearance?: boolean): string {
  const isClearance = clearance ?? CLEARANCE_INTENT_RE.test(prompt);
  const preview = prompt.length > 120 ? `${prompt.slice(0, 117)}...` : prompt;
  if (isClearance) {
    return (
      `:hourglass_flowing_sand: *Working on it…* Running the clearance workflow for:\n` +
      `>"${preview}"\n` +
      `_This can take up to a minute on localhost._`
    );
  }
  return (
    `:hourglass_flowing_sand: *Working on it…* Searching the media ops corpus for:\n` +
    `>"${preview}"`
  );
}

export async function postWorkingPlaceholder(
  client: WebClient,
  channel: string,
  threadTs: string | undefined,
  prompt: string,
): Promise<{ channel: string; ts: string }> {
  const res = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: workingMessageText(prompt),
  });
  if (!res.ok || !res.ts || !res.channel) {
    throw new Error(res.error ?? "Failed to post working placeholder");
  }
  return { channel: res.channel, ts: res.ts };
}

export async function updateChatMessage(
  client: WebClient,
  channel: string,
  ts: string,
  payload: { text: string; blocks?: KnownBlock[] },
): Promise<void> {
  // Slack keeps previous blocks when `blocks` is omitted; pass [] to remove Block Kit (e.g. Retry).
  const updatePayload: { channel: string; ts: string; text: string; blocks?: KnownBlock[] } = {
    channel,
    ts,
    text: payload.text,
  };
  if (payload.blocks !== undefined) {
    updatePayload.blocks = payload.blocks;
  }
  const res = await client.chat.update(updatePayload);
  if (!res.ok) {
    throw new Error(res.error ?? "chat.update failed");
  }
}
