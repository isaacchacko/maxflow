import { AST_TOKEN_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../rule";

const CONSTRAINT = /^ constraint: \S/;
const MAX_CONSTRAINT = 160;
const DIRECTIVE = /^\s*(eslint-disable|eslint-enable|eslint-disable-line|eslint-disable-next-line|@ts-expect-error)\b/;
const TRIPLE_SLASH = /^\/\s*<reference /;

const isDirective = (c: TSESTree.Comment) => DIRECTIVE.test(c.value) || (c.type === AST_TOKEN_TYPES.Line && TRIPLE_SLASH.test(c.value));

const isShebang = (c: TSESTree.Comment) => (c.type as string) === "Shebang";

export default createRule({
  name: "no-comments",
  meta: {
    type: "suggestion",
    docs: { description: "Ban comments: the code says what it does, and only an outside constraint gets one line" },
    messages: {
      comment:
        "Comments rot, and agents copy them as patterns, so yarn bans them. Put this in the code instead: rename the variable or function so its name carries it, extract the block into a function named for what it does, or pin it in a type or a test. Only a fact the code can't show (an outside API's quirk, a platform limit, a bug link) stays, as one line: `// constraint: <the fact>`.",
      long: "A constraint comment is one line of at most 160 characters: the fact and a link, not the story. Move the rest into names, or into the commit message.",
      stacked:
        "One constraint, one line. Stacked comment lines are a paragraph: keep the single fact the code can't show, and put the rest in names or the commit message.",
    },
    schema: [],
    defaultOptions: [],
  },
  create(context) {
    return {
      Program() {
        let previous: TSESTree.Comment | undefined;
        for (const c of context.sourceCode.getAllComments()) {
          if (isDirective(c) || isShebang(c)) {
            previous = undefined;
            continue;
          }
          if (c.type !== AST_TOKEN_TYPES.Line || !CONSTRAINT.test(c.value)) context.report({ loc: c.loc, messageId: "comment" });
          else if (c.value.length > MAX_CONSTRAINT) context.report({ loc: c.loc, messageId: "long" });
          else if (previous?.loc.end.line === c.loc.start.line - 1) context.report({ loc: c.loc, messageId: "stacked" });
          previous = c;
        }
      },
    };
  },
});
