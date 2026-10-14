import { useEffect, useRef, useState } from "react";
import type { AgentStreamEvent } from "../../agent/agentClient";
import type { OutlineAttemptInfo } from "../../ai/types";
import { appendProcessText, beginProcessStep, finishProcessRound, initializeProcessSteps, updateProcessStep, type ProcessStep } from "./model";

/** View-only progress: no token-sized backend writes, and stale runs cannot update a new run. */
export function useProcessProgress() {
  const [steps, setSteps] = useState<ProcessStep[]>([]);
  const version = useRef(0);
  const snapshot = useRef<ProcessStep[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; version.current++; clearTimeout(timer.current); }; }, []);
  function start(definitions: Array<Pick<ProcessStep, "id" | "label">>, isCurrent: () => boolean = () => true, resume = false) {
    clearTimeout(timer.current);
    timer.current = undefined;
    const current = ++version.current;
    let pending = initializeProcessSteps(definitions, resume ? snapshot.current : []);
    const sessionOffset = Math.max(0, ...pending.flatMap((step) => step.rounds?.map((round) => round.session) ?? []));
    let lastPaint = 0;
    const valid = () => mounted.current && version.current === current && isCurrent();
    const paint = () => { if (!valid()) return; clearTimeout(timer.current); timer.current = undefined; snapshot.current = pending; setSteps([...pending]); lastPaint = Date.now(); };
    const patch = (id: string, value: Partial<ProcessStep>) => { if (!valid()) return; pending = updateProcessStep(pending, id, value); paint(); };
    paint();
    return {
      begin(id: string, summary?: string) {
        const step = pending.find((item) => item.id === id);
        if (step) patch(id, beginProcessStep(step, Date.now(), summary));
      },
      beginRound(id: string, info: OutlineAttemptInfo) {
        const step = pending.find((item) => item.id === id);
        if (!step) return;
        patch(id, { summary: undefined, rounds: [...(step.rounds ?? []), {
          ...info, session: info.session + sessionOffset, id: `${current}-${id}-${(step.rounds?.length ?? 0) + 1}`,
          text: "", state: "running",
        }] });
      },
      endRound(id: string, result: { status: "success" | "retry" | "error"; text?: string }) {
        const step = pending.find((item) => item.id === id);
        if (step) patch(id, finishProcessRound(step, result.status === "success" ? "completed" : "failed", result.text));
      },
      complete(id: string, value: Partial<ProcessStep> = {}) { patch(id, { ...value, state: "completed", endedAt: Date.now() }); },
      patch,
      stream(id: string) {
        return (event: AgentStreamEvent) => {
          if (!valid()) return;
          const step = pending.find((item) => item.id === id);
          if (!step) return;
          if (event.type === "content") {
            pending = updateProcessStep(pending, id, appendProcessText(step, event.text));
            if (Date.now() - lastPaint >= 80) paint();
            else if (!timer.current) timer.current = setTimeout(paint, 80 - (Date.now() - lastPaint));
          } else if (event.type === "activity") patch(id, { summary: event.message });
          else paint();
        };
      },
      fail() {
        pending = pending.map((step) => step.state === "running" ? { ...step, ...finishProcessRound(step, "failed"), state: "failed", endedAt: Date.now() } : step);
        paint();
      },
    };
  }
  return { steps, start, clear: () => { version.current++; clearTimeout(timer.current); timer.current = undefined; snapshot.current = []; setSteps([]); } };
}
