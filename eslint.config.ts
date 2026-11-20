import js from "@eslint/js";
import comments from "@eslint-community/eslint-plugin-eslint-comments/configs";
import reactHooks from "eslint-plugin-react-hooks";
import unicorn from "eslint-plugin-unicorn";
import tseslint from "typescript-eslint";
import { yarn } from "./lint/plugin";

const EFFECT_ADVICE =
  "derive it in render, do it in the event handler, read a store with useSyncExternalStore, reset with a key, use a ref callback for the DOM node, or use a hook from src/lib/effects.ts.";
const EFFECTS = ["useEffect", "useLayoutEffect", "useInsertionEffect"];
const CHILD_PROCESS_MESSAGE = "Use Bun.spawn with an argv array: no shell string to quote, and no sync variant to block the event loop.";
const CHILD_PROCESS = [
  { name: "child_process", message: CHILD_PROCESS_MESSAGE },
  { name: "node:child_process", message: CHILD_PROCESS_MESSAGE },
];

// eslint-disable-next-line @typescript-eslint/no-deprecated -- ESLint's defineConfig rejects typescript-eslint RuleModule types, which the yarn plugin's rules are; tseslint.config takes them
export default tseslint.config(
  { ignores: ["node_modules/**", "src/components/ui/**", "**/*.d.ts"] },
  { linterOptions: { reportUnusedDisableDirectives: "error", reportUnusedInlineConfigs: "error" } },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  unicorn.configs.recommended,
  comments.recommended,
  {
    languageOptions: { parserOptions: { projectService: { allowDefaultProject: ["src/pwa/sw.js"] }, tsconfigRootDir: import.meta.dirname } },
    plugins: { yarn },
    rules: {
      "yarn/no-comments": "error",
      "yarn/import-boundaries": "error",
      "yarn/state-dir-in-state": "error",
      "yarn/state-writes-in-state": "error",
      "yarn/no-kill-by-pattern": "error",
      "yarn/fetch-needs-timeout": "error",
      "yarn/no-sync-spawn-in-server": "error",

      "@eslint-community/eslint-comments/require-description": ["error", { ignore: ["eslint-enable"] }],
      "@eslint-community/eslint-comments/no-unlimited-disable": "error",
      "@eslint-community/eslint-comments/no-restricted-disable": ["error", "yarn/*", "@typescript-eslint/no-explicit-any", "@typescript-eslint/no-floating-promises"],

      "@typescript-eslint/switch-exhaustiveness-check": ["error", { requireDefaultForNonUnion: true, considerDefaultExhaustiveForUnions: false }],
      "@typescript-eslint/strict-boolean-expressions": ["error", { allowNumber: false }],
      "@typescript-eslint/no-confusing-void-expression": ["error", { ignoreArrowShorthand: true }],
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
      "@typescript-eslint/no-floating-promises": ["error", { checkThenables: true }],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/consistent-type-exports": "error",
      "@typescript-eslint/prefer-readonly": "error",
      "@typescript-eslint/promise-function-async": "error",
      "@typescript-eslint/require-array-sort-compare": "error",
      "@typescript-eslint/no-shadow": "error",
      "@typescript-eslint/no-unnecessary-qualifier": "error",
      "@typescript-eslint/no-useless-empty-export": "error",
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/no-loop-func": "error",
      "@typescript-eslint/default-param-last": "error",
      "@typescript-eslint/method-signature-style": "error",
      "@typescript-eslint/no-unused-vars": ["error", { args: "all", argsIgnorePattern: "^_", caughtErrors: "all", ignoreRestSiblings: true }],
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],

      complexity: ["error", 12],
      "max-depth": ["error", 3],
      "max-params": ["error", 4],
      "max-nested-callbacks": ["error", 3],
      "max-lines": ["error", { max: 400, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["error", { max: 80, skipBlankLines: true, skipComments: true, IIFEs: true }],
      "max-statements": ["error", 25],
      "no-nested-ternary": "error",
      "no-param-reassign": ["error", { props: true, ignorePropertyModificationsFor: ["ref", "el", "element", "node"], ignorePropertyModificationsForRegex: ["Ref$"] }],
      "no-implicit-coercion": "error",
      "no-else-return": ["error", { allowElseIf: false }],
      "no-lonely-if": "error",
      "no-useless-return": "error",
      "no-useless-concat": "error",
      "no-plusplus": ["error", { allowForLoopAfterthoughts: true }],
      "no-void": ["error", { allowAsStatement: true }],
      "no-console": ["error", { allow: ["log", "error", "warn"] }],
      "prefer-template": "error",
      "object-shorthand": "error",
      eqeqeq: "error",
      "no-restricted-imports": [
        "error",
        {
          paths: [
            ...CHILD_PROCESS,
            { name: "react", importNames: EFFECTS, message: `Effects live only in src/lib/effects.ts: ${EFFECT_ADVICE}` },
          ],
        },
      ],
      "no-restricted-properties": [
        "error",
        ...EFFECTS.map((property) => ({ object: "React", property, message: `Effects live only in src/lib/effects.ts: ${EFFECT_ADVICE}` })),
      ],
      "no-restricted-syntax": [
        "error",
        { selector: "ExportDefaultDeclaration", message: "Export by name, so every importer uses the same name and renames are found by search." },
        { selector: "TSEnumDeclaration", message: "Use a union of string literals: `type Mode = \"a\" | \"b\"`. Enums emit runtime code and don't narrow as well." },
        { selector: "ForInStatement", message: "Iterate Object.keys/entries with for...of: for...in walks the prototype chain too." },
        { selector: "LabeledStatement", message: "Extract the loop into a function and return from it instead of breaking to a label." },
        { selector: "SequenceExpression", message: "Write each step as its own statement; a comma expression hides the one that matters." },
      ],

      "unicorn/prevent-abbreviations": "off",
      "unicorn/name-replacements": "off",
      "unicorn/import-style": "off",
      "unicorn/single-line-block-comment-style": "off",
      "unicorn/no-asterisk-prefix-in-documentation-comments": "off",
      "unicorn/prefer-regexp-exec": "off",
      "unicorn/no-null": "off",
      "unicorn/no-process-exit": "off",
      "unicorn/no-array-reduce": "off",
      "unicorn/no-array-callback-reference": "off",
      "unicorn/no-await-expression-member": "off",
      "unicorn/numeric-separators-style": ["error", { onlyIfContainsSeparator: true }],
      "unicorn/prefer-ternary": "off",
      "unicorn/prefer-simple-condition-first": "off",
      "unicorn/filename-case": ["error", { cases: { kebabCase: true, pascalCase: true, camelCase: true } }],
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: Object.fromEntries(Object.keys(reactHooks.configs.recommended.rules).map((rule) => [rule, "error"])),
  },
  {
    files: ["src/**/*.tsx"],
    rules: { "unicorn/no-declarations-before-early-exit": "off" },
  },
  {
    files: ["src/components/face/**/*.ts"],
    rules: { "no-param-reassign": "off" },
  },
  {
    files: ["src/lib/effects.ts"],
    rules: { "no-restricted-imports": ["error", { paths: CHILD_PROCESS }], "no-restricted-properties": "off" },
  },
  {
    files: ["eslint.config.ts", "lint/rules/*.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
  {
    files: ["test/**/*.{ts,tsx}", "fixtures/**/*.ts"],
    rules: { "max-lines-per-function": "off", "max-nested-callbacks": "off", "max-statements": "off" },
  },
);
