import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{ ignores: ["node_modules/**", "dist/**", ".runtime/**", "logs/**"] },
	js.configs.recommended,
	{
		files: ["**/*.mjs", "eslint.config.js"],
		languageOptions: { globals: globals.node },
	},
	{
		files: ["src/**/*.ts", "*.test.ts"],
		extends: [...tseslint.configs.recommendedTypeChecked],
		languageOptions: {
			globals: { ...globals.serviceworker, ...globals.es2024 },
			parserOptions: { project: "./tsconfig.json", tsconfigRootDir: import.meta.dirname },
		},
		rules: {
			"no-console": ["error", { allow: ["error", "warn"] }],
			"@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
		},
	},
);
