import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import prettier from "eslint-config-prettier";
import { flatConfigs as importXConfigs } from "eslint-plugin-import-x";
import promise from "eslint-plugin-promise";
import { configs as regexpConfigs } from "eslint-plugin-regexp";
import security from "eslint-plugin-security";
import sonarjs from "eslint-plugin-sonarjs";
import unicorn from "eslint-plugin-unicorn";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    files: [
      "src/**/*.ts",
      "test/**/*.ts",
      "vitest.config.ts",
      "eslint.config.mjs",
    ],
    extends: [
      js.configs.recommended,
      unicorn.configs.unopinionated,
      sonarjs.configs.recommended,
      promise.configs["flat/recommended"],
      importXConfigs.recommended,
      regexpConfigs["flat/recommended"],
      security.configs.recommended,
    ],
    languageOptions: { globals: globals.node },
    linterOptions: {
      reportUnusedDisableDirectives: "error",
      reportUnusedInlineConfigs: "error",
    },
    rules: {
      curly: ["error", "all"],
      eqeqeq: ["error", "always"],
      "no-console": "error",
      "no-implicit-coercion": "error",
    },
  },
  {
    files: ["src/**/*.ts", "test/**/*.ts", "vitest.config.ts"],
    extends: [
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
      importXConfigs.typescript,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-exports": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/explicit-function-return-type": [
        "error",
        { allowExpressions: true },
      ],
      "@typescript-eslint/strict-boolean-expressions": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "import-x/no-cycle": "error",
    },
  },
  {
    files: [
      "src/index.ts",
      "src/change-evidence.ts",
      "src/reviewers.ts",
      "test/change-evidence.test.ts",
      "test/reviewers.test.ts",
      "test/extension.test.ts",
    ],
    rules: { "security/detect-non-literal-fs-filename": "off" },
  },
  prettier,
);
