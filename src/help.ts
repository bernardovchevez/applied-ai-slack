import type { KnownBlock } from "@slack/types";

export const DOCS_LOCAL_TESTING_URL =
  "https://github.com/bernardovchevez/applied-ai-slack/blob/main/docs/local-slack-testing.md";

export const DOCS_SAMPLE_PROMPTS_URL =
  "https://github.com/bernardovchevez/applied-ai-slack/blob/main/docs/local-slack-testing.md#sample-prompts-for-localhost-demos";

export const REPO_PLATFORM_URL = "https://github.com/bernardovchevez/applied-ai-platform";

/** Ephemeral help card for /media-help (commands, samples, docs). */
export function buildMediaHelpBlocks(): KnownBlock[] {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: "Media Ops AI Assistant", emoji: true },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          "Prototype Slack client for the *Applied AI Platform* BFF (`X-Client-Platform: slack`). " +
          "Requires the FastAPI BFF running locally or in stage/prod.",
      },
    },
    { type: "divider" },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          "*Slash commands*\n" +
          "• `/media-ask <question>` — Grounded RAG over the Harbor Line corpus\n" +
          "• `/media-clearance <prompt>` — Clearance agent with human approval card\n" +
          "• `/media-status` — BFF health, pgvector, and LLM provider\n" +
          "• `/media-help` — This guide",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          "*@media-ops in a channel* (invite the bot first) or *DM the bot* with plain text.\n" +
          "Clearance-style wording routes to the agent; other questions use RAG.\n" +
          "You will see *Working on it…* immediately; the message updates when the BFF responds.",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          "*Sample prompts*\n" +
          "• `/media-ask Is the theme song cleared for EMEA streaming?`\n" +
          "• `/media-clearance Prepare clearance summary for Harbor Line S01E04 EMEA launch`\n" +
          `• More: <${DOCS_SAMPLE_PROMPTS_URL}|Sample prompts for localhost demos>`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text:
            `<${DOCS_LOCAL_TESTING_URL}|Local Slack testing guide>` +
            ` · <${REPO_PLATFORM_URL}|applied-ai-platform>` +
            " · Prototype; not production-hardened",
        },
      ],
    },
  ];
}
