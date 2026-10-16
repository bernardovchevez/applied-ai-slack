import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  askRag,
  buildBffHeaders,
  frameToStreamEvent,
  isAgentPaused,
  normalizeEnv,
  parseSseFrames,
  resumeAgent,
  runAgent,
} from "../src/bff";
import {
  buildAgentPausedBlocks,
  buildAgentResolvedBlocks,
  buildHealthBlocks,
  buildRagAnswerBlocks,
  decodeFeedbackValue,
  encodeFeedbackValue,
  toSlackMrkdwn,
} from "../src/blocks";
import { buildMediaHelpBlocks, DOCS_LOCAL_TESTING_URL } from "../src/help";
import { workingMessageText } from "../src/progress";
import {
  isClearancePrompt,
  isDirectMessage,
  isUserTextMessage,
  slackThreadRootTs,
  slackThreadSessionId,
  stripLeadingBotMention,
} from "../src/routing";

describe("Environment & BFF Headers", () => {
  it("normalizes APP_ENV aliases to localhost, stage, or production", () => {
    assert.equal(normalizeEnv(undefined), "localhost");
    assert.equal(normalizeEnv("local"), "localhost");
    assert.equal(normalizeEnv("staging"), "stage");
    assert.equal(normalizeEnv("stage"), "stage");
    assert.equal(normalizeEnv("prod"), "production");
    assert.equal(normalizeEnv("production"), "production");
  });

  it("includes X-Client-Platform: slack and optional Bearer token", () => {
    const prev = process.env.BFF_API_KEY;
    try {
      process.env.BFF_API_KEY = "secret-stage-key";
      const headers = buildBffHeaders({ "X-Session-Id": "slack-thread-1" });
      assert.equal(headers["X-Client-Platform"], "slack");
      assert.equal(headers["X-Session-Id"], "slack-thread-1");
      assert.equal(headers["Authorization"], "Bearer secret-stage-key");
    } finally {
      if (prev === undefined) delete process.env.BFF_API_KEY;
      else process.env.BFF_API_KEY = prev;
    }
  });
});

