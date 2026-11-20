import { ExternalLink } from "lucide-react";
import { defaultUrlTransform, type Components } from "react-markdown";
import { slackLink } from "@/lib/slack";
import { cn, hasText } from "@/lib/utils";
import { GitHubChip, LinearChip, PrChip, SlackChip, SlackUser, Upload } from "./chips";
import { isRefKind, type Ref } from "./parse";
import { RefChip } from "./RefChip";

const REF_LINK = /^ref:(agent|router|task|objective|thread|msg|doc)\/(.+)$/;
const APP_LINK = /^(?:https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/?)?#(agent|task|objective|thread)\/([^/?#]+)$/;
const PR_LINK = /^pr:([\w.-]+\/[\w.-]+)\/(\d+)$/;
const GITHUB_PR = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/i;
const LINEAR_LINK = /^linear:([A-Z]+-\d+)$/;
const LINEAR_ISSUE = /^https:\/\/linear\.app\/[\w-]+\/issue\/([A-Z]+-\d+)/;
const GITHUB_COMMENT = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(pull|issues)\/\d+[/#?]/i;
const UPLOAD_NAME = /\/uploads\/([\w.-]+)$/;

function refIn(match: RegExpExecArray | null): Ref | undefined {
  const kind = match?.[1];
  if (!match || !isRefKind(kind)) return;
  return { kind, id: decodeURIComponent(match[2] ?? "") };
}

function YarnChip({ href }: { href: string }) {
  const ref = refIn(REF_LINK.exec(href) ?? APP_LINK.exec(href));
  if (ref) return <RefChip r={ref} />;
  const pr = PR_LINK.exec(href) ?? GITHUB_PR.exec(href);
  if (pr) return <PrChip repo={(pr[1] ?? "").toLowerCase()} n={pr[2] ?? ""} />;
  const issue = LINEAR_LINK.exec(href) ?? LINEAR_ISSUE.exec(href);
  if (issue) return <LinearChip issue={issue[1] ?? ""} />;
  return null;
}

function SlackChannelChip({ href }: { href: string }) {
  const [channel = "", name] = href.slice(10).split("/", 2);
  return <SlackChip href={`https://dryftai.slack.com/archives/${channel}`} name={hasText(name) ? decodeURIComponent(name) : undefined} />;
}

const isYarnChip = (href: string) => [REF_LINK, APP_LINK, PR_LINK, GITHUB_PR, LINEAR_LINK, LINEAR_ISSUE].some(pattern => pattern.test(href));

function Link({ href = "", children }: { href?: string | undefined; children?: React.ReactNode }) {
  if (isYarnChip(href)) return <YarnChip href={href} />;
  if (href.startsWith("slackuser:")) return <SlackUser id={href.slice(10)}>{children}</SlackUser>;
  if (href.startsWith("slackchan:")) return <SlackChannelChip href={href} />;
  if (slackLink(href)) return <SlackChip href={href} />;
  if (GITHUB_COMMENT.test(href)) return <GitHubChip href={href} />;
  return (
    <a href={href} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="text-link [overflow-wrap:anywhere] hover:underline">
      {children}
      <ExternalLink className="ml-0.5 inline size-3 align-[-0.1em]" />
    </a>
  );
}

const uploadName = (src: unknown) => (typeof src === "string" ? UPLOAD_NAME.exec(src)?.[1] : undefined);

export const md: Components = {
  p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-1.5 list-disc pl-5">{children}</ul>,
  ol: ({ children, start }) => (
    <ol start={start} className="my-1.5 list-decimal pl-6">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="my-0.5 pl-0.5">{children}</li>,
  h1: ({ children }) => <h1 className="mt-3 mb-1.5 text-base font-semibold first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-3 mb-1.5 text-sm font-semibold first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-2.5 mb-1 text-sm font-semibold first:mt-0">{children}</h3>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  blockquote: ({ children }) => <blockquote className="my-1.5 border-l-2 pl-3 text-muted-foreground">{children}</blockquote>,
  code: ({ children, className }) => <code className={cn("rounded-md bg-muted px-1 font-mono text-[0.88em]", className)}>{children}</code>,
  pre: ({ children }) => <pre className="my-1.5 overflow-x-auto rounded-lg bg-muted p-2.5 text-xs [&>code]:bg-transparent [&>code]:p-0">{children}</pre>,
  table: ({ children }) => (
    <div className="my-2 max-w-full overflow-x-auto rounded-lg border">
      <table className="border-collapse text-[13px] leading-snug [overflow-wrap:normal] [&_tr:last-child>td]:border-b-0 [&_tr>*:first-child]:border-l-0 [&_tr>*:last-child]:border-r-0 [&_td_.rounded-full]:max-w-[20ch]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-t-0 bg-muted/60 px-3 py-1.5 text-left align-bottom font-medium text-muted-foreground">
      <div className="max-w-[26rem]">{children}</div>
    </th>
  ),
  td: ({ children }) => (
    <td className="border px-3 py-1.5 align-top">
      <div className="max-w-[26rem]">{children}</div>
    </td>
  ),
  hr: () => <hr className="my-3" />,
  a: ({ href, children }) => <Link href={href}>{children}</Link>,
  img: ({ src }) => {
    const name = uploadName(src);
    if (!hasText(name)) return null;
    return (
      <Upload name={name} className="my-1 block w-fit">
        <img src={`/api/uploads/${name}`} alt="" className="max-h-80 max-w-full border" />
      </Upload>
    );
  },
};

export const INLINE = ["p", "a", "code", "strong", "em", "del", "img"];

export const inline: Components = {
  ...md,
  p: ({ children }) => <>{children}</>,
  img: ({ src }) => {
    const name = uploadName(src);
    if (!hasText(name)) return null;
    return (
      <Upload name={name} className="text-link hover:underline">
        [image]
      </Upload>
    );
  },
};

function StillLink({ href = "", children }: { href?: string | undefined; children?: React.ReactNode }) {
  if (slackLink(href)) return <SlackChip href={href} still />;
  if (href.startsWith("slackuser:")) return <SlackUser id={href.slice(10)}>{children}</SlackUser>;
  const ref = refIn(REF_LINK.exec(href));
  if (ref) return <RefChip r={ref} still />;
  return <span className="text-link">{children}</span>;
}

export const inlineStill: Components = {
  ...inline,
  a: ({ href, children }) => <StillLink href={href}>{children}</StillLink>,
  img: () => <span className="text-link">[image]</span>,
};

const CHIP_SCHEMES = /^(ref|pr|linear|slackuser|slackchan):/;

export const keepRefs = (url: string) => (CHIP_SCHEMES.test(url) ? url : defaultUrlTransform(url));
