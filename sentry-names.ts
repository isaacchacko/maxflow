export const PLAIN_SENTRIES = ["gh", "slack", "rename", "health", "graph", "ram", "inbox", "approval", "docs", "jev"];
export const LIVE_ONLY_SENTRIES = new Set(["health"]);
export const FED_AGENT_SENTRIES = ["review", "meta", "assistant", "context", "todo"];
export const BARE_AGENT_SENTRIES = ["funnel"];
export const SENTRY_HELPERS = [
  "approval-comment",
  "approval-notify",
  "approval-review",
  "approval-score",
  "assistant-tasks",
  "feed-process",
  "inbox-board",
  "inbox-feed",
  "inbox-fyi",
  "inbox-github",
  "inbox-pr-events",
  "inbox-slack",
  "inbox-stalls",
  "inbox-state",
  "meta-digest",
  "singleton",
  "slack-conversations",
  "slack-notify",
  "slack-places",
  "slack-sessions",
  "transcript-read",
];
export const SENTRY_NAMES = [...PLAIN_SENTRIES, ...FED_AGENT_SENTRIES, ...BARE_AGENT_SENTRIES].map((n) => `sentry:${n}`);
