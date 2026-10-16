import type { App, BlockAction, ButtonAction } from "@slack/bolt";
import {
  fetchHealth,
  getBffUrl,
  resumeAgent,
  submitFeedback,
} from "./bff";
import {
  buildAgentResolvedBlocks,
  buildHealthBlocks,
  decodeFeedbackValue,
  decodeRetryValue,
} from "./blocks";
import { buildMediaHelpBlocks } from "./help";
import { releaseRetry, retryGuardKey, tryAcquireRetry } from "./retry-guard";
import {
  dispatchMediaOpsQuery,
  dispatchSlashQuery,
  isDirectMessage,
  isUserTextMessage,
  retryThreadScopedQuery,
  stripLeadingBotMention,
} from "./routing";

/**
 * Register all slash commands, @media-ops mentions, DMs, and interactive Block Kit button handlers.
 */
export function registerSlackHandlers(app: App): void {
  // 1. /media-ask <question> -> Grounded RAG stream (compact format)
  app.command("/media-ask", async ({ command, ack, respond, client }) => {
    await ack();
    const question = command.text.trim();
    if (!question) {
      await respond({
        response_type: "ephemeral",
        text: "Usage: `/media-ask <question>` (for example: `/media-ask Is the theme song cleared for EMEA streaming?`)",
      });
      return;
    }

    await dispatchSlashQuery({
      prompt: question,
      channel: command.channel_id,
      threadTs: command.thread_ts,
      client,
      route: "rag",
    });
  });

  // 2. /media-clearance <prompt> -> Multi-agent workflow + 202 human approval gate
  app.command("/media-clearance", async ({ command, ack, client }) => {
    await ack();
    const prompt =
      command.text.trim() || "Prepare clearance summary for Harbor Line S01E04 EMEA launch";

    await dispatchSlashQuery({
      prompt,
      channel: command.channel_id,
      threadTs: command.thread_ts,
      client,
      route: "clearance",
    });
  });

  // 3. /media-help -> Commands, samples, and documentation links
  app.command("/media-help", async ({ ack, respond }) => {
    await ack();
    await respond({
      response_type: "ephemeral",
      text: "Media Ops AI Assistant: use /media-ask, /media-clearance, /media-status, @media-ops, or DM the bot.",
      blocks: buildMediaHelpBlocks(),
    });
  });

  // 4. /media-status -> BFF health, environment, and pgvector index check
  app.command("/media-status", async ({ ack, respond }) => {
    await ack();
    try {
      const health = await fetchHealth();
      await respond({
        response_type: "ephemeral",
        text: `Applied AI Platform status: ${health.status}`,
        blocks: buildHealthBlocks(health, getBffUrl()),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Health check failed";
      await respond({
        response_type: "ephemeral",
        text: `Cannot reach BFF at \`${getBffUrl()}\`: ${msg}`,
      });
    }
  });

  // 5. @media-ops mention in channels -> routes to clearance agent or RAG Q&A in thread
  app.event("app_mention", async ({ event, client }) => {
    const cleaned = stripLeadingBotMention(event.text ?? "");
    const threadTs = event.thread_ts ?? event.ts;
    await dispatchMediaOpsQuery({
      prompt: cleaned,
      channel: event.channel,
      threadTs,
      client,
    });
  });

  // 6. Direct messages (message.im) -> same routing as @media-ops without a mention
  app.event("message", async ({ event, client }) => {
    if (event.subtype && event.subtype !== "file_share") return;
    if (!isDirectMessage(event)) return;
    if (!isUserTextMessage(event)) return;

    const threadTs = event.thread_ts ?? event.ts;
    await dispatchMediaOpsQuery({
      prompt: (event.text ?? "").trim(),
      channel: event.channel,
      threadTs,
      client,
    });
  });

  // 7. Interactive Block Kit button: Approve & Publish / Reject Draft
  const handleAgentDecision = (decision: "approve" | "reject") =>
    async ({ ack, body, action, respond }: {
      ack: () => Promise<void>;
      body: BlockAction;
      action: ButtonAction;
      respond: (msg: Record<string, unknown>) => Promise<unknown>;
    }) => {
      await ack();
      const threadId = action.value ?? "";
      const userId = body.user?.id;
      try {
        const resolved = await resumeAgent({ threadId, resume: decision });
        await respond({
          replace_original: true,
          text: `Clearance workflow ${resolved.status ?? decision} (${threadId})`,
          blocks: buildAgentResolvedBlocks(resolved, {
            threadId,
            reviewerUserId: userId,
          }),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Resume failed";
        await respond({
          replace_original: false,
          response_type: "ephemeral",
          text: `Failed to ${decision} session \`${threadId}\`: ${msg}`,
        });
      }
    };

  app.action<BlockAction<ButtonAction>>("agent_approve", handleAgentDecision("approve"));
  app.action<BlockAction<ButtonAction>>("agent_reject", handleAgentDecision("reject"));

  // 8. Interactive Block Kit button: Helpful / Needs work feedback
  const handleFeedback = (rating: "up" | "down") =>
    async ({ ack, action, respond }: {
      ack: () => Promise<void>;
      action: ButtonAction;
      respond: (msg: Record<string, unknown>) => Promise<unknown>;
    }) => {
      await ack();
      try {
        const meta = decodeFeedbackValue(action.value ?? "{}");
        await submitFeedback({
          sessionId: meta.sessionId,
          prompt: meta.prompt,
          response: meta.responseSnippet,
          rating,
        });
        await respond({
          replace_original: false,
          response_type: "ephemeral",
          text:
            rating === "up"
              ? "Recorded positive feedback in Applied AI Platform."
              : "Recorded feedback for prompt/retrieval review in Applied AI Platform.",
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Feedback failed";
        await respond({
          replace_original: false,
          response_type: "ephemeral",
          text: `Could not record feedback: ${msg}`,
        });
      }
    };

  app.action<BlockAction<ButtonAction>>("feedback_up", handleFeedback("up"));
  app.action<BlockAction<ButtonAction>>("feedback_down", handleFeedback("down"));

  // 9. Retry after BFF / SSE failure on RAG or clearance requests
  app.action<BlockAction<ButtonAction>>("bff_retry", async ({ ack, action, body, client, respond }) => {
    await ack();
    const channel = body.channel?.id;
    const messageTs = body.message?.ts;
    if (!channel || !messageTs) {
      await respond({
        response_type: "ephemeral",
        text: "Could not retry: missing channel or message context.",
      });
      return;
    }

    const guardKey = retryGuardKey(channel, messageTs);
    if (!tryAcquireRetry(guardKey)) {
      await respond({
        response_type: "ephemeral",
        text: "A retry is already running for this message. Wait for it to finish.",
      });
      return;
    }

    try {
      const meta = decodeRetryValue(action.value ?? "{}");
      await retryThreadScopedQuery({
        client,
        channel,
        messageTs,
        meta,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Retry failed";
      await respond({
        response_type: "ephemeral",
        text: `Retry could not start: ${msg}`,
      });
    } finally {
      releaseRetry(guardKey);
    }
  });
}
