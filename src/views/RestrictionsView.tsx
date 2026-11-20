import { useRef, useState } from "react";
import { useEventListener, useResource } from "@/lib/effects";
import { cn, hasText } from "@/lib/utils";
import { liveStore } from "@/store";
import { useLayerScroll } from "@/threads/jump";
import type { Restriction } from "../../shared/restrictions-types";
import { ActionRow, type RowProps } from "./restrictions/ActionRow";
import { deleteRestriction, loadRestrictions, patchRestriction, postRestriction } from "./restrictions/api";
import { Advanced } from "./restrictions/CustomEditor";
import { MergeGateSwitch } from "./MergeGateSwitch";
import { MODES } from "./restrictions/look";
import { PeopleList } from "./restrictions/PeopleList";

type Tab = "actions" | "people";
const TABS: { tab: Tab; label: string }[] = [
  { tab: "actions", label: "Actions" },
  { tab: "people", label: "People" },
];
const PEOPLE_HASH = "#restrictions/people";

const KINDS: Record<string, string> = {
  message: "Message people",
  review: "Pull requests",
  approve: "Pull requests",
  merge: "Pull requests",
  reviewers: "Pull requests",
  pr: "Pull requests",
  push: "Push",
  jobs: "Start jobs and deploys",
  linear: "Linear",
  delete: "Delete",
  processes: "Processes",
  money: "Spend money",
  custom: "Your own rules",
};
const kindLabel = (action: string) => KINDS[action] ?? action.charAt(0).toUpperCase() + action.slice(1);

const tabInTheAddress = (): Tab => (location.hash === PEOPLE_HASH ? "people" : "actions");

function useTabInTheAddress() {
  const [tab, setTabState] = useState<Tab>(tabInTheAddress);
  const setTab = (t: Tab) => {
    setTabState(t);
    history.replaceState(history.state, "", t === "people" ? PEOPLE_HASH : "#restrictions");
  };
  useEventListener("hashchange", () => {
    if (location.hash.startsWith("#restrictions")) setTabState(tabInTheAddress());
  });
  return [tab, setTab] as const;
}

function useRestrictions(isLive: boolean) {
  const loaded = useResource(isLive ? "restrictions" : undefined, loadRestrictions);
  const list = loaded.value ?? [];
  const setList = (change: (all: Restriction[]) => Restriction[]) => loaded.set(all => change(all ?? []));
  const load = loaded.reload;
  const editShownAtOnceAndPutBackIfRefused = async (id: string, change: Partial<Restriction>) => {
    setList(all => all.map(r => (r.id === id ? { ...r, ...change } : r)));
    try {
      await patchRestriction(id, change);
    } catch (error) {
      await load();
      throw error;
    }
  };
  const remove = async (id: string) => {
    setList(all => all.filter(r => r.id !== id && r.parent !== id));
    try {
      await deleteRestriction(id);
    } catch {
      await load();
    }
  };
  const add = async (r: Partial<Restriction>) => {
    const saved = await postRestriction(r);
    setList(all => [...all, saved]);
    return saved;
  };
  const row: RowProps = { onEdit: editShownAtOnceAndPutBackIfRefused, onDelete: remove, onAdd: add };
  return { list, load, row };
}

function Legend() {
  return (
    <ul className="mb-6 grid grid-cols-3 divide-x rounded-xl border">
      {MODES.map(m => (
        <li key={m.mode} className="flex flex-col items-start gap-1.5 px-3 py-2.5">
          <span className={cn("w-16 rounded-md py-0.5 text-center text-xs font-medium", m.on)}>{m.label}</span>
          <span className="text-[13px] text-muted-foreground">{m.legendLine}</span>
        </li>
      ))}
    </ul>
  );
}

function RuleSection({ title, rules, list, row }: { title: string; rules: Restriction[]; list: Restriction[]; row: RowProps }) {
  return (
    <section className="mb-6">
      <h2 className="mb-1 px-2.5 text-[13px] font-medium text-muted-foreground">{title}</h2>
      {rules.some(r => r.id === "pr-merge") && <div className="px-2.5 pb-2"><MergeGateSwitch /></div>}
      <ol className="flex flex-col divide-y">
        {rules.map(r => (
          <ActionRow key={r.id} r={r} exceptions={list.filter(o => o.parent === r.id)} {...row} />
        ))}
      </ol>
    </section>
  );
}

function ActionsTab({ list, row }: { list: Restriction[]; row: RowProps }) {
  const builtins = list.filter(r => r.builtin === true && !hasText(r.parent));
  const custom = list.filter(r => r.builtin !== true && !hasText(r.parent));
  const sections = [...new Set(builtins.map(r => kindLabel(r.action)))];
  return (
    <>
      {sections.map(section => (
        <RuleSection key={section} title={section} rules={builtins.filter(r => kindLabel(r.action) === section)} list={list} row={row} />
      ))}
      {custom.length > 0 && <RuleSection title="Your own rules" rules={custom} list={list} row={row} />}
      <Advanced onAdd={row.onAdd} />
    </>
  );
}

export function RestrictionsView() {
  const isLive = liveStore.use();
  const [tab, setTab] = useTabInTheAddress();
  const scrollRef = useRef<HTMLDivElement>(null);
  const attachScroll = useLayerScroll("restrictions", scrollRef);
  const { list, load, row } = useRestrictions(isLive);
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center border-b px-5">
        <h1 className="text-sm font-medium">Restrictions</h1>
        <div className="ml-4 flex gap-0.5">
          {TABS.map(t => (
            <button key={t.tab} onClick={() => setTab(t.tab)} className={cn("rounded-md px-2 py-1 text-[13px]", tab === t.tab ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground")}>
              {t.label}
            </button>
          ))}
        </div>
      </header>
      <div ref={attachScroll} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-5 py-4">
          <p className="mb-3 px-2.5 text-sm text-muted-foreground">What your agents may do without asking you.</p>
          <Legend />
          {tab === "people" && <PeopleList list={list} {...row} onLinked={load} />}
          {tab === "actions" && <ActionsTab list={list} row={row} />}
        </div>
      </div>
    </div>
  );
}
