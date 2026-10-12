import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

// TypeScript only (backend, frontend, e2e); the existing JS setup/deploy scripts are covered by node:test.
const strict = {
  extends: [js.configs.recommended, ...tseslint.configs.strictTypeChecked],
  rules: {
    '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
  },
};

export default tseslint.config(
  { ignores: ['backend/dist/**', 'frontend/dist/**', 'agent/dist/**', 'test-results/**', 'playwright-report/**'] },
  {
    ...strict,
    files: ['backend/**/*.ts'],
    languageOptions: { parserOptions: { project: './backend/tsconfig.json', tsconfigRootDir: import.meta.dirname } },
  },
  {
    ...strict,
    files: ['frontend/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { parserOptions: { project: './frontend/tsconfig.json', tsconfigRootDir: import.meta.dirname } },
    rules: { ...strict.rules, ...reactHooks.configs.recommended.rules },
  },
  {
    ...strict,
    files: ['e2e/**/*.ts'],
    languageOptions: { parserOptions: { project: './e2e/tsconfig.json', tsconfigRootDir: import.meta.dirname } },
  },
  {
    ...strict,
    files: ['agent/**/*.ts'],
    languageOptions: { parserOptions: { project: './agent/tsconfig.json', tsconfigRootDir: import.meta.dirname } },
  },
  {
    // expect(mock.method) on vi.fn() mocks is not an unbound call.
    files: ['backend/test/**/*.ts', 'frontend/test/**/*.{ts,tsx}'],
    rules: { '@typescript-eslint/unbound-method': 'off' },
  },
);
