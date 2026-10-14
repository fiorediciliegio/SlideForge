/**
 * 应用元信息。抽离自平台 app.json manifest，独立后版本号以 package.json 为准，
 * 此处保留原 import 形状的兼容出口（两处消费方均只读 version）。
 */
export const appManifest = {
  name: "slideforge",
  version: "0.1.0",
} as const;

export default appManifest;
