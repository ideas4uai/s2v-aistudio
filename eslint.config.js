import js from '@eslint/js';
import typescript from '@typescript-eslint/eslint-plugin';
import typescriptParser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import firebaseRulesPlugin from '@firebase/eslint-plugin-security-rules';

export default [
  {
    // .venv-clone is the Python environment for voice cloning. It ships vendored JS
    // (urllib3's emscripten worker and friends) that is not ours to lint — without
    // this it contributes ~12,700 no-undef errors and buries every real one.
    ignores: ['dist/**', 'node_modules/**', 'test_*.js', 'check_env.js', 'cache/**', 'temp/**', 'outputs/**', 'uploads/**', '.venv-clone/**', 'voices/**'],
  },
  js.configs.recommended,
  firebaseRulesPlugin.configs['flat/recommended'],
  {
    // Node dev tooling that isn't TypeScript.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  {
    // The kill-switch service worker runs in a ServiceWorkerGlobalScope, so `self`,
    // `caches` and friends are legitimately defined — declare the scope rather than
    // switching off no-undef for it.
    files: ['public/sw.js'],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'script',
      globals: { ...globals.serviceworker },
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: typescriptParser,
      ecmaVersion: 2020,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2020,
      },
    },
    plugins: {
      '@typescript-eslint': typescript,
      'react-hooks': reactHooks,
    },
    rules: {
      ...typescript.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-undef': 'off', // TypeScript handles this better
      'no-empty': 'off',
    },
  },
];
