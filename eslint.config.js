import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Lints the TypeScript backend only; the existing JS setup scripts are covered by node:test.
export default tseslint.config(
  { ignores: ['backend/dist/**'] },
  {
    files: ['backend/**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: { project: './backend/tsconfig.json', tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // expect(mock.method) on vi.fn() mocks is not an unbound call.
    files: ['backend/test/**/*.ts'],
    rules: { '@typescript-eslint/unbound-method': 'off' },
  },
);
