import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { emojify, emojiReady, loadEmoji } from "@/lib/emoji";
import { mrkdwn, slackSyntax } from "@/lib/slack";
import { cn, hasText } from "@/lib/utils";
import { splitCapture } from "./rich/capture";
import { INLINE, inline, inlineStill, keepRefs, md } from "./rich/components";
import { asLinks, showUploads } from "./rich/parse";
import { remarkBreaks, remarkChips } from "./rich/remark";

export type { External } from "@/mock";
export { Author, Avatar, ExtAuthor, ExtAvatar } from "./rich/avatars";
export { splitCapture } from "./rich/capture";
export { SlackChip } from "./rich/chips";
export { parse, refsIn, uploadsIn, urlsIn, type Ref } from "./rich/parse";
export { pill, RefChip } from "./rich/RefChip";

function useEmoji(text: string) {
  emojiReady.use();
  if (text.includes(":")) void loadEmoji();
}

function oneLineSource(text: string) {
  const oneLine = splitCapture(text).body.replaceAll(/\s*\n\s*/g, " ");
  const withSlack = slackSyntax(oneLine);
  return emojify(asLinks(withSlack));
}

export function Rich({ text, className, still }: { text: string; className?: string; still?: boolean }) {
  useEmoji(text);
  return (
    <span className={className}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkChips]} components={still === true ? inlineStill : inline} allowedElements={INLINE} unwrapDisallowed urlTransform={keepRefs}>
        {oneLineSource(text)}
      </ReactMarkdown>
    </span>
  );
}

function messageSource(body: string, isSlack: boolean) {
  if (isSlack) return mrkdwn(body);
  const withUploads = showUploads(slackSyntax(body));
  return emojify(asLinks(withUploads));
}

export function Markdown({ text, className, slack }: { text: string; className?: string; slack?: boolean }) {
  const { body, caption, element } = splitCapture(text);
  useEmoji(text);
  return (
    <div className={cn("min-w-0 [overflow-wrap:anywhere]", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkChips, remarkBreaks]} components={md} urlTransform={keepRefs}>
        {messageSource(body, slack === true)}
      </ReactMarkdown>
      {hasText(caption) && (
        <p data-agent="capture-caption" title={hasText(element) ? `element ${element}` : undefined} className="mt-1 text-xs text-muted-foreground">
          <Rich text={`📷 ${caption}`} />
        </p>
      )}
    </div>
  );
}
