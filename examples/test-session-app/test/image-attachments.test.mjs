import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSessionImageAttachments, imageFileMetadata, uploadSessionImage, validateImageSelection,
} from "../src/image-attachments.js";
import { buildSessionRunInput } from "../src/session-config.js";

const NOW = Date.parse("2026-09-09T00:00:00Z");
const file = new File([new Uint8Array([137, 80, 78, 71])], "截图.png", { type: "image/png" });

function host({ negotiate = {}, confirm = {}, putStatus = 200 } = {}) {
  const calls = [];
  return {
    calls,
    runtime: {
      upload: {
        async negotiate(input) {
          calls.push(["negotiate", input]);
          return { put_url: "https://upload.example/image", r2_key: "image-key", headers: { "Content-Type": "image/png" }, ...negotiate };
        },
        async confirm(input) {
          calls.push(["confirm", input]);
          return { download_url: "https://images.example/image.png", expires_in: 600, ...confirm };
        },
      },
    },
    async fetchImpl(url, input) {
      calls.push(["put", url, input]);
      return { ok: putStatus >= 200 && putStatus < 300, status: putStatus };
    },
    now: () => NOW,
  };
}

test("校验图片数量、类型和空文件，浏览器缺失 MIME 时识别扩展名", () => {
  assert.doesNotThrow(() => validateImageSelection(Array(6).fill(file)));
  assert.throws(() => validateImageSelection(Array(7).fill(file)), /最多.*6/);
  assert.throws(() => imageFileMetadata(new File([], "empty.png", { type: "image/png" })), /为空/);
  assert.throws(() => imageFileMetadata(new File(["text"], "doc.txt", { type: "text/plain" })), /仅支持/);
  assert.equal(imageFileMetadata(new File(["jpeg"], "PHOTO.JPG")).mime_type, "image/jpeg");
});

test("上传只将原始文件交给 PUT，RPC 传递元数据，阶段顺序正确", async () => {
  const stub = host();
  const phases = [];
  const upload = await uploadSessionImage(stub.runtime, file, { ...stub, onPhase: (...phase) => phases.push(phase) });
  assert.deepEqual(stub.calls.map(([name]) => name), ["negotiate", "put", "confirm"]);
  assert.deepEqual(stub.calls[0][1], { filename: "截图.png", mime_type: "image/png", size_bytes: 4, purpose: "image_input" });
  assert.equal(stub.calls[1][2].body, file);
  assert.equal(stub.calls[1][2].method, "PUT");
  assert.deepEqual(stub.calls[1][2].headers, { "Content-Type": "image/png" });
  assert.deepEqual(stub.calls[2][1], { r2_key: "image-key" });
  assert.equal(upload.expires_at_ms, NOW + 600_000);
  assert.deepEqual(phases, [
    ["negotiate", "started"], ["negotiate", "succeeded"],
    ["put", "started"], ["put", "succeeded"],
    ["confirm", "started"], ["confirm", "succeeded"],
  ]);
});

test("上传失败不确认对象，网络错误不会伪装成成功", async () => {
  const stub = host({ putStatus: 403 });
  await assert.rejects(uploadSessionImage(stub.runtime, file, stub), /HTTP 403/);
  assert.deepEqual(stub.calls.map(([name]) => name), ["negotiate", "put"]);
  const offline = host();
  await assert.rejects(uploadSessionImage(offline.runtime, file, {
    ...offline, fetchImpl: async () => { throw new Error("网络已断开"); },
  }), /网络已断开/);
  assert.equal(offline.calls.length, 1);
});

test("上传能力缺失、协商或确认失败都会明确报错", async () => {
  await assert.rejects(uploadSessionImage({}, file), /不支持图片上传/);
  for (const options of [
    { negotiate: { put_url: "http://upload.example/image" } },
    { negotiate: { r2_key: "" } },
    { confirm: { download_url: undefined } },
  ]) {
    const stub = host(options);
    await assert.rejects(uploadSessionImage(stub.runtime, file, stub), /没有返回/);
  }
  const stub = host();
  stub.runtime.upload.confirm = async () => { throw new Error("确认失败"); };
  await assert.rejects(uploadSessionImage(stub.runtime, file, stub), /确认失败/);
});

test("优先使用绝对过期时间；无过期元数据时不虚构有效期", async () => {
  const expiresAt = "2026-09-09T00:30:00Z";
  const absolute = host({ confirm: { expires_at: expiresAt, expires_in: 5 } });
  assert.equal((await uploadSessionImage(absolute.runtime, file, absolute)).expires_at_ms, Date.parse(expiresAt));
  const negotiated = host({ negotiate: { expires_at: expiresAt } });
  assert.equal((await uploadSessionImage(negotiated.runtime, file, negotiated)).expires_at_ms, Date.parse(expiresAt));
  const unknown = host({ confirm: { expires_in: undefined } });
  const upload = await uploadSessionImage(unknown.runtime, file, unknown);
  assert.equal(upload.expires_at_ms, null);
  assert.equal(buildSessionImageAttachments([{ status: "uploaded", upload }], "auto", NOW).length, 1);
  const invalid = host({ confirm: { expires_at: "invalid" } });
  await assert.rejects(uploadSessionImage(invalid.runtime, file, invalid), /过期时间无效/);
});

test("任意图片未就绪或即将过期时阻止整轮附件构造，不静默丢图", async () => {
  const stub = host();
  const upload = await uploadSessionImage(stub.runtime, file, stub);
  const ready = { status: "uploaded", upload };
  for (const status of ["pending", "uploading", "failed"]) {
    assert.throws(() => buildSessionImageAttachments([ready, { status }], "high", NOW), /全部图片/);
  }
  for (const offset of [-1, 0, 120_000]) {
    assert.throws(() => buildSessionImageAttachments([
      { status: "uploaded", upload: { ...upload, expires_at_ms: NOW + offset } },
    ], "high", NOW), /请重新上传/);
  }
  assert.equal(buildSessionImageAttachments([ready], "high", NOW).length, 1);
});

test("多图以原始顺序进入每轮请求，后续编辑不改变已发请求", async () => {
  const stub = host();
  const upload = await uploadSessionImage(stub.runtime, file, stub);
  const images = [
    { status: "uploaded", upload },
    { status: "uploaded", upload: { ...upload, filename: "第二张.png", url: "https://images.example/second.png" } },
  ];
  for (const id of ["selected-id", "manual-id", "saved-id"]) {
    const attachments = buildSessionImageAttachments(images, "low", NOW);
    const request = buildSessionRunInput({ appSessionUuid: id, userPrompt: "比较两张图片", systemPrompt: "用中文回答", modelId: "vision-model", attachments });
    assert.deepEqual(request, {
      app_session_uuid: id, content: "比较两张图片", systemPrompt: "用中文回答",
      modelPreferences: { hints: [{ name: "vision-model" }] },
      attachments: [
        { type: "image/png", url: upload.url, filename: "截图.png", detail: "low" },
        { type: "image/png", url: "https://images.example/second.png", filename: "第二张.png", detail: "low" },
      ],
    });
    attachments[0].url = "changed";
    assert.equal(request.attachments[0].url, upload.url);
  }
});

test("清空图片后继续使用原有纯文本请求", () => {
  const attachments = buildSessionImageAttachments([]);
  assert.deepEqual(buildSessionRunInput({ appSessionUuid: "session", userPrompt: "你好", attachments }), {
    app_session_uuid: "session", content: "你好",
  });
});
