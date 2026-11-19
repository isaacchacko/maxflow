import { FileText, Folder, MessageSquare } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useInterval, useResource } from "@/lib/effects";
import { cn, hasText } from "@/lib/utils";
import { keepRefs, md } from "@/threads/rich/components";
import { asLinks } from "@/threads/rich/parse";
import { remarkChips } from "@/threads/rich/remark";
import { RefChip } from "@/threads/Rich";
import { isRecord } from "../../shared/guards";
import { docSource, remarkCallouts } from "./docs/callouts";

type DocSummary = { path: string; owner?: string; open: number };
type Vault = { dir: string; docs: DocSummary[] };
type Doc = { path: string; text: string; owner?: string; obsidian: string };

const REFRESH_MS = 5000;

async function get(path: string): Promise<unknown> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function loadVault(): Promise<Vault> {
  const v = await get("/api/docs");
  if (!isRecord(v) || !Array.isArray(v["docs"])) throw new Error("The server didn't answer with the docs vault");
  return v as Vault;
}

async function loadDoc(path: string): Promise<Doc> {
  const d = await get(`/api/docs/${encodeURIComponent(path)}`);
  if (!isRecord(d) || typeof d["text"] !== "string") throw new Error(`The server didn't answer with ${path}`);
  return d as Doc;
}

const withExtension = (path: string) => (/\.\w+$/.test(path) ? path : `${path}.md`);
const obsidianVaultUrl = (dir: string) => `obsidian://open?path=${encodeURIComponent(dir)}`;

function ObsidianButton({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} data-agent="docs:obsidian" className="shrink-0 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted">
      {label}
    </a>
  );
}

function Tree({ docs, selected }: { docs: DocSummary[]; selected: string | undefined }) {
  const rows: React.ReactNode[] = [];
  let lastFolder = "";
  for (const d of docs) {
    const parts = d.path.split("/");
    const folder = parts.slice(0, -1).join("/");
    if (folder !== lastFolder && hasText(folder)) {
      rows.push(
        <div key={`dir:${folder}`} className="flex items-center gap-1.5 px-2 pt-2 pb-0.5 text-xs text-muted-foreground">
          <Folder className="size-3.5" />
          {folder}
        </div>,
      );
    }
    lastFolder = folder;
    rows.push(
      <a
        key={d.path}
        href={`#docs/${encodeURI(d.path)}`}
        data-agent={`docs:file:${d.path}`}
        className={cn("flex h-7 items-center gap-2 rounded-md px-2 text-[13px] hover:bg-black/[0.04]", hasText(folder) && "pl-5", d.path === selected && "bg-muted font-medium")}
      >
        <FileText className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{parts.at(-1)?.replace(/\.md$/, "")}</span>
        {d.open > 0 && (
          <span title={`${d.open} open comment(s)`} className="flex items-center gap-0.5 rounded-full bg-warn-soft px-1.5 text-[11px] text-warn tabular-nums">
            <MessageSquare className="size-3" />
            {d.open}
          </span>
        )}
      </a>,
    );
  }
  return <nav className="flex flex-col gap-px p-2">{rows}</nav>;
}

const propOf = (node: unknown, key: string) => {
  const properties = isRecord(node) && isRecord(node["properties"]) ? node["properties"] : {};
  const value = properties[key];
  return typeof value === "string" ? value : undefined;
};

const docMd: Components = {
  ...md,
  h1: ({ children }) => <h1 className="mt-6 mb-3 text-2xl font-semibold first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-5 mb-2 text-lg font-semibold first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-4 mb-1.5 text-base font-semibold first:mt-0">{children}</h3>,
  p: ({ children }) => <p className="my-2.5 leading-relaxed">{children}</p>,
  blockquote: ({ node, children }) => {
    const kind = propOf(node, "dataCallout");
    const who = propOf(node, "dataWho");
    if (kind === "reply") {
      return (
        <div data-agent="docs:reply" className="mt-2 border-l-2 pl-3">
          <div className="text-xs font-medium text-muted-foreground">{who}</div>
          <div className="text-[13px]">{children}</div>
        </div>
      );
    }
    if (kind === "comment") {
      const isOpen = propOf(node, "dataOpen") === "true";
      return (
        <aside data-agent={isOpen ? "docs:comment-open" : "docs:comment"} className={cn("my-3 rounded-lg border p-3 text-[13px] [&_p]:my-1", isOpen ? "border-warn/60 bg-warn-soft/40" : "bg-muted/40")}>
          <div className="mb-1 flex items-center gap-1.5 text-xs font-medium">
            <MessageSquare className={cn("size-3.5", isOpen ? "text-warn" : "text-muted-foreground")} />
            {who}
            <span className={cn("ml-auto", isOpen ? "text-warn" : "text-muted-foreground")}>{isOpen ? "waiting on an answer" : "answered"}</span>
          </div>
          {children}
        </aside>
      );
    }
    return <blockquote className="my-2.5 border-l-2 pl-3 text-muted-foreground">{children}</blockquote>;
  },
};

function DocPage({ path, summary }: { path: string; summary: DocSummary | undefined }) {
  const loaded = useResource(`doc:${path}`, async () => loadDoc(path));
  useInterval(loaded.reload, REFRESH_MS);
  const doc = loaded.value;
  if (!doc) return <p className="p-6 text-sm text-muted-foreground">{loaded.error?.message ?? "Loading…"}</p>;
  return (
    <article className="min-w-0 flex-1 overflow-y-auto">
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b bg-card px-6 py-2.5">
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{doc.path}</span>
        {hasText(doc.owner) && <RefChip r={{ kind: "agent", id: doc.owner }} />}
        {(summary?.open ?? 0) > 0 && <span className="text-xs text-warn">{summary?.open} open comment(s)</span>}
        <span className="flex-1" />
        <ObsidianButton href={doc.obsidian} label="Open in Obsidian" />
      </header>
      <div className="mx-auto max-w-3xl px-6 py-5 text-sm">
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkChips, remarkCallouts]} components={docMd} urlTransform={keepRefs}>
          {asLinks(docSource(doc.text))}
        </ReactMarkdown>
      </div>
    </article>
  );
}

export function DocsView({ path }: { path: string | undefined }) {
  const vault = useResource("docs", loadVault);
  useInterval(vault.reload, REFRESH_MS);
  const docs = vault.value?.docs ?? [];
  const shown = hasText(path) ? withExtension(path) : (docs.find((d) => d.open > 0) ?? docs[0])?.path;
  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-60 shrink-0 flex-col border-r">
        <div className="flex items-center gap-2 border-b px-3 py-2.5">
          <span className="text-sm font-semibold">Docs</span>
          <span className="flex-1" />
          {vault.value && <ObsidianButton href={obsidianVaultUrl(vault.value.dir)} label="Vault" />}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Tree docs={docs} selected={shown} />
        </div>
      </aside>
      {hasText(shown) ? (
        <DocPage key={shown} path={shown} summary={docs.find((d) => d.path === shown)} />
      ) : (
        <p className="p-6 text-sm text-muted-foreground">
          {vault.error?.message ?? (vault.value ? `No docs yet in ${vault.value.dir}. Agents write them with maxflow docs write, and Obsidian opens the vault for you.` : "Loading…")}
        </p>
      )}
    </div>
  );
}
