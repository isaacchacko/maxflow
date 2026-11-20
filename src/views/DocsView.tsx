import { MessageSquarePlus } from "lucide-react";
import { useInterval, useResource } from "@/lib/effects";
import { cn, hasText } from "@/lib/utils";
import { RefChip } from "@/threads/Rich";
import { type Doc, type DocSummary, loadDoc, loadVault, type Vault } from "./docs/api";
import { CanvasPane } from "./docs/Canvas";
import { useDocEditor } from "./docs/Editor";
import { Tree } from "./docs/Tree";

const VAULT_CHECK_MS = 5000;

const withExtension = (path: string) => (/\.\w+$/.test(path) ? path : `${path}.md`);

function DocEditor({ doc, summary }: { doc: Doc; summary: DocSummary | undefined }) {
  const { mount, comment, status, isWarning } = useDocEditor(doc);
  const open = summary?.open ?? 0;
  return (
    <article className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b px-6 py-2.5">
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{doc.path}</span>
        {hasText(doc.owner) && <RefChip r={{ kind: "agent", id: doc.owner }} />}
        {open > 0 && <span className="text-xs text-warn">{open} open comment(s)</span>}
        <span className="flex-1" />
        <span data-agent="docs:status" className={cn("text-xs", isWarning ? "text-destructive" : "text-muted-foreground")}>
          {status}
        </span>
        <button type="button" data-agent="docs:comment" title="Comment on the selection (⌘⇧M)" onMouseDown={(e) => e.preventDefault()} onClick={comment} className="flex shrink-0 items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted">
          <MessageSquarePlus className="size-3.5" />
          Comment
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div ref={mount} data-agent="docs:editor" className="mx-auto max-w-3xl px-6" />
      </div>
    </article>
  );
}

function DocPane({ path, vault }: { path: string; vault: { docs: DocSummary[] } }) {
  const loaded = useResource(`doc:${path}`, async () => loadDoc(path));
  if (!loaded.value) return <p className="p-6 text-sm text-muted-foreground">{loaded.error?.message ?? "Loading…"}</p>;
  return <DocEditor doc={loaded.value} summary={vault.docs.find((d) => d.path === path)} />;
}

const firstToShow = (docs: DocSummary[]) => (docs.find((d) => d.open > 0) ?? docs[0])?.path;

function emptyText(vault: { error?: Error; value?: unknown }) {
  if (vault.error) return vault.error.message;
  return vault.value === undefined ? "Loading…" : "No docs yet. Make one with the new-doc or new-canvas button.";
}

function Shown({ path, vault }: { path: string | undefined; vault: { error?: Error; value?: Vault } }) {
  if (!hasText(path) || !vault.value) return <p className="p-6 text-sm text-muted-foreground">{emptyText(vault)}</p>;
  if (path.endsWith(".canvas")) return <CanvasPane key={path} path={path} />;
  return <DocPane key={path} path={path} vault={vault.value} />;
}

export function DocsView({ path }: { path: string | undefined }) {
  const vault = useResource("docs", loadVault);
  useInterval(vault.reload, VAULT_CHECK_MS);
  const shown = hasText(path) ? withExtension(path) : firstToShow(vault.value?.docs ?? []);
  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-64 shrink-0 flex-col border-r">
        <div className="flex items-center gap-2 border-b px-3 py-2.5">
          <span className="text-sm font-semibold">Docs</span>
        </div>
        {vault.value && <Tree vault={vault.value} selected={shown} onChanged={vault.reload} />}
      </aside>
      <Shown path={shown} vault={vault} />
    </div>
  );
}
