import { peekStateJson } from "./state";
import { isRecord } from "./shared/guards";

export const AGENT_BOARD_CONFIG = "agent-board.json";

export function agentBoardUrl(): string | undefined {
  const config = peekStateJson(AGENT_BOARD_CONFIG);
  const url = isRecord(config) ? config["url"] : undefined;
  return typeof url === "string" && url !== "" ? url.replace(/\/$/, "") : undefined;
}
