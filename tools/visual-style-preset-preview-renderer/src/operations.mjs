import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { launchBrowser, inspectHtmlInChromium } from "./browser.mjs";
import {
  assertDirectory,
  assertDisjointDirectories,
  assertFile,
  copyDirectory,
  exists,
  renameWithRetry,
  resolveInside,
  writeJson,
} from "./files.mjs";
import { assertSelfContainedHtml } from "./html-resources.mjs";
import { convertImageToWebp, validateWebp } from "./image.mjs";
import {
  loadPresets,
  outputPreset,
  outputPreviewPath,
  previewReferencePairs,
  sourceHtmlPath,
} from "./presets.mjs";

function createReport(command, roots) {
  return {
    command,
    startedAt: new Date().toISOString(),
    roots,
    templates: [],
    failures: [],
    warnings: [],
    publication: { status: "not_started", templates: [] },
    summary: { templates: 0, pages: 0, passedPages: 0, failedPages: 0, warnings: 0 },
  };
}

function failure(report, context, error) {
  const message = error instanceof Error ? error.message : String(error);
  report.failures.push({ ...context, message });
  report.summary.failedPages += 1;
}

function warning(report, context, message) {
  report.warnings.push({ ...context, message });
  report.summary.warnings += 1;
}

function finishReport(report) {
  report.finishedAt = new Date().toISOString();
  report.status = report.failures.length === 0 ? "passed" : "failed";
  return report;
}

async function inspectTemplatePage(browser, presetDirectory, reference, label, options) {
  const htmlPath = sourceHtmlPath(presetDirectory, reference, label);
  await assertFile(htmlPath, label);
  await assertSelfContainedHtml(htmlPath);
  const browserResult = browser
    ? await inspectHtmlInChromium(browser, htmlPath, options)
    : null;
  return { htmlPath, browserResult };
}

async function createStagingRoot(outputRoot) {
  return mkdtemp(join(dirname(outputRoot), ".anna-deck-preview-staging-"));
}

async function discardDirectory(path) {
  await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
}

async function stagePresetSkeleton(sourcePreset, stagingRoot) {
  const destinationDirectory = join(stagingRoot, sourcePreset.directoryName);
  await mkdir(destinationDirectory, { recursive: true });
  const sourceHtmlDirectory = join(sourcePreset.presetDirectory, "html");
  await assertDirectory(sourceHtmlDirectory, `${sourcePreset.presetPath}: html directory`);
  await copyDirectory(sourceHtmlDirectory, join(destinationDirectory, "html"));
  await mkdir(join(destinationDirectory, "images"), { recursive: true });
  return destinationDirectory;
}

function outputTemplateResult(report, presetId) {
  const result = report.templates.find((template) => template.id === presetId);
  if (!result) throw new Error(`Missing report entry for ${presetId}.`);
  return result;
}

async function imageFiles(directory) {
  await assertDirectory(directory, "Preset images directory");
  const files = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  await walk(directory);
  return files;
}

async function assertCleanImagesDirectory(presetDirectory, pairs) {
  const imagesDirectory = join(presetDirectory, "images");
  const referenced = new Set();
  for (const pair of pairs) {
    const previewPath = resolveInside(presetDirectory, pair.preview.path, "Preview image path");
    const pathWithinImages = relative(imagesDirectory, previewPath);
    if (
      pathWithinImages.startsWith("..")
      || pathWithinImages === ""
      || extname(previewPath).toLowerCase() !== ".webp"
    ) {
      throw new Error(`${presetDirectory}: preview image ${pair.preview.path} must be a .webp file inside images/.`);
    }
    referenced.add(resolve(previewPath));
  }

  for (const file of await imageFiles(imagesDirectory)) {
    const extension = extname(file).toLowerCase();
    if ([".png", ".jpg", ".jpeg"].includes(extension)) {
      throw new Error(`${presetDirectory}: images/ must not contain legacy preview image ${relative(presetDirectory, file)}.`);
    }
    if (extension !== ".webp" || !referenced.has(resolve(file))) {
      throw new Error(
        `${presetDirectory}: images/ must contain only referenced WebP files; found ${relative(presetDirectory, file)}.`,
      );
    }
  }
}

