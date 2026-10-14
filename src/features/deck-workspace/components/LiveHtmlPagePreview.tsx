import { useContext, useEffect, useRef, useState } from "react";
import { slideFormat, SlideAspectRatioContext } from "../../../slideFormat";

const PREVIEW_UPDATE_INTERVAL_MS = 250;

export function LiveHtmlPagePreview({ html, title }: { html: string; title: string }) {
  const { width, height } = slideFormat(useContext(SlideAspectRatioContext));
  const host = useRef<HTMLDivElement>(null);
  const frames = [useRef<HTMLIFrameElement>(null), useRef<HTMLIFrameElement>(null)];
  const [scale, setScale] = useState(0);
  const [shown, setShown] = useState(0);
  const shownRef = useRef(0);
  const latest = useRef(html);
  const displayed = useRef(html);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const painting = useRef(false);
  const animation = useRef(0);
  const schedule = useRef<() => void>(() => undefined);
  latest.current = html;

  useEffect(() => {
    const element = host.current!;
    const resize = () => setScale(Math.min(element.clientWidth / width, element.clientHeight / height));
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [width, height]);

  useEffect(() => {
    frames[0].current!.srcdoc = latest.current;
    displayed.current = latest.current;
    schedule.current = () => {
      if (timer.current !== undefined || painting.current || latest.current === displayed.current) return;
      // A bounded cadence, not a trailing debounce: continuous output cannot
      // keep postponing the next frame. Never reload the currently visible slot.
      timer.current = setTimeout(() => {
        timer.current = undefined;
        const next = latest.current;
        if (next === displayed.current) return;
        const slot = 1 - shownRef.current;
        frames[slot].current!.srcdoc = next;
        painting.current = true;
        // Allow the document to start painting, then reveal it progressively.
        // Slow images/fonts do not gate visibility on the iframe load event.
        animation.current = requestAnimationFrame(() => {
          animation.current = requestAnimationFrame(() => {
            displayed.current = next;
            shownRef.current = slot;
            setShown(slot);
            painting.current = false;
            schedule.current();
          });
        });
      }, PREVIEW_UPDATE_INTERVAL_MS);
    };
    return () => {
      clearTimeout(timer.current);
      cancelAnimationFrame(animation.current);
      timer.current = undefined;
      painting.current = false;
      schedule.current = () => undefined;
    };
  }, []);

  useEffect(() => { schedule.current(); }, [html]);

  return <div ref={host} className="generation-live-html-preview">
    {[0, 1].map((slot) => <iframe key={slot} ref={frames[slot]}
      title={slot === shown ? title : ""} aria-hidden={slot !== shown} sandbox="" tabIndex={-1}
      style={{ width, height, transform: `scale(${scale})`, position: "absolute", top: 0, left: 0,
        opacity: slot === shown ? 1 : 0, pointerEvents: "none" }} />)}
  </div>;
}
