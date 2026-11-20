import { ChevronDown, ChevronRight, FilePlus, FileText, Folder, FolderPlus, MessageSquare, Pencil, Shapes, SquareDashedMousePointer, Trash2 } from "lucide-react";
import { useState } from "react";
import { cn, hasText } from "@/lib/utils";
import { createCanvas } from "./canvas-api";
import { createDoc, type DocSummary, makeFolder, moveDoc, moveFolder, removeDoc, removeFolder, type Vault } from "./api";

type Kind = "doc" | "canvas" | "folder";
type Editing = { kind: Kind; mode: "new" | "rename"; path: string };
type Props = { vault: Vault; selected: string | undefined; onChanged: () => Promise<unknown> };

const parentOf = (path: string) => path.split("/").slice(0, -1).join("/");
const nameOf = (path: string) => (path.split("/").at(-1) ?? path).replace(/\.(md|canvas)$/, "");
const withMd = (path: string) => (path.endsWith(".md") ? path : `${path}.md`);
const withCanvas = (path: string) => (path.endsWith(".canvas") ? path : `${path}.canvas`);
const goTo = (path: string) => {
  location.hash = `docs/${encodeURI(path)}`;
};

async function apply(e: Editing, typed: string) {
  if (e.kind === "doc" && e.mode === "new") {
    await createDoc(withMd(typed), `# ${nameOf(typed)}\n\n`);
    goTo(withMd(typed));
  } else if (e.kind === "canvas" && e.mode === "new") {
    await createCanvas(withCanvas(typed));
    goTo(withCanvas(typed));
  } else if (e.kind === "folder" && e.mode === "new") await makeFolder(typed);
  else if (e.kind === "canvas") {
    await moveDoc(e.path, withCanvas(typed));
    goTo(withCanvas(typed));
  } else if (e.kind === "doc") {
    await moveDoc(e.path, withMd(typed));
    goTo(withMd(typed));
  } else await moveFolder(e.path, typed);
}

function startingText(e: Editing) {
  if (e.mode === "rename") return e.path.replace(/\.(md|canvas)$/, "");
  return hasText(e.path) ? `${e.path}/` : "";
}

function NameInput({ editing, onDone }: { editing: Editing; onDone: (typed: string | undefined) => void }) {
  const Icon = { doc: FileText, canvas: Shapes, folder: Folder }[editing.kind];
  return (
    <label className="flex h-7 items-center gap-2 rounded-md bg-muted px-2">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        autoFocus
        data-agent="docs:name-input"
        defaultValue={startingText(editing)}
        placeholder={editing.kind === "folder" ? "folder name" : "folder/name"}
        className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
        onBlur={() => onDone(undefined)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onDone(undefined);
          else if (e.key === "Enter") onDone(e.currentTarget.value.trim().replaceAll(/^\/+|\/+$/g, ""));
        }}
      />
    </label>
  );
}

function RowButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      data-agent={`docs:${title.toLowerCase().replaceAll(" ", "-")}`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
      className="rounded p-0.5 text-muted-foreground hover:bg-black/[0.06] hover:text-foreground"
    >
      {children}
    </button>
  );
}

function ConfirmDelete({ path, onAnswer }: { path: string; onAnswer: (isSure: boolean) => void }) {
  return (
    <div className="flex h-7 items-center gap-2 rounded-md bg-destructive/10 px-2 text-[13px]">
      <span className="min-w-0 flex-1 truncate">Delete {nameOf(path)}?</span>
      <button type="button" data-agent="docs:confirm-delete" onClick={() => onAnswer(true)} className="font-medium text-destructive">
        Delete
      </button>
      <button type="button" onClick={() => onAnswer(false)} className="text-muted-foreground">
        Cancel
      </button>
    </div>
  );
}

type RowProps = { kind: Kind; path: string; depth: number; open?: number; isSelected?: boolean; isCollapsed?: boolean; onToggle?: () => void; act: Actions };
type Actions = { edit: (e: Editing) => void; confirm: (key: string) => void };

function rowIcon(kind: Kind, isCollapsed: boolean | undefined) {
  if (kind === "doc") return <FileText className="size-3.5 shrink-0 text-muted-foreground" />;
  if (kind === "canvas") return <Shapes className="size-3.5 shrink-0 text-muted-foreground" />;
  return isCollapsed === true ? <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />;
}

