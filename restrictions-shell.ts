const MAX_NESTED_SCRIPTS = 4;
const HEREDOC_START = /^<<-?\s*(['"]?)([\w.-]+)\1/;
const SHELL_OR_SSH = /^(sh|bash|zsh|ssh)$/;
const RUNS_NEXT_ARGUMENT = /^-[a-z]*c$/;

const isScriptArgument = (words: string[]) => RUNS_NEXT_ARGUMENT.test(words.at(-1) ?? "") || words.at(-1) === "eval" || words.includes("ssh");
const isShellReadingStdin = (words: string[]) => SHELL_OR_SSH.test(words[0]?.split("/").at(-1) ?? "");
const heredocEnd = (tag: string) => new RegExp(String.raw`^\s*${tag.replaceAll(/[.-]/g, String.raw`\$&`)}\s*$`, "m");

const PAREN_DEPTH = new Map([["(", 1], [")", -1]]);

type Heredoc = { tag: string; isScript: boolean };
type QuotedPiece = { text: string; next: number; substitution?: string };

function closingParen(s: string, open: number) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === "'" || c === '"') i = Math.max(i, s.indexOf(c, i + 1));
    else if (c === ")" && depth === 1) return i;
    else depth += PAREN_DEPTH.get(c ?? "") ?? 0;
  }
  return s.length - 1;
}

function doubleQuotedPiece(command: string, at: number): QuotedPiece {
  if (command[at] === "\\") return { text: `\\${command[at + 1] ?? ""}`, next: at + 2 };
  if (command.startsWith("$(", at)) {
    const end = closingParen(command, at + 1);
    return { text: command.slice(at, end + 1), substitution: command.slice(at + 2, end), next: end + 1 };
  }
  if (command[at] === "`") {
    const end = command.indexOf("`", at + 1);
    return end === -1
      ? { text: command.slice(at), substitution: command.slice(at + 1), next: command.length + 1 }
      : { text: command.slice(at, end + 1), substitution: command.slice(at + 1, end), next: end + 1 };
  }
  return { text: command[at] ?? "", next: at + 1 };
}

function readQuoted(command: string, open: number, quote: "'" | '"') {
  let inner = "";
  const substitutions: string[] = [];
  let at = open + 1;
  while (at < command.length && command[at] !== quote) {
    const piece = quote === '"' ? doubleQuotedPiece(command, at) : { text: command[at] ?? "", next: at + 1 };
    inner += piece.text;
    if (piece.substitution !== undefined) substitutions.push(piece.substitution);
    at = piece.next;
  }
  return { inner, substitutions, close: at };
}

class ShellText {
  private out = "";
  private word = "";
  private words: string[] = [];
  private readonly heredocs: Heredoc[] = [];
  private at = 0;
  private readonly command: string;
  private readonly depth: number;

  constructor(command: string, depth: number) {
    this.command = command;
    this.depth = depth;
  }

  private step(c: string) {
    if (c === "'" || c === '"') this.quoted(c);
    else if (c === "\\" && this.at + 1 < this.command.length) this.escaped();
    else if (c === "\n" && this.heredocs.length > 0) this.heredocBodies();
    else this.unquoted(c);
  }

  private nested(script: string) {
    return shellText(script, this.depth + 1);
  }

  private endWord() {
    if (this.word !== "") this.words.push(this.word);
    this.word = "";
  }

  private quoted(quote: "'" | '"') {
    const { inner, substitutions, close } = readQuoted(this.command, this.at, quote);
    this.endWord();
    this.out += isScriptArgument(this.words) ? ` ; ${this.nested(inner)} ; ` : `''${substitutions.map((s) => ` ; ${this.nested(s)} ;`).join("")}`;
    this.words.push("''");
    this.at = close;
  }

  private escaped() {
    const next = this.command[this.at + 1] ?? "";
    this.word += next;
    this.out += `\\${next}`;
    this.at += 1;
  }

  private heredocBodies() {
    this.out += "\n";
    for (const heredoc of this.heredocs.splice(0)) {
      const rest = this.command.slice(this.at + 1);
      const end = rest.search(heredocEnd(heredoc.tag));
      const body = end === -1 ? rest : rest.slice(0, end);
      this.out += heredoc.isScript ? this.nested(body) : "\n".repeat(body.split("\n").length - 1);
      this.at += body.length;
    }
    this.words = [];
  }

  private unquoted(c: string) {
    const heredoc = c === "<" ? HEREDOC_START.exec(this.command.slice(this.at)) : null;
    if (heredoc) {
      this.endWord();
      this.heredocs.push({ tag: heredoc[2] ?? "", isScript: isShellReadingStdin(this.words) });
      this.out += heredoc[0];
      this.at += heredoc[0].length - 1;
      return;
    }
    this.out += c;
    if (/\s/.test(c)) this.endWord();
    else if (/[;&|()\n]/.test(c)) {
      this.endWord();
      this.words = [];
    } else this.word += c;
  }

  text(): string {
    while (this.at < this.command.length) {
      this.step(this.command[this.at] ?? "");
      this.at += 1;
    }
    return this.out;
  }
}

export function shellText(command: string, depth = 0): string {
  return depth > MAX_NESTED_SCRIPTS ? command : new ShellText(command, depth).text();
}

const SEPARATOR = /[;&|()`\n]/;
const ASSIGNMENT = /^\w+=/;
const KEYWORD = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "time", "exec", "command", "builtin", "nohup", "noglob"]);
const WRAPPER = new Set(["sudo", "doas", "env", "xargs", "timeout", "nice", "ionice", "stdbuf", "watch", "caffeinate", "ssh", "-exec", "-execdir", "-ok", "parallel"]);
type Position = { isAtCommand: boolean; isWrapped: boolean };
const COMMAND_START: Position = { isAtCommand: true, isWrapped: false };

const isWordChar = (c: string) => !/\s/.test(c) && !SEPARATOR.test(c);
const basename = (word: string) => word.split("/").at(-1) ?? word;

function wordEnd(text: string, start: number) {
  let end = start;
  while (end < text.length && isWordChar(text[end] ?? "")) end += 1;
  return end;
}

function startsOfWord(word: string, at: number, end: number, position: Position): number[] {
  if (position.isAtCommand && ASSIGNMENT.test(word)) return [];
  const name = basename(word);
  return name === word ? [at] : [at, end - name.length];
}

function afterWord(word: string, position: Position): Position {
  if (WRAPPER.has(basename(word))) return { ...position, isWrapped: true };
  if (!KEYWORD.has(word) && !ASSIGNMENT.test(word)) return { ...position, isAtCommand: false };
  return position;
}

export function commandStarts(text: string): number[] {
  const starts: number[] = [];
  let position = COMMAND_START;
  let at = 0;
  while (at < text.length) {
    const c = text[at] ?? "";
    if (SEPARATOR.test(c)) {
      position = COMMAND_START;
      at += 1;
    } else if (/\s/.test(c)) {
      at += 1;
    } else {
      const end = wordEnd(text, at);
      const word = text.slice(at, end);
      if (position.isAtCommand || position.isWrapped) {
        starts.push(...startsOfWord(word, at, end, position));
        position = afterWord(word, position);
      }
      at = end;
    }
  }
  return starts;
}
