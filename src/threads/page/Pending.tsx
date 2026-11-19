import { AgentFace } from "@/components/AgentFace";
import { AgentLink } from "@/components/AgentLink";
import { Elapsed } from "@/components/Working";
import { cn } from "@/lib/utils";
import type { Thread } from "@/mock";
import { when } from "../MessageRow";
import { Rich } from "../Rich";

type RouterFace = { router: string; expression: "working" | "error"; isStill: boolean };

function InlineRouterFace({ router, expression, isStill }: RouterFace) {
  return (
    <AgentLink id={router} className="flex shrink-0">
      <AgentFace id={router} expression={expression} still={isStill} small className="size-5" />
    </AgentLink>
  );
}

function ColumnRouterFace({ router, expression, isStill }: RouterFace) {
  return (
    <span className="flex w-9 shrink-0 justify-center">
      <AgentLink id={router} className="flex">
        <AgentFace id={router} expression={expression} still={isStill} className="size-7" />
      </AgentLink>
    </span>
  );
}

function RouterStatus({ status }: { status: string | undefined }) {
  if (status === undefined || status === "") return <span className="shimmer-soft min-w-0 truncate">Thinking…</span>;
  return (
    <span className="min-w-0 truncate">
      <Rich still text={status} />
    </span>
  );
}

export function Pending({ pending, names, inline }: { pending: NonNullable<Thread["pending"]>; names: string[]; inline?: boolean }) {
  const isInline = inline === true;
  const who = `${names.length > 1 ? "routers" : "router"} ${names.join(", ")}`;
  const router = pending.routerIds[0] ?? "";
  const Face = isInline ? InlineRouterFace : ColumnRouterFace;
  const row = cn("flex max-w-full min-w-0 items-center text-muted-foreground", isInline ? "gap-1.5 text-xs" : "gap-2.5 py-1 text-sm");
  if (pending.stale)
    return (
      <p data-agent="thread-pending" title={`${who} stopped without answering (since ${when(pending.since)})`} className={row}>
        <Face router={router} expression="error" isStill />
        <span className="min-w-0 truncate">Stopped without answering</span>
      </p>
    );
  return (
    <p data-agent="thread-pending" title={`${who}: ${pending.status ?? "working on a response"} (since ${when(pending.since)})`} className={row}>
      <Face router={router} expression="working" isStill={false} />
      <RouterStatus status={pending.status} />
      <Elapsed since={pending.since} className="text-[0.85em] opacity-80" />
    </p>
  );
}
