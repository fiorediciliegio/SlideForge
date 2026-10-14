import React, { type CSSProperties, type ReactNode } from "react";

export interface SafeMediaFrameProps {
  src?: string | null;
  alt: string;
  fit?: "cover" | "contain";
  width?: CSSProperties["width"];
  height?: CSSProperties["height"];
  children?: ReactNode;
}

/**
 * A bounded media slot for Page Source layouts.
 *
 * The image is absolutely positioned so its intrinsic dimensions never
 * participate in the size calculation of a Grid/Flex parent. The parent
 * layout must still provide a bounded width and height (or a flex/grid track
 * with an explicit available size).
 */
export default function SafeMediaFrame({
  src,
  alt,
  fit = "cover",
  width = "100%",
  height = "100%",
  children,
}: SafeMediaFrameProps) {
  const imageUrl = src?.trim();

  return (
    <div
      style={{
        position: "relative",
        width,
        height,
        minWidth: 0,
        minHeight: 0,
        overflow: "hidden",
        boxSizing: "border-box",
      }}
    >
      {imageUrl ? (
        <img
          src={imageUrl}
          alt={alt}
          style={{
            position: "absolute",
            inset: 0,
            display: "block",
            width: "100%",
            height: "100%",
            minWidth: 0,
            minHeight: 0,
            objectFit: fit,
          }}
        />
      ) : null}
      {children}
    </div>
  );
}
