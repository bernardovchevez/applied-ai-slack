import type { App, BlockAction, ButtonAction } from "@slack/bolt";
import {
  askRag,
  fetchHealth,
  getBffUrl,
  isAgentPaused,
  resumeAgent,
  runAgent,
  submitFeedback,
} from "./bff";
import {
  buildAgentPausedBlocks,
  buildAgentResolvedBlocks,
  buildHealthBlocks,
  buildRagAnswerBlocks,
  decodeFeedbackValue,
} from "./blocks";

const CLEARANCE_INTENT_RE =
  /\b(clearance summary|production brief|draft brief|launch summary|prepare.*clearance)\b/i;

/**
 * Register all slash commands, @media-ops mentions, and interactive Block Kit button handlers.
 */
export function registerSlackHandlers(app: App): void {
  // 1. /media-ask <question> -> Grounded RAG stream (compact format)
  app.command("/media-ask", async ({ command, ack, respond }) => {
    await ack();
    const question = command.text.trim();
    if (!question) {
      await respond({
        response_type: "ephemeral",
        text: "Usage: `/media-ask <question>` (for example: `/media-ask Is the theme song cleared for EMEA streaming?`)",
      });
      return;
    }

    const sessionId = `slack-${command.channel_id}-${command.user_id}-${Date.now()}`;
    await respond({
      response_type: "in_channel",
      text: `Searching media operations corpus for: _"${question}"_...`,
    });

    try {
      const result = await askRag(question, sessionId);
      await respond({
        response_type: "in_channel",
        replace_original: true,
        text: result.answer,
        blocks: buildRagAnswerBlocks(result),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to reach BFF";
      await respond({
        response_type: "ephemeral",
        replace_original: true,
        text: `Error querying Applied AI Platform BFF: ${msg}`,
      });
    }
  });

  // 2. /media-clearance <prompt> -> Multi-agent workflow + 202 human approval gate
  app.command("/media-clearance", async ({ command, ack, respond }) => {
    await ack();
    const prompt =
      command.text.trim() || "Prepare clearance summary for Harbor Line S01E04 EMEA launch";
    const sessionId = `slack-agent-${command.channel_id}-${Date.now()}`;

    await respond({
      response_type: "in_channel",
      text: `Running multi-agent clearance workflow for: _"${prompt}"_...`,
    });

    try {
      const res = await runAgent({ prompt, sessionId, autoApprove: false });
      if (isAgentPaused(res)) {
        await respond({
          response_type: "in_channel",
          replace_original: true,
          text: `Clearance workflow paused for human approval (thread ${res.thread_id})`,
          blocks: buildAgentPausedBlocks(res),
        });
      } else {
        await respond({
          response_type: "in_channel",
          replace_original: true,
          text: res.answer,
          blocks: buildAgentResolvedBlocks(res, { threadId: sessionId, prompt }),
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Agent workflow failed";
      await respond({
        response_type: "ephemeral",
        replace_original: true,
        text: `Error running clearance agent: ${msg}`,
      });
    }
  });

  // 3. /media-status -> BFF health, environment, and pgvector index check
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

  // 4. @media-ops mention in channels -> routes to clearance agent or RAG Q&A in thread
  app.event("app_mention", async ({ event, say }) => {
    const cleaned = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();
    const threadTs = event.thread_ts ?? event.ts;
    if (!cleaned) {
      await say({
        thread_ts: threadTs,
        text: "Ask me a media ops question or request a clearance brief (for example: `@media-ops Is Harbor Line cleared for EMEA streaming?`).",
      });
      return;
    }

    const sessionId = `slack-thread-${event.channel}-${threadTs}`;
    try {
      if (CLEARANCE_INTENT_RE.test(cleaned)) {
        const res = await runAgent({ prompt: cleaned, sessionId, autoApprove: false });
        if (isAgentPaused(res)) {
          await say({
            thread_ts: threadTs,
            text: `Clearance workflow awaiting approval (${res.thread_id})`,
            blocks: buildAgentPausedBlocks(res),
          });
        } else {
          await say({
            thread_ts: threadTs,
            text: res.answer,
            blocks: buildAgentResolvedBlocks(res, { threadId: sessionId, prompt: cleaned }),
          });
        }
      } else {
        const rag = await askRag(cleaned, sessionId);
        await say({
          thread_ts: threadTs,
          text: rag.answer,
          blocks: buildRagAnswerBlocks(rag),
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "BFF request failed";
      await say({
        thread_ts: threadTs,
        text: `Error communicating with Applied AI Platform BFF: ${msg}`,
      });
    }
  });

  // 5. Interactive Block Kit button: Approve & Publish / Reject Draft
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

  // 6. Interactive Block Kit button: Helpful / Needs work feedback
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
}
