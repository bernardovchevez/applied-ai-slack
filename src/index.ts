import path from "node:path";
import dotenv from "dotenv";
import { App, HTTPReceiver } from "@slack/bolt";
import { APP_ENV, getBffUrl } from "./bff";
import { registerSlackHandlers } from "./handlers";

// Load base .env and optional .env.<APP_ENV>
dotenv.config({ path: path.resolve(process.cwd(), ".env") });
dotenv.config({
  path: path.resolve(process.cwd(), `.env.${APP_ENV}`),
  override: true,
});

export function isSocketMode(): boolean {
  const explicit = process.env.SLACK_SOCKET_MODE?.trim().toLowerCase();
  if (explicit === "true" || explicit === "1") return true;
  if (explicit === "false" || explicit === "0") return false;
  return APP_ENV === "localhost";
}

export function createSlackApp(): App {
  const botToken = process.env.SLACK_BOT_TOKEN ?? "xoxb-placeholder";
  const signingSecret = process.env.SLACK_SIGNING_SECRET ?? "signing-secret-placeholder";
  const socketMode = isSocketMode();

  if (socketMode) {
    const app = new App({
      token: botToken,
      signingSecret,
      socketMode: true,
      appToken: process.env.SLACK_APP_TOKEN,
    });
    registerSlackHandlers(app);
    return app;
  }

  const receiver = new HTTPReceiver({
    signingSecret,
    endpoints: ["/slack/events"],
    customRoutes: [
      {
        path: "/health",
        method: ["GET"],
        handler: (_req, res) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              status: "ok",
              service: "applied-ai-slack",
              environment: APP_ENV,
              mode: "http",
              bff_url: getBffUrl(),
            }),
          );
        },
      },
    ],
  });

  const app = new App({
    token: botToken,
    receiver,
  });
  registerSlackHandlers(app);
  return app;
}

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3001);
  const socketMode = isSocketMode();
  const app = createSlackApp();

  await app.start(port);
  console.log(
    `[applied-ai-slack] running (env=${APP_ENV}, mode=${socketMode ? "socket" : `http:${port}`}, bff=${getBffUrl()})`,
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[applied-ai-slack] startup error:", err);
    process.exit(1);
  });
}
