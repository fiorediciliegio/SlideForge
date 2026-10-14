import { parseArgs, usage } from "./args.mjs";
import { checkPreviews, convertImages, renderPreviews, writeReport } from "./operations.mjs";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = options.command === "render"
    ? await renderPreviews(options)
    : options.command === "convert-images"
      ? await convertImages(options)
      : await checkPreviews(options);
  if (options.report) await writeReport(options.report, report);
  console.log(JSON.stringify({
    status: report.status,
    summary: report.summary,
    report: options.report ?? null,
  }, null, 2));
  if (report.status !== "passed") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  console.error(usage());
  process.exitCode = 1;
});
