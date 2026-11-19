import { useRef, useState } from "react";
import { usePersistentDraft } from "@/lib/usePersistentDraft";
import { cn } from "@/lib/utils";
import { formatForPhysicalKey, insertAtSelection, mentionAtWordStart, type Edit } from "./composer/edits";
import { AttachedImages, imagesIn, useImageUploads } from "./composer/images";
import { FormatRow, QuoteBox, RaiseToggle, Toolbar } from "./composer/parts";
import { useQuote } from "./composer/quotes";
import { useEmojiComplete } from "./Emoji";
import { useMentionPicker } from "./Mention";

export { quoteInto, quoted } from "./composer/quotes";

const FORMAT_KEY = "composer:format";

function isFormattingRemembered() {
  try {
    return localStorage.getItem(FORMAT_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberFormatting(isShown: boolean) {
  try {
    localStorage.setItem(FORMAT_KEY, isShown ? "1" : "0");
  } catch {
    // constraint: localStorage throws in a private window or on a full quota; the row still toggles for this page
  }
}

function useFormattingRow() {
  const [isFormatting, setFormatting] = useState(isFormattingRemembered);
  const toggleFormatting = () => {
    rememberFormatting(!isFormatting);
    setFormatting(!isFormatting);
  };
  return { isFormatting, toggleFormatting };
}

function editKeepingSelection(el: HTMLTextAreaElement, change: (e: Edit) => Edit, setDraft: (text: string) => void, trackCaret: () => void) {
  const next = change({ value: el.value, start: el.selectionStart, end: el.selectionEnd });
  setDraft(next.value);
  requestAnimationFrame(() => {
    el.focus();
    el.setSelectionRange(next.start, next.end);
    trackCaret();
  });
}

const imageMarkdown = (images: string[]) => images.map(path => `![image](${path})`);
const raisedText = (draft: string, quote: string, images: string[]) => [draft.trim(), quote, ...imageMarkdown(images)].filter(Boolean).join("\n\n");
const replyText = (draft: string, quote: string, images: string[]) => [quote && `${quote}\n`, draft.trim(), ...imageMarkdown(images)].filter(Boolean).join("\n");

const isSendKey = (e: React.KeyboardEvent) => e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing;

type Picker = { onKeyDown: (e: React.KeyboardEvent) => boolean; track: () => void; panel: React.ReactNode };

type MessageTextProps = {
  attachInput: (el: HTMLTextAreaElement | null) => void;
  autoFocus: boolean | undefined;
  agent: string;
  draft: string;
  setDraft: (text: string) => void;
  placeholder: string;
  mention: Picker;
  emojiComplete: Picker;
  onEdit: (change: (e: Edit) => Edit) => void;
  onFiles: (files: File[]) => void;
};

function MessageText({ attachInput, autoFocus, agent, draft, setDraft, placeholder, mention, emojiComplete, onEdit, onFiles }: MessageTextProps) {
  const trackCaret = () => {
    mention.track();
    emojiComplete.track();
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention.onKeyDown(e) || emojiComplete.onKeyDown(e)) return;
    const format = formatForPhysicalKey(e);
    if (format) {
      e.preventDefault();
      onEdit(format.apply);
      return;
    }
    if (isSendKey(e)) {
      e.preventDefault();
      e.currentTarget.form?.requestSubmit();
    } else if (draft === "" && e.key === "Escape") e.currentTarget.blur();
  };
  return (
    <div className="relative">
      <textarea
        ref={attachInput}
        rows={1}
        autoFocus={autoFocus}
        data-agent={agent}
        value={draft}
        onChange={e => {
          setDraft(e.target.value);
          trackCaret();
        }}
        onSelect={trackCaret}
        onKeyDown={onKeyDown}
        onPaste={e => {
          const files = imagesIn(e.clipboardData.files);
          if (files.length === 0) return;
          e.preventDefault();
          onFiles(files);
        }}
        placeholder={placeholder}
        className="block max-h-[40vh] w-full resize-none overflow-y-auto bg-transparent px-3 pt-2.5 pb-1 [field-sizing:content] text-sm leading-relaxed outline-none placeholder:text-muted-foreground/60"
      />
      {mention.panel}
      {emojiComplete.panel}
    </div>
  );
}

type ComposerProps = {
  onSend: (text: string) => unknown;
  onRaise?: (text: string) => unknown;
  className?: string;
  autoFocus?: boolean;
  agent: string;
  draftKey: string;
  tools?: React.ReactNode;
  toolsOn?: boolean;
  placeholder?: string;
};

function useComposerState(draftKey: string, inputRef: React.RefObject<HTMLTextAreaElement | null>) {
  const [draft, setDraft] = usePersistentDraft(draftKey);
  const uploads = useImageUploads(draftKey);
  const { quote, setQuote, attachInput } = useQuote(draftKey, inputRef);
  const [isRaising, setRaising] = useState(false);
  if (isRaising && quote === "") setRaising(false);
  const isEmpty = draft.trim() === "" && uploads.images.length === 0 && quote === "";
  const clear = () => {
    setRaising(false);
    setDraft("");
    setQuote("");
    uploads.setImages([]);
    uploads.setError("");
  };
  return { draft, setDraft, uploads, quote, setQuote, attachInput, isRaising, setRaising, isEmpty, clear };
}

export function Composer({ onSend, onRaise, className, autoFocus, agent, draftKey, tools, toolsOn, placeholder = "Message" }: ComposerProps) {
  const input = useRef<HTMLTextAreaElement>(null);
  const { draft, setDraft, uploads, quote, setQuote, attachInput, isRaising, setRaising, isEmpty, clear } = useComposerState(draftKey, input);
  const { images, uploading, error } = uploads;
  const { isFormatting, toggleFormatting } = useFormattingRow();
  const mention = useMentionPicker(input, draft, setDraft, /^thread:([\w-]+)$/.exec(draftKey)?.[1]);
  const emojiComplete = useEmojiComplete(input, draft, setDraft);
  const edit = (change: (e: Edit) => Edit) => {
    if (input.current) editKeepingSelection(input.current, change, setDraft, mention.track);
  };
  const attach = (files: File[]) => {
    void uploads.attach(files);
  };

  function send(e: React.SyntheticEvent) {
    e.preventDefault();
    if (isEmpty || uploading > 0) return;
    if (isRaising && onRaise) onRaise(raisedText(draft, quote, images));
    else onSend(replyText(draft, quote, images));
    clear();
  }

  return (
    <form
      onSubmit={send}
      onDragOver={e => e.preventDefault()}
      onDrop={e => {
        const files = imagesIn(e.dataTransfer.files);
        if (files.length === 0) return;
        e.preventDefault();
        attach(files);
      }}
      className={cn("flex flex-col gap-1", className)}
    >
      <div data-composer className="relative flex flex-col rounded-xl border border-border bg-card transition-[border-color,box-shadow] focus-within:border-foreground/35 focus-within:shadow-[0_1px_6px_rgb(0_0_0/0.08)]">
        {isFormatting && <FormatRow agent={agent} onEdit={edit} />}
        {(images.length > 0 || uploading > 0) && <AttachedImages agent={agent} images={images} uploading={uploading} onRemove={n => uploads.setImages(images.filter((_, m) => m !== n))} />}
        {quote !== "" && <QuoteBox agent={agent} quote={quote} onRemove={() => setQuote("")} />}
        {quote !== "" && onRaise && <RaiseToggle agent={agent} isRaising={isRaising} onToggle={() => setRaising(r => !r)} />}
        <MessageText attachInput={attachInput} autoFocus={autoFocus} agent={agent} draft={draft} setDraft={setDraft} placeholder={placeholder} mention={mention} emojiComplete={emojiComplete} onEdit={edit} onFiles={attach} />
        <Toolbar
          isFormatting={isFormatting}
          onToggleFormatting={toggleFormatting}
          onAttach={attach}
          onEmoji={emoji => edit(insertAtSelection(emoji))}
          onMention={() => edit(mentionAtWordStart)}
          tools={tools}
          isToolOn={toolsOn === true}
          canSend={!isEmpty && uploading === 0}
        />
      </div>
      {error !== "" && <p className="text-xs text-destructive">{error}</p>}
    </form>
  );
}
