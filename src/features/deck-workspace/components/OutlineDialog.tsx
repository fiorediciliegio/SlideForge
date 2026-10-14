import { useEffect, useRef, type ReactNode } from "react";

/** 原生模态框负责焦点约束；关闭时将焦点交还触发按钮。 */
export function OutlineDialog(props: {
  className: string;
  labelledBy: string;
  busy?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    dialog?.showModal();
    dialog?.querySelector<HTMLElement>("[data-outline-autofocus]")?.focus({ preventScroll: true });
    return () => {
      dialog?.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return <dialog ref={ref} className={`outline-dialog ${props.className}`} aria-labelledby={props.labelledBy}
    aria-busy={props.busy || undefined}
    onCancel={(event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!props.busy) props.onClose();
    }}>
    {props.children}
  </dialog>;
}