async function validateStaging(browser, stagingRoot, report, timeoutMs) {
  for (const stagedPreset of await loadPresets(stagingRoot)) {
    const templateResult = outputTemplateResult(report, stagedPreset.preset.id);
    try {
      const pairs = previewReferencePairs(stagedPreset.preset, stagedPreset.presetPath);
      await assertCleanImagesDirectory(stagedPreset.presetDirectory, pairs);
      for (const pair of pairs) {
        const previewPath = resolveInside(
          stagedPreset.presetDirectory,
          pair.preview.path,
          `${stagedPreset.presetPath}: preview_images[${pair.index}]`,
        );
        await assertFile(previewPath, `Preview image ${pair.preview.path}`);
        await validateWebp(previewPath);
        await inspectTemplatePage(
          browser,
          stagedPreset.presetDirectory,
          pair.reference,
          `${stagedPreset.presetPath}: reference_html_pages[${pair.index}]`,
          { timeoutMs },
        );
      }
    } catch (error) {
      templateResult.status = "failed";
      failure(report, { phase: "staging-validation", presetId: stagedPreset.preset.id }, error);
    }
  }
}

async function countLegacyImages(presetDirectory) {
  const imagesDirectory = join(presetDirectory, "images");
  if (!await exists(imagesDirectory)) return 0;
  const files = await imageFiles(imagesDirectory);
  return files.filter((file) => [".png", ".jpg", ".jpeg"].includes(extname(file).toLowerCase())).length;
}

