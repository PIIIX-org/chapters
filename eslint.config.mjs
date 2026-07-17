import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['**/dist/', '**/coverage/', '**/node_modules/'] },
  ...tseslint.configs.recommended,
)
