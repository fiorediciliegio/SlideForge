import { createContext } from "react";
import type { SlideAspectRatio } from "../executas/ppt-engine/src/slide-format";
export const SlideAspectRatioContext = createContext<SlideAspectRatio>("16:9");
export * from "../executas/ppt-engine/src/slide-format";
