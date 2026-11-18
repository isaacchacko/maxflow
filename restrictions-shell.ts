// What a Bash command runs, for matching restrictions against: quoted strings and heredoc bodies are data (a PR body, an
// ask naming a held command), so they are blanked to ''. What the shell runs from inside them stays: a $(…) or `…` in
// double quotes, and the script handed to `sh|bash|zsh -c`, `eval` or `ssh host`, or fed as a heredoc to a shell or ssh,
// each cleaned the same way in its turn.
const RUNS_ARG = (words: string[]) => /^-[a-z]*c$/.test(words.at(-1) ?? "") || words.at(-1) === "eval" || words.includes("ssh");
const RUNS_STDIN = (words: string[]) => /^(sh|bash|zsh|ssh)$/.test(words[0]?.split("/").at(-1) ?? "");

export function shellText(command: string, depth = 0): string {
  if (depth > 4) return command;
  let out = "";
  let word = "";
  let words: string[] = [];
  const heredocs: { tag: string; keep: boolean }[] = [];
  const endWord = () => (word && words.push(word), (word = ""));
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      let inner = "";
      const subs: string[] = [];
      for (; j < command.length && command[j] !== c; j++) {
        if (c === '"' && command[j] === "\\") inner += command[j++];
        else if (c === '"' && command.startsWith("$(", j)) {
          const end = closing(command, j + 1);
          subs.push(command.slice(j + 2, end));
          inner += command.slice(j, end + 1);
          j = end;
          continue;
        } else if (c === '"' && command[j] === "`") {
          const end = command.indexOf("`", j + 1);
          subs.push(command.slice(j + 1, end < 0 ? undefined : end));
          inner += command.slice(j, end < 0 ? undefined : end + 1);
          j = end < 0 ? command.length : end;
          continue;
        }
        inner += command[j];
      }
      endWord();
      out += RUNS_ARG(words) ? ` ${shellText(inner, depth + 1)} ` : `''${subs.map((s) => ` ; ${shellText(s, depth + 1)} ;`).join("")}`;
      words.push("''");
      i = j;
      continue;
    }
    if (c === "\\" && i + 1 < command.length) {
      word += command[i + 1];
      out += c + command[++i];
      continue;
    }
    const doc = c === "<" && command.slice(i).match(/^<<-?\s*(['"]?)([\w.-]+)\1/);
    if (doc) {
      endWord();
      heredocs.push({ tag: doc[2], keep: RUNS_STDIN(words) });
      out += doc[0];
      i += doc[0].length - 1;
      continue;
    }
    if (c === "\n" && heredocs.length) {
      out += c;
      for (const h of heredocs.splice(0)) {
        const rest = command.slice(i + 1);
        const end = rest.search(new RegExp(`^\\s*${h.tag.replace(/[.-]/g, "\\$&")}\\s*$`, "m"));
        const body = end < 0 ? rest : rest.slice(0, end);
        out += h.keep ? shellText(body, depth + 1) : "\n".repeat(body.split("\n").length - 1);
        i += body.length;
      }
      words = [];
      continue;
    }
    out += c;
    if (/[\s]/.test(c)) endWord();
    else if (/[;&|()\n]/.test(c)) endWord(), (words = []);
    else word += c;
  }
  return out;
}

// The index of the ) that closes the ( at open, past nested parens and quotes.
function closing(s: string, open: number) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "'" || s[i] === '"') i = Math.max(i, s.indexOf(s[i], i + 1));
    else if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) return i;
  }
  return s.length - 1;
}
