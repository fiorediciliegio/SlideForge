import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_LOCALE,
  isLocale,
  localeIds,
  locales,
} from "../../src/i18n/locales";
import { formatMessage, messages } from "../../src/i18n/index";
import { en } from "../../src/i18n/en";
import { toPerfReportLocale } from "../../src/api/pptBackend";
import { resolveResearchTextLocale } from "../../src/ai/outputLanguage";
import {
  decodeDiagnostic,
  diagnosticCodes,
  encodeDiagnostic,
  renderDiagnostic,
  type DiagnosticCode,
} from "../../src/i18n/diagnostics";

const here = dirname(fileURLToPath(import.meta.url));

describe("locale registry", () => {
  it("exposes exactly the four v1 locales in stable-id form", () => {
    assert.deepEqual(localeIds, ["en", "zh", "ja", "de"]);
  });

  it("carries label/short/intl metadata with BCP-47 intl codes", () => {
    for (const id of localeIds) {
      const meta = locales[id];
      assert.ok(meta.label.length > 0, `${id} label`);
      assert.ok(meta.short.length > 0, `${id} short`);
      assert.match(meta.intl, /^[a-z]{2}-[A-Z]{2}$/, `${id} intl should be BCP-47`);
    }
    assert.equal(locales.zh.intl, "zh-CN");
    assert.equal(locales.ja.intl, "ja-JP");
    assert.equal(locales.de.intl, "de-DE");
  });

  it("validates stored values against the registry whitelist", () => {
    for (const id of localeIds) assert.ok(isLocale(id), `${id} accepted`);
    // 旧值/未知值/非法值一律拒绝（由调用方回退 DEFAULT_LOCALE）
    for (const bad of ["zh-CN", "EN", "", "fr", null, undefined, 42, "en "]) {
      assert.equal(isLocale(bad), false, `${String(bad)} rejected`);
    }
    assert.equal(DEFAULT_LOCALE, "en");
  });
});

describe("message bundles", () => {
  it("serves real ja/de translations for main-flow controls", () => {
    assert.equal(messages.ja.controls.save, "保存");
    assert.equal(messages.ja.controls.close, "閉じる");
    assert.equal(messages.de.controls.save, "Speichern");
    assert.equal(messages.de.controls.cancel, "Abbrechen");
  });

  it("translates all functional sections in ja/de without English fallback", () => {
    // 全功能域已翻译：ja/de 不再依赖 ...en 垫底，抽查此前最后覆盖的域
    assert.equal(messages.ja.brief.title, "Anna にどんなデッキを作成させますか？");
    assert.notEqual(messages.de.brief.title, en.brief.title);
    assert.notEqual(messages.ja.batchTesting.title, en.batchTesting.title);
    assert.notEqual(messages.de.manualEditor.title, en.manualEditor.title);
  });
});

describe("formatMessage", () => {
  it("replaces placeholders and lets the language pack own word order", () => {
    assert.equal(
      formatMessage(messages.ja.toasts.workspaceOpened, { id: "A1" }),
      "タスク A1 を開きました"
    );
    assert.equal(
      formatMessage(messages.de.toasts.workspaceOpened, { id: "A1" }),
      "Aufgabe A1 geöffnet"
    );
  });

  it("keeps unknown placeholders untouched", () => {
    assert.equal(formatMessage("{a} + {b}", { a: "1" }), "1 + {b}");
  });
});

describe("perf report locale contract", () => {
  it("keeps zh reports in Chinese", () => {
    assert.equal(toPerfReportLocale("zh"), "zh");
  });

  it("passes ja/de through to the four-locale report (backend contract)", () => {
    // Day 7 起 engine 报告已四语化：报告语言跟随界面语言直通
    assert.equal(toPerfReportLocale("en"), "en");
    assert.equal(toPerfReportLocale("ja"), "ja");
    assert.equal(toPerfReportLocale("de"), "de");
  });
});

describe("research text locale (leader feedback #1)", () => {
  it("follows the PPT output language for research batch text", () => {
    assert.equal(resolveResearchTextLocale("中文"), "zh");
    assert.equal(resolveResearchTextLocale("Chinese"), "zh");
    assert.equal(resolveResearchTextLocale("zh-CN"), "zh");
  });

  it("never follows a ja/de UI locale: non-Chinese output languages use neutral English", () => {
    assert.equal(resolveResearchTextLocale("English"), "en");
    assert.equal(resolveResearchTextLocale("Deutsch"), "en");
    assert.equal(resolveResearchTextLocale("日本語"), "en");
    assert.equal(resolveResearchTextLocale("German"), "en");
  });
});

