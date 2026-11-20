import { AgentFace } from "@/components/AgentFace";
import { AgentLink } from "@/components/AgentLink";
import { WakesWhen } from "@/components/Waiting";
import type { Thread } from "@/mock";
import { when } from "../MessageRow";
import { Rich } from "../Rich";

type Sleeper = NonNullable<Thread["asleep"]>[number];

function AsleepLine({ sleeper, status }: { sleeper: Sleeper; status: string | undefined }) {
  return (
    <p data-agent="thread-asleep" data-session={sleeper.sessionId} title={`${sleeper.name} asleep since ${when(sleeper.at)}: claude is stopped to free memory; it wakes when ${sleeper.wakes}, or when any message reaches it`} className="flex max-w-full min-w-0 items-center gap-2.5 py-1 text-sm text-muted-foreground">
      <span className="flex w-9 shrink-0 justify-center">
        <AgentLink id={sleeper.sessionId} className="flex">
          <AgentFace id={sleeper.sessionId} expression="asleep" still className="size-7" />
        </AgentLink>
      </span>
      <span className="min-w-0">
        <AgentLink id={sleeper.sessionId} className="font-medium text-foreground">
          {sleeper.name}
        </AgentLink>{" "}
        is asleep to free memory, since {when(sleeper.at)}. <WakesWhen wait={sleeper.wait} />
        {status !== undefined && status !== "" && (
          <>
            {" "}
            <Rich still text={status} />
          </>
        )}
      </span>
    </p>
  );
}

export const isPendingOnASleeper = (thread: Thread) => thread.asleep?.some(s => s.sessionId === thread.pending?.waitingOn) === true;

export function AsleepLines({ thread }: { thread: Thread }) {
  return (thread.asleep ?? []).map(s => <AsleepLine key={s.sessionId} sleeper={s} status={s.sessionId === thread.pending?.waitingOn ? thread.pending.status : undefined} />);
}
