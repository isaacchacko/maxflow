export type Ref = { kind: "agent" | "router" | "task" | "objective" | "thread" | "msg" | "doc"; id: string };
type Part = { text: string } | { ref: Ref } | { url: string; label: string } | { image: string };

const REF_KINDS = new Set<string>(["agent", "router", "task", "objective", "thread", "msg", "doc"]);
export const isRefKind = (kind: string | undefined): kind is Ref["kind"] => kind !== undefined && REF_KINDS.has(kind);

const TOKEN = /\[\[(agent|router|task|objective|thread|msg|doc):([^\]]+)\]\]|!\[[^\]]*\]\(\S*\/uploads\/([\w.-]+)\)|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;

function partOf(m: RegExpExecArray): Part {
  const [, kind, id = "", upload, label = "", url = ""] = m;
  if (isRefKind(kind)) return { ref: { kind, id } };
  if (upload !== undefined && upload !== "") return { image: `/api/uploads/${upload}` };
  return { url, label };
}

export function parse(text: string): Part[] {
  const parts: Part[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    parts.push(partOf(m));
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

export function refsIn(text: string) {
  return parse(text).flatMap(p => ("ref" in p ? [p.ref] : []));
}

export function urlsIn(text: string) {
  return parse(text).flatMap(p => ("url" in p ? [p] : []));
}

const BARE_UPLOAD_PATH_LINE = /^(?:file:\/\/)?(\S*\/uploads\/[\w.-]+\.(?:png|jpe?g|gif|webp))$/gim;
const FILE_URL_TO_UPLOADS = /\]\(file:\/\/(\S*\/uploads\/)/g;

export const showUploads = (text: string) => text.replaceAll(BARE_UPLOAD_PATH_LINE, "![image]($1)").replaceAll(FILE_URL_TO_UPLOADS, "]($1");

const UPLOADED_IMAGE = /!\[[^\]]*\]\(\S*\/uploads\/([\w.-]+)\)/g;

export const uploadsIn = (text: string) => Array.from(showUploads(text).matchAll(UPLOADED_IMAGE), m => `/api/uploads/${m[1]}`);

const CHIP_TOKEN = /\[\[(agent|router|task|objective|thread|msg|doc):([^\]]+)\]\]/g;

export const asLinks = (text: string) => text.replaceAll(CHIP_TOKEN, (_, kind: string, id: string) => `[ref](ref:${kind}/${encodeURIComponent(id)})`);
