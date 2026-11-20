import { ShieldCheck, ShieldOff } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useResource } from "@/lib/effects";
import { isRecord } from "../../shared/guards";

type Gate = { on: boolean; at: number };
const isGate = (value: unknown): value is Gate => isRecord(value) && typeof value["on"] === "boolean";

async function send(init?: RequestInit): Promise<Gate> {
  const res = await fetch("/api/merge-gate", init);
  if (!res.ok) throw new Error(await res.text());
  const answer: unknown = await res.json();
  if (!isGate(answer)) throw new Error("The server didn't answer with the merge gate");
  return answer;
}

const loadGate = async () => send();

export function MergeGateSwitch() {
  const gate = useResource("merge-gate", loadGate);
  const [error, setError] = useState<string>();
  const isOn = gate.value?.on === true;
  const flip = async () => {
    try {
      const next = await send({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on: !isOn }) });
      gate.set(() => next);
      setError(undefined);
    } catch (error_) {
      setError(String(error_));
    }
  };
  if (gate.value === undefined) return null;
  return (
    <div className="flex items-center gap-2 text-xs" data-agent="merge-gate">
      {isOn ? <ShieldCheck className="size-4 text-ok" /> : <ShieldOff className="size-4 text-muted-foreground" />}
      <span className="text-muted-foreground">
        Merge gate {isOn ? "on: only you merge PRs" : "off: agents merge as the pr-merge restriction allows"}
      </span>
      <Button size="xs" variant="outline" onClick={() => void flip()}>
        Turn {isOn ? "off" : "on"}
      </Button>
      {error !== undefined && <span className="text-destructive">{error}</span>}
    </div>
  );
}
