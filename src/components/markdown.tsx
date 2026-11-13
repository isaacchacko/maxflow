import { Fragment, type ReactNode } from "react";
import { cn } from "@/lib/utils";

// The markdown agents write in questions and answers: tables, lists, headings and paragraphs, with `code`, **bold** and [links](url)
// inline. Anything else stays as the text it was.
export function Markdown({ text, className }: { text: string; className?: string }) {
  return <div className={cn("flex flex-col gap-2 break-words", className)}>{blocks(text.replace(/\r/g, "").split("\n"))}</div>;
}

const cells = (row: string) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const isTableSeparator = (line?: string) => !!line && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);
const isBullet = (line: string) => /^\s*[-*]\s+/.test(line);
const isNumbered = (line: string) => /^\s*\d+[.)]\s+/.test(line);

function blocks(lines: string[]) {
  const out: ReactNode[] = [];
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
    } else if (line.includes("|") && isTableSeparator(lines[i + 1])) {
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i].includes("|") && lines[i].trim(); i++) rows.push(cells(lines[i]));
      out.push(
        <div key={i} className="overflow-x-auto rounded-md border">
          <table className="w-full border-collapse text-left text-[12px]">
            <thead className="bg-muted/50">
              <tr>{head.map((c, j) => <th key={j} className="border-b px-2 py-1.5 font-medium">{inline(c)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, k) => (
                <tr key={k} className="border-b last:border-b-0 align-top">{head.map((_, j) => <td key={j} className="px-2 py-1.5">{inline(r[j] ?? "")}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
    } else if (isBullet(line) || isNumbered(line)) {
      const numbered = isNumbered(line);
      const items: string[] = [];
      for (; i < lines.length && (numbered ? isNumbered(lines[i]) : isBullet(lines[i])); i++) items.push(lines[i].replace(/^\s*([-*]|\d+[.)])\s+/, ""));
      const List = numbered ? "ol" : "ul";
      out.push(<List key={i} className={cn("flex flex-col gap-0.5 pl-5", numbered ? "list-decimal" : "list-disc")}>{items.map((t, k) => <li key={k}>{inline(t)}</li>)}</List>);
    } else if (/^#{1,6}\s/.test(line)) {
      out.push(<p key={i} className="font-semibold">{inline(line.replace(/^#+\s*/, ""))}</p>);
      i++;
    } else {
      const para: string[] = [];
      for (; i < lines.length && lines[i].trim() && !isBullet(lines[i]) && !isNumbered(lines[i]) && !(lines[i].includes("|") && isTableSeparator(lines[i + 1])); i++) para.push(lines[i]);
      out.push(<p key={i} className="whitespace-pre-wrap">{para.map((p, k) => <Fragment key={k}>{k > 0 && "\n"}{inline(p)}</Fragment>)}</p>);
    }
  }
  return out;
}

// `code`, **bold** and [text](url) within one line.
export function inline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\))/g).map((part, i) => {
    if (/^`[^`]+`$/.test(part)) return <code key={i} className="rounded bg-muted px-1 font-mono text-[0.92em]">{part.slice(1, -1)}</code>;
    if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={i} className="font-semibold">{part.slice(2, -2)}</strong>;
    const link = part.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
    if (link) return <a key={i} href={link[2]} target="_blank" rel="noreferrer" className="text-primary underline-offset-2 hover:underline">{link[1]}</a>;
    return part;
  });
}
