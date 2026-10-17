import tseslint from "typescript-eslint"
import reactHooks from "eslint-plugin-react-hooks"
import globals from "globals"

export default tseslint.config(
  {
    ignores: ["dist/**", "docs-shots/**", "playwright-report/**", "test-results/**", "node_modules/**"],
  },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
)