function Row({ kind, path, depth, open = 0, isSelected = false, isCollapsed, onToggle, act }: RowProps) {
  const Tag = kind === "folder" ? "div" : "a";
  const toggleOnKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") onToggle?.();
  };
  return (
    <Tag
      {...(kind === "folder" ? { role: "button", tabIndex: 0, onClick: onToggle, onKeyDown: toggleOnKey } : { href: `#docs/${encodeURI(path)}` })}
      data-agent={`docs:${kind}:${path}`}
      style={{ paddingLeft: `${String(8 + depth * 14)}px` }}
      className={cn("group flex h-7 w-full items-center gap-2 rounded-md pr-1.5 text-left text-[13px] hover:bg-black/[0.04]", isSelected && "bg-muted font-medium")}
    >
      {rowIcon(kind, isCollapsed)}
      <span className="min-w-0 flex-1 truncate">{nameOf(path)}</span>
      {open > 0 && (
        <span title={`${String(open)} open comment(s)`} className="flex items-center gap-0.5 rounded-full bg-warn-soft px-1.5 text-[11px] text-warn tabular-nums">
          <MessageSquare className="size-3" />
          {open}
        </span>
      )}
      <span className="hidden items-center gap-0.5 group-hover:flex">
        {kind === "folder" && (
          <RowButton title="New doc here" onClick={() => act.edit({ kind: "doc", mode: "new", path })}>
            <FilePlus className="size-3.5" />
          </RowButton>
        )}
        {kind === "folder" && (
          <RowButton title="New canvas here" onClick={() => act.edit({ kind: "canvas", mode: "new", path })}>
            <SquareDashedMousePointer className="size-3.5" />
          </RowButton>
        )}
        <RowButton title="Rename or move" onClick={() => act.edit({ kind, mode: "rename", path })}>
          <Pencil className="size-3.5" />
        </RowButton>
        <RowButton title="Delete" onClick={() => act.confirm(`${kind}:${path}`)}>
          <Trash2 className="size-3.5" />
        </RowButton>
      </span>
    </Tag>
  );
}

export function Tree({ vault, selected, onChanged }: Props) {
  type Level = { folder: string; depth: number };
  const [editing, setEditing] = useState<Editing | undefined>();
  const [confirming, setConfirming] = useState<string | undefined>();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | undefined>();
  const act: Actions = { edit: setEditing, confirm: setConfirming };

  const run = async (work: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await work();
      await onChanged();
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : String(error_));
    }
  };
  const finishEditing = (typed: string | undefined) => {
    setEditing(undefined);
    if (editing && hasText(typed) && typed !== startingText(editing).replace(/\/$/, "")) void run(async () => apply(editing, typed));
  };
  const remove = (key: string, isSure: boolean) => {
    setConfirming(undefined);
    if (!isSure) return;
    const [kind, ...rest] = key.split(":");
    const path = rest.join(":");
    const removeIt = kind === "folder" ? removeFolder : removeDoc;
    void run(async () => removeIt(path));
    if (selected === path || selected?.startsWith(`${path}/`) === true) location.hash = "docs";
  };
  const toggle = (folder: string) => setCollapsed((all) => new Set(all.has(folder) ? [...all].filter((f) => f !== folder) : [...all, folder]));

  const rowsAt = ({ folder, depth }: Level): React.ReactNode[] => {
    const folders = vault.folders.filter((f) => parentOf(f) === folder);
    const docs = vault.docs.filter((d) => parentOf(d.path) === folder);
    return [
      ...folders.flatMap((f) => folderRows(f, depth)),
      ...docs.map((d: DocSummary) => (confirming === `doc:${d.path}` ? <ConfirmDelete key={d.path} path={d.path} onAnswer={(isSure) => remove(`doc:${d.path}`, isSure)} /> : editingRow(d.path) ?? <Row key={d.path} kind="doc" path={d.path} depth={depth} open={d.open} isSelected={d.path === selected} act={act} />)),
      ...vault.canvases.filter((c) => parentOf(c) === folder).map((c) => (confirming === `canvas:${c}` ? <ConfirmDelete key={c} path={c} onAnswer={(isSure) => remove(`canvas:${c}`, isSure)} /> : editingRow(c) ?? <Row key={c} kind="canvas" path={c} depth={depth} isSelected={c === selected} act={act} />)),
      ...(editing?.mode === "new" && editing.path === folder ? [<NameInput key="new" editing={editing} onDone={finishEditing} />] : []),
    ];
  };
  const editingRow = (path: string) => (editing?.mode === "rename" && editing.path === path ? <NameInput key={path} editing={editing} onDone={finishEditing} /> : undefined);
  const folderRows = (f: string, depth: number): React.ReactNode[] => {
    if (confirming === `folder:${f}`) return [<ConfirmDelete key={f} path={f} onAnswer={(isSure) => remove(`folder:${f}`, isSure)} />];
    const row = editingRow(f) ?? <Row key={f} kind="folder" path={f} depth={depth} isCollapsed={collapsed.has(f)} onToggle={() => toggle(f)} act={act} />;
    return [row, ...(collapsed.has(f) ? [] : rowsAt({ folder: f, depth: depth + 1 }))];
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 px-2 pt-2">
        <RowButton title="New doc" onClick={() => setEditing({ kind: "doc", mode: "new", path: "" })}>
          <FilePlus className="size-4" />
        </RowButton>
        <RowButton title="New canvas" onClick={() => setEditing({ kind: "canvas", mode: "new", path: "" })}>
          <SquareDashedMousePointer className="size-4" />
        </RowButton>
        <RowButton title="New folder" onClick={() => setEditing({ kind: "folder", mode: "new", path: "" })}>
          <FolderPlus className="size-4" />
        </RowButton>
      </div>
      {hasText(error) && <p className="px-3 py-1 text-xs text-destructive">{error}</p>}
      <nav data-agent="docs:tree" className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto p-2">{rowsAt({ folder: "", depth: 0 })}</nav>
    </div>
  );
}
