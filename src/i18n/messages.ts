// 兼容层：语言包已拆分至 ./types ./en ./zh-CN ./ja-JP ./de-DE，聚合于 ./index。
// 本文件仅为保持既有 import 路径不变，新代码请直接从 "./index" 导入。
export { messages, formatMessage } from "./index";
export type { Locale, Messages } from "./index";
