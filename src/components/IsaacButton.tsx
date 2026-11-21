import { Fingerprint, KeyRound, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { enrollAsIsaac, isaacStore, signInAsIsaac } from "@/lib/isaac";
import { cn } from "@/lib/utils";

const browserLabel = () => `${navigator.platform} · ${/Chrome\/\d+/.exec(navigator.userAgent)?.[0] ?? "browser"}`;

function lookOf(status: ReturnType<typeof isaacStore.get>) {
  if (status === undefined) return;
  if (status.enrolled.length === 0) return { icon: KeyRound, label: "Set up your passkey", title: "Enroll this browser's Touch ID passkey, so only you can act as Isaac here", isWarn: true };
  if (!status.signedIn) return { icon: Fingerprint, label: "Sign in with Touch ID", title: "Sign in with your passkey to post, merge and flip the gate as yourself", isWarn: true };
  return { icon: ShieldCheck, label: "Signed in as you", title: `Signed in with your passkey (${status.enrolled.map(p => p.label).join(", ")})`, isWarn: false };
}

export function IsaacButton({ open }: { open: boolean }) {
  const status = isaacStore.use();
  const [error, setError] = useState("");
  const look = lookOf(status);
  if (!status || !look) return null;
  const act = async () => {
    setError("");
    try {
      await (status.enrolled.length === 0 ? enrollAsIsaac(browserLabel()) : signInAsIsaac());
    } catch (error_) {
      setError(String(error_));
    }
  };
  const Icon = look.icon;
  return (
    <button
      type="button"
      onClick={() => {
        void act();
      }}
      title={error === "" ? look.title : error}
      data-agent="isaac-sign-in"
      className={cn("flex h-9 shrink-0 items-center gap-2 rounded-lg px-2.5 text-sm whitespace-nowrap hover:bg-black/[0.04]", look.isWarn ? "text-warn" : "text-muted-foreground")}
    >
      <Icon className="size-4 shrink-0" />
      {open && <span className="flex-1 truncate text-left">{look.label}</span>}
    </button>
  );
}
