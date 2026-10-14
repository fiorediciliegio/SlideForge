# Outline Eval

This evaluation runs only the Outline stage against pre-confirmed Requirements fixtures. It skips Requirements generation, visual-style selection, research routing, Web research, image research, and deck generation.

## Build the Batch Testing input

```powershell
node evals/outline/scripts/build-outline-batch-input.mjs
```

This reads `E:\TS_work\PPT\eval\Outline测试数据.xlsx` and writes `evals/outline/config/outline-provided-requirements-batch-input.json`.

The workbook's `Requirements.source.brief` is the canonical input used by the Outline prompt. The separate `用户原始Brief` column is not substituted into the Requirements fixture.

## Run

This app uses `anna-app dev --no-watch`, so the browser runs the already-built
`apps/ppt-app/bundle` files rather than TypeScript source. Before importing the
Batch JSON, rebuild both sides and restart the dev server:

```powershell
cd apps\ppt-app\executas\ppt-engine
npm run build

cd ..\..
npm run build

$env:VITE_BATCH_TESTING_ENABLED = "true"
npm run dev
```

In **My Work → Batch Testing**, import the generated JSON and start the run. Its target stage is `outline-confirmed`; each of the 20 cases makes one Outline-generation call.

## Extract outputs

After downloading and extracting the Batch ZIP:

```powershell
node evals/outline/scripts/extract-outline-results.mjs --input <extracted-batch-directory>
```

The script writes `outline-results/outlines.json` and `outline-results/outlines.md` underneath the extracted directory.
It rejects a bundle that did not persist every `provided_requirements` fixture,
because that means the normal Requirements pipeline ran instead of the Outline-only evaluation.