describe("LocaleSwitch", () => {
  it("renders buttons from the registry instead of hardcoded locales", async () => {
    const source = await readFile(
      join(here, "../../src/features/deck-workspace/components/LocaleSwitch.tsx"),
      "utf8"
    );
    assert.match(source, /localeIds\.map/);
    assert.doesNotMatch(source, /setLocale\("en"\)|setLocale\("zh"\)/);
  });
});

describe("diagnostic codes (leader feedback #1, plan §4.7)", () => {
  it("round-trips code + params through encode/decode", () => {
    const encoded = encodeDiagnostic("WEB_QUERY_FAILED", { query: "市场 规模" });
    const decoded = decodeDiagnostic(encoded);
    assert.deepEqual(decoded, { code: "WEB_QUERY_FAILED", params: { query: "市场 规模" } });
  });

  it("encodes param-less codes without a JSON tail", () => {
    const encoded = encodeDiagnostic("IMG_IMPORT_SAVE_FAILED");
    assert.equal(encoded, "@diag:IMG_IMPORT_SAVE_FAILED");
    assert.deepEqual(decodeDiagnostic(encoded), { code: "IMG_IMPORT_SAVE_FAILED", params: {} });
  });

  it("rejects non-code values so legacy checkpoint text passes through", () => {
    for (const legacy of [
      "部分入选图片未能保存为本地素材。",
      "Some selected images could not be saved as local assets.",
      "@diag:NOT_A_REAL_CODE",
      "@diag:WEB_QUERY_FAILED {bad json",
      "",
    ]) {
      assert.equal(decodeDiagnostic(legacy), null, JSON.stringify(legacy));
      assert.equal(renderDiagnostic("ja", legacy), legacy, "legacy text must pass through untouched");
    }
  });

  it("renders every code in all four locales with params interpolated", () => {
    const samples: Array<[DiagnosticCode, Record<string, string | number>]> = [
      ["IMG_SEARCH_LIMIT_REACHED", { limit: 12 }],
      ["IMG_DUPLICATE_QUERY", { query: "robot" }],
      ["WEB_PAGE_READ_FAILED", { url: "https://example.com" }],
      ["IMG_ATTACHMENT_BUDGET_REACHED_SKIPPED", { budgetMb: 30 }],
    ];
    for (const [code, params] of samples) {
      const encoded = encodeDiagnostic(code, params);
      for (const locale of ["en", "zh", "ja", "de"] as const) {
        const rendered = renderDiagnostic(locale, encoded);
        assert.ok(rendered.length > 0, `${code}/${locale} empty`);
        assert.ok(!rendered.startsWith("@diag:"), `${code}/${locale} leaked the code token`);
        assert.ok(!rendered.includes("{"), `${code}/${locale} left a placeholder: ${rendered}`);
        for (const value of Object.values(params)) {
          assert.ok(rendered.includes(String(value)), `${code}/${locale} missing param ${value}`);
        }
      }
    }
  });

  it("keeps zh/en wording identical to the pre-migration strings", () => {
    assert.equal(
      renderDiagnostic("zh", encodeDiagnostic("IMG_EXISTING_SUFFICIENT")),
      "已有图片素材足够，未执行新的图片搜索。"
    );
    assert.equal(
      renderDiagnostic("en", encodeDiagnostic("WEB_QUERY_NO_RESULTS", { query: "q1" })),
      "No usable result was collected for query “q1”."
    );
  });

  it("the producer file persists codes instead of locale-branched text", async () => {
    const source = await readFile(
      join(here, "../../src/features/deck-generation/linearResearchWorkflow.ts"),
      "utf8"
    );
    // 诊断域 22 个产生点全部走 encodeDiagnostic
    for (const code of diagnosticCodes) {
      assert.ok(source.includes(`"${code}"`), `${code} not referenced by producer`);
    }
    // 诊断文案不再出现界面语言二元判断（R 类 batchTitle/stageMessage 不在此列，
    // 它们走 OutputLanguage / 进度域，属设计内保留）
    assert.doesNotMatch(source, /gaps\.push\(runtime\.locale === "zh"/);
  });
});