async function publishStaging(stagingRoot, outputRoot, sourcePresets, report) {
  const backupRoot = await mkdtemp(join(dirname(outputRoot), ".anna-deck-preview-backup-"));
  const published = [];
  try {
    for (const sourcePreset of sourcePresets) {
      const presetId = sourcePreset.directoryName;
      const stagedDirectory = join(stagingRoot, presetId);
      const targetDirectory = join(outputRoot, presetId);
      const backupDirectory = join(backupRoot, presetId);
      const targetExisted = await exists(targetDirectory);
      const removedLegacyImages = targetExisted ? await countLegacyImages(targetDirectory) : 0;
      const previews = outputPreset(sourcePreset.preset, sourcePreset.presetPath).preview_images
        .map((preview) => preview.path);
      if (targetExisted) await renameWithRetry(targetDirectory, backupDirectory);
      try {
        await renameWithRetry(stagedDirectory, targetDirectory);
      } catch (error) {
        if (targetExisted) await renameWithRetry(backupDirectory, targetDirectory);
        throw error;
      }
      published.push({
        presetId,
        stagedDirectory,
        targetDirectory,
        backupDirectory,
        targetExisted,
      });
      report.publication.templates.push({
        presetId,
        targetDirectory,
        replacedExistingPreset: targetExisted,
        removedLegacyImages,
        generatedWebp: previews,
      });
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const entry of published.reverse()) {
      try {
        if (await exists(entry.targetDirectory)) {
          await renameWithRetry(entry.targetDirectory, entry.stagedDirectory);
        }
        if (entry.targetExisted) await renameWithRetry(entry.backupDirectory, entry.targetDirectory);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
      }
    }
    report.publication.status = "rolled_back";
    await discardDirectory(backupRoot);
    const original = error instanceof Error ? error.message : String(error);
    const suffix = rollbackErrors.length > 0 ? ` Rollback errors: ${rollbackErrors.join(" | ")}` : "";
    throw new Error(`Publishing staged presets failed: ${original}.${suffix}`);
  }

  report.publication.status = "published";
  try {
    await rm(backupRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (error) {
    warning(
      report,
      { code: "PUBLISH_BACKUP_CLEANUP_FAILED", backupRoot },
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function prepareRoots(sourceRoot, outputRoot) {
  const roots = await assertDisjointDirectories(sourceRoot, outputRoot);
  return { resolvedSourceRoot: roots.sourceRoot, resolvedOutputRoot: roots.outputRoot };
}

async function buildRenderPreset(browser, sourcePreset, stagingRoot, report, quality, timeoutMs) {
  const templateResult = { id: sourcePreset.preset.id, pages: [], status: "passed" };
  report.templates.push(templateResult);
  report.summary.templates += 1;
  let destinationDirectory;
  try {
    destinationDirectory = await stagePresetSkeleton(sourcePreset, stagingRoot);
  } catch (error) {
    templateResult.status = "failed";
    failure(report, { phase: "staging", presetId: sourcePreset.preset.id }, error);
    return;
  }

  let presetSucceeded = true;
  for (const pair of previewReferencePairs(sourcePreset.preset, sourcePreset.presetPath)) {
    report.summary.pages += 1;
    const pageResult = {
      index: pair.index,
      html: pair.reference.path,
      preview: pair.preview.path,
      status: "passed",
    };
    templateResult.pages.push(pageResult);
    try {
      const outputPath = outputPreviewPath(stagingRoot, sourcePreset.preset.id, pair.preview.path);
      await mkdir(dirname(outputPath), { recursive: true });
      const { htmlPath } = await inspectTemplatePage(
        browser,
        sourcePreset.presetDirectory,
        pair.reference,
        `${sourcePreset.presetPath}: reference_html_pages[${pair.index}]`,
        { timeoutMs, screenshotPath: outputPath, quality },
      );
      pageResult.htmlPath = htmlPath;
      pageResult.outputPath = outputPath;
      pageResult.image = await validateWebp(outputPath);
      report.summary.passedPages += 1;
    } catch (error) {
      presetSucceeded = false;
      pageResult.status = "failed";
      pageResult.message = error instanceof Error ? error.message : String(error);
      failure(
        report,
        {
          phase: "generation",
          presetId: sourcePreset.preset.id,
          pageIndex: pair.index,
          html: pair.reference.path,
        },
        error,
      );
    }
  }
  if (presetSucceeded) {
    const destination = join(destinationDirectory, "preset.json");
    await writeJson(destination, outputPreset(sourcePreset.preset, sourcePreset.presetPath));
    templateResult.outputPresetPath = destination;
  } else {
    templateResult.status = "failed";
  }
}

async function buildConvertedPreset(sourcePreset, stagingRoot, report, quality) {
  const templateResult = { id: sourcePreset.preset.id, pages: [], status: "passed" };
  report.templates.push(templateResult);
  report.summary.templates += 1;
  let pairs;
  let destinationDirectory;
  try {
    pairs = previewReferencePairs(sourcePreset.preset, sourcePreset.presetPath);
    destinationDirectory = await stagePresetSkeleton(sourcePreset, stagingRoot);
  } catch (error) {
    templateResult.status = "failed";
    failure(report, { phase: "staging", presetId: sourcePreset.preset.id }, error);
    return;
  }

  let presetSucceeded = true;
  for (const pair of pairs) {
    report.summary.pages += 1;
    const pageResult = { index: pair.index, preview: pair.preview.path, status: "passed" };
    templateResult.pages.push(pageResult);
    try {
      const sourcePath = resolveInside(
        sourcePreset.presetDirectory,
        pair.preview.path,
        `${sourcePreset.presetPath}: preview_images[${pair.index}]`,
      );
      await assertFile(sourcePath, `Preview image ${pair.preview.path}`);
      const extension = extname(pair.preview.path).toLowerCase();
      if (![".png", ".jpg", ".jpeg", ".webp"].includes(extension)) {
        throw new Error(
          `${sourcePreset.presetPath}: preview_images[${pair.index}] must use PNG, JPG, JPEG, or WebP.`,
        );
      }
      const outputPath = outputPreviewPath(stagingRoot, sourcePreset.preset.id, pair.preview.path);
      pageResult.image = await convertImageToWebp(sourcePath, outputPath, quality);
      pageResult.sourcePath = sourcePath;
      pageResult.outputPath = outputPath;
      report.summary.passedPages += 1;
    } catch (error) {
      presetSucceeded = false;
      pageResult.status = "failed";
      pageResult.message = error instanceof Error ? error.message : String(error);
      failure(
        report,
        {
          phase: "generation",
          presetId: sourcePreset.preset.id,
          pageIndex: pair.index,
          preview: pair.preview.path,
        },
        error,
      );
    }
  }
  if (presetSucceeded) {
    const destination = join(destinationDirectory, "preset.json");
    await writeJson(destination, outputPreset(sourcePreset.preset, sourcePreset.presetPath));
    templateResult.outputPresetPath = destination;
  } else {
    templateResult.status = "failed";
  }
}

async function buildAndPublish({
  command,
  sourceRoot,
  outputRoot,
  browserExecutable,
  quality,
  timeoutMs,
  buildPreset,
  inspectInBrowser,
}) {
  const { resolvedSourceRoot, resolvedOutputRoot } = await prepareRoots(sourceRoot, outputRoot);
  const report = createReport(command, {
    sourceRoot: resolvedSourceRoot,
    outputRoot: resolvedOutputRoot,
  });
  const sourcePresets = await loadPresets(resolvedSourceRoot);
  const stagingRoot = await createStagingRoot(resolvedOutputRoot);
  let browser;
  try {
    if (inspectInBrowser) browser = await launchBrowser(browserExecutable);
    for (const sourcePreset of sourcePresets) {
      await buildPreset(sourcePreset, stagingRoot, report, quality, timeoutMs, browser);
    }
    if (report.failures.length === 0) {
      await validateStaging(browser, stagingRoot, report, timeoutMs);
    }
    if (report.failures.length === 0) {
      await publishStaging(stagingRoot, resolvedOutputRoot, sourcePresets, report);
    } else {
      report.publication.status = "not_published";
    }
  } catch (error) {
    report.publication.status = "not_published";
    failure(report, { phase: "command" }, error);
  } finally {
    if (browser) await browser.close();
    await discardDirectory(stagingRoot);
  }
  return finishReport(report);
}

export async function renderPreviews(options) {
  return buildAndPublish({
    ...options,
    command: "render",
    inspectInBrowser: true,
    buildPreset: async (sourcePreset, stagingRoot, report, quality, timeoutMs, browser) =>
      buildRenderPreset(browser, sourcePreset, stagingRoot, report, quality, timeoutMs),
  });
}

export async function convertImages(options) {
  return buildAndPublish({
    ...options,
    command: "convert-images",
    inspectInBrowser: false,
    buildPreset: async (sourcePreset, stagingRoot, report, quality) =>
      buildConvertedPreset(sourcePreset, stagingRoot, report, quality),
  });
}

export async function checkPreviews({ presetsRoot, browserExecutable, timeoutMs }) {
  const resolvedPresetsRoot = resolve(presetsRoot);
  await assertDirectory(resolvedPresetsRoot, "--presets-root");
  const report = createReport("check", { presetsRoot: resolvedPresetsRoot });
  const browser = await launchBrowser(browserExecutable);
  try {
    for (const sourcePreset of await loadPresets(resolvedPresetsRoot)) {
      const templateResult = { id: sourcePreset.preset.id, pages: [], status: "passed" };
      report.templates.push(templateResult);
      report.summary.templates += 1;
      try {
        const pairs = previewReferencePairs(sourcePreset.preset, sourcePreset.presetPath);
        await assertCleanImagesDirectory(sourcePreset.presetDirectory, pairs);
        for (const pair of pairs) {
          report.summary.pages += 1;
          const pageResult = {
            index: pair.index,
            html: pair.reference.path,
            preview: pair.preview.path,
            status: "passed",
          };
          templateResult.pages.push(pageResult);
          const previewPath = resolveInside(
            sourcePreset.presetDirectory,
            pair.preview.path,
            `${sourcePreset.presetPath}: preview_images[${pair.index}]`,
          );
          await assertFile(previewPath, `Preview image ${pair.preview.path}`);
          pageResult.image = await validateWebp(previewPath);
          const { htmlPath } = await inspectTemplatePage(
            browser,
            sourcePreset.presetDirectory,
            pair.reference,
            `${sourcePreset.presetPath}: reference_html_pages[${pair.index}]`,
            { timeoutMs },
          );
          pageResult.htmlPath = htmlPath;
          report.summary.passedPages += 1;
        }
      } catch (error) {
        templateResult.status = "failed";
        failure(report, { phase: "check", presetId: sourcePreset.preset.id }, error);
      }
    }
  } finally {
    await browser.close();
  }
  return finishReport(report);
}

export async function writeReport(reportPath, report) {
  await writeJson(resolve(reportPath), report);
}
