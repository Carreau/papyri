import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import astroeslint from "eslint-plugin-astro";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import astroParser from "astro-eslint-parser";

export default [
  {
    ignores: ["dist", "node_modules", ".astro"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,jsx,mjs,cjs,ts,tsx}"],
    languageOptions: {
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: {
          jsx: true,
        },
      },
      globals: {
        browser: true,
        es2024: true,
        node: true,
      },
    },
    plugins: {
      react,
      "react-hooks": reactHooks,
    },
    rules: {
      "react/react-in-jsx-scope": "off",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": "warn",
    },
    settings: {
      react: {
        version: "detect",
      },
    },
  },
  {
    files: ["**/*.astro"],
    languageOptions: {
      parser: astroParser,
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: [".astro"],
      },
      globals: {
        browser: true,
        es2024: true,
        node: true,
      },
    },
    plugins: {
      astro: astroeslint,
    },
    rules: {
      ...astroeslint.configs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": "warn",
    },
  },
];
