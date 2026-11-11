# lezer-latex

`latex.grammar` and `tokens.mjs` are copied unmodified from Overleaf
(https://github.com/overleaf/overleaf, `services/web/frontend/js/features/source-editor/lezer-latex/`,
commit e039ad2), licensed AGPL-3.0, like this project (see the top-level LICENSE).

`npm run grammar` generates `latex.mjs` and `latex.terms.mjs` (gitignored); it runs automatically
before `dev`, `build` and `typecheck`.