describe("SSE Framing & Stream Parsing", () => {
  it("parses sse-starlette CRLF frames into sources, token, and done events", () => {
    const raw =
      'event: sources\r\ndata: [{"file_name":"music-clearance-emea.md","rights_tier":"cleared"}]\r\n\r\n' +
      "event: token\r\ndata: **Cleared** through 2027-12-31.\r\n\r\n" +
      'event: done\r\ndata: {"session_id":"s-1","provider":"openai","latency_ms":420}\r\n\r\n';

    const { frames, rest } = parseSseFrames(raw);
    assert.equal(rest, "");
    assert.equal(frames.length, 3);

    const ev0 = frameToStreamEvent(frames[0]);
    assert.equal(ev0?.type, "sources");
    assert.equal(ev0?.sources[0].file_name, "music-clearance-emea.md");

    const ev1 = frameToStreamEvent(frames[1]);
    assert.equal(ev1?.type, "token");
    assert.equal(ev1?.text, "**Cleared** through 2027-12-31.");

    const ev2 = frameToStreamEvent(frames[2]);
    assert.equal(ev2?.type, "done");
    assert.equal(ev2?.payload.latency_ms, 420);
  });

  it("consumes /v1/chat/stream SSE response via askRag", async () => {
    const sseBody =
      'event: sources\ndata: [{"file_name":"music-clearance-emea.md","rights_tier":"cleared"}]\n\n' +
      "event: token\ndata: EMEA SVOD is **Cleared**.\n\n" +
      'event: done\ndata: {"session_id":"slack-1","provider":"ollama","latency_ms":310,"final_answer":"EMEA SVOD is **Cleared** through 2027-12-31."}\n\n';

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(sseBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })) as typeof fetch;

    try {
      const result = await askRag("Is EMEA cleared?", "slack-1");
      assert.equal(result.answer, "EMEA SVOD is **Cleared** through 2027-12-31.");
      assert.equal(result.sources.length, 1);
      assert.equal(result.sources[0].file_name, "music-clearance-emea.md");
      assert.equal(result.latencyMs, 310);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("/media-help", () => {
  it("builds help blocks with commands and doc links", () => {
    const blocks = buildMediaHelpBlocks();
    assert.ok(blocks.length >= 5);
    assert.equal(blocks[0].type, "header");
    const body = JSON.stringify(blocks);
    assert.match(body, /\/media-ask/);
    assert.match(body, /\/media-clearance/);
    assert.match(body, /\/media-status/);
    assert.match(body, /\/media-help/);
    assert.ok(body.includes(DOCS_LOCAL_TESTING_URL));
  });
});

describe("Media ops routing (mentions + DMs)", () => {
  it("strips bot mentions and detects clearance intent", () => {
    assert.equal(stripLeadingBotMention("<@U1> Is EMEA cleared?"), "Is EMEA cleared?");
    assert.equal(isClearancePrompt("Prepare clearance summary for Harbor Line"), true);
    assert.equal(isClearancePrompt("Is EMEA cleared?"), false);
  });

  it("builds stable thread session ids", () => {
    assert.equal(slackThreadSessionId("C123", "1234.5678"), "slack-thread-C123-1234.5678");
    assert.equal(slackThreadRootTs("1111.0001", "2222.0002"), "1111.0001");
    assert.equal(slackThreadRootTs(undefined, "2222.0002"), "2222.0002");
  });

  it("filters DM user text messages", () => {
    assert.equal(isDirectMessage({ channel_type: "im" }), true);
    assert.equal(isDirectMessage({ channel_type: "channel" }), false);
    assert.equal(isUserTextMessage({ text: "hello" }), true);
    assert.equal(isUserTextMessage({ text: "hello", bot_id: "B1" }), false);
    assert.equal(isUserTextMessage({ text: "x", subtype: "message_changed" }), false);
  });

  it("builds working-on-it placeholder copy for RAG and clearance", () => {
    assert.match(workingMessageText("Is EMEA cleared?", false), /Working on it/i);
    assert.match(workingMessageText("Is EMEA cleared?", false), /Is EMEA cleared/);
    assert.match(
      workingMessageText("Prepare clearance summary for Harbor Line", true),
      /clearance workflow/i,
    );
    assert.match(workingMessageText("Prepare clearance summary for Harbor Line"), /minute on localhost/);
  });
});

describe("Slack Block Kit Builders & Human Approval Flow", () => {
  it("converts markdown bold to Slack mrkdwn and builds RAG answer blocks", () => {
    assert.equal(toSlackMrkdwn("Status is **Cleared** for **EMEA**."), "Status is *Cleared* for *EMEA*.");

    const blocks = buildRagAnswerBlocks({
      question: "Is EMEA cleared?",
      answer: "EMEA is **Cleared** through 2027-12-31.",
      sources: [{ file_name: "music-clearance-emea.md", rights_tier: "cleared" }],
      sessionId: "sess-42",
      provider: "openai",
      latencyMs: 250,
    });
    assert.equal(blocks.length, 3);
    assert.equal(blocks[0].type, "section");
    assert.equal(blocks[2].type, "actions");

    const encoded = encodeFeedbackValue({
      sessionId: "sess-42",
      prompt: "Is EMEA cleared?",
      responseSnippet: "EMEA is Cleared",
    });
    const decoded = decodeFeedbackValue(encoded);
    assert.equal(decoded.sessionId, "sess-42");
  });

  it("handles 202 paused clearance workflow and 200 approve resume", async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            thread_id: "thread-emea-99",
            message: "Human approval required",
            proposed_output: "**Harbor Line** is **cleared** for **EMEA**.",
            prompt: "Prepare clearance summary for Harbor Line EMEA",
            sources: [{ file_name: "music-clearance-emea.md", rights_tier: "cleared" }],
            tool_trace: [{ tool: "lookup_rights" }],
          }),
          { status: 202, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          answer: "**Harbor Line** is **cleared** for **EMEA**.",
          sources: [{ file_name: "music-clearance-emea.md", rights_tier: "cleared" }],
          tool_trace: [{ tool: "lookup_rights" }],
          status: "approved",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const initial = await runAgent({
        prompt: "Prepare clearance summary for Harbor Line EMEA",
        sessionId: "slack-sess-1",
      });
      assert.equal(isAgentPaused(initial), true);
      if (isAgentPaused(initial)) {
        const pausedBlocks = buildAgentPausedBlocks(initial);
        assert.equal(pausedBlocks[0].type, "header");
        assert.equal(pausedBlocks[pausedBlocks.length - 1].type, "actions");

        const resumed = await resumeAgent({
          threadId: initial.thread_id,
          resume: "approve",
        });
        assert.equal(resumed.status, "approved");
        const resolvedBlocks = buildAgentResolvedBlocks(resumed, {
          threadId: initial.thread_id,
          reviewerUserId: "U12345",
        });
        assert.equal(resolvedBlocks[0].type, "header");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("builds health blocks for /media-status", () => {
    const blocks = buildHealthBlocks(
      {
        status: "ok",
        version: "0.1.0",
        environment: "stage",
        state_store: "postgres",
        pgvector: { status: "ok", document_count: 27, chunk_count: 81 },
        llm: { status: "ok", provider: "openai" },
      },
      "https://stage-api.example-media.com",
    );
    assert.equal(blocks.length, 3);
    assert.equal(blocks[0].type, "header");
  });
});
