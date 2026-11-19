type MdNode = { type: string; value?: string; children?: MdNode[]; data?: { hProperties?: Record<string, string> } };
type Callout = { kind: string; who: string };

const MARKER = /^\[!(comment|reply)\][+-]?[ \t]*([^\n]*)\n?/i;
const ISAAC = "isaac";

const signed = (name: string | undefined) => (name === undefined || name.trim() === "" ? ISAAC : name.trim());

function leadingText(quote: MdNode) {
  const paragraph = quote.children?.[0];
  if (paragraph?.type !== "paragraph") return;
  const first = paragraph.children?.[0];
  return first?.type === "text" ? { paragraph, first } : undefined;
}

function calloutOf(quote: MdNode): Callout | undefined {
  const lead = leadingText(quote);
  const m = MARKER.exec(lead?.first.value ?? "");
  if (!lead || !m) return undefined;
  lead.first.value = (lead.first.value ?? "").slice(m[0].length);
  if (lead.paragraph.children?.length === 1 && lead.first.value === "") quote.children?.shift();
  return { kind: (m[1] ?? "").toLowerCase(), who: signed(m[2]) };
}

function markReplies(quote: MdNode) {
  let lastWho: string | undefined;
  const replies = (quote.children ?? []).filter((c) => c.type === "blockquote");
  for (const reply of replies) {
    const r = calloutOf(reply);
    if (!r) continue;
    reply.data = { hProperties: { dataCallout: r.kind, dataWho: r.who } };
    lastWho = r.who;
  }
  return lastWho;
}

function commentData(quote: MdNode) {
  const callout = calloutOf(quote);
  if (!callout) return;
  const lastWho = markReplies(quote) ?? callout.who;
  return { hProperties: { dataCallout: callout.kind, dataWho: callout.who, dataOpen: String(lastWho.toLowerCase() === ISAAC) } };
}

function markAll(node: MdNode) {
  const children = node.children ?? [];
  for (const child of children) {
    if (child.type !== "blockquote") {
      markAll(child);
      continue;
    }
    const data = commentData(child);
    if (data) child.data = data;
  }
}

export const remarkCallouts = () => markAll;

const FRONTMATTER = /^---\n[\s\S]*?\n---\n?/;
const WIKILINK = /\[\[(?!(?:agent|router|task|objective|thread|msg|doc):)([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;

export const docSource = (text: string) => text.replace(FRONTMATTER, "").replaceAll(WIKILINK, (_, name: string) => `[[doc:${name.trim()}]]`);
