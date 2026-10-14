export async function openFullscreenPreview(
  element: HTMLElement | null,
  fallback: () => void,
): Promise<void> {
  const fullscreenElement = element as (HTMLElement & {
    webkitRequestFullscreen?: () => Promise<void> | void;
  }) | null;
  const requestFullscreen = fullscreenElement?.requestFullscreen ?? fullscreenElement?.webkitRequestFullscreen;
  if (!requestFullscreen) {
    fallback();
    return;
  }

  try {
    await requestFullscreen.call(fullscreenElement);
  } catch {
    fallback();
  }
}

export async function startFullscreenPresentation(
  element: HTMLElement | null,
  enterPresentMode: () => void,
): Promise<void> {
  enterPresentMode();
  await openFullscreenPreview(element, () => undefined);
}

export async function exitFullscreenPreview(): Promise<void> {
  const documentWithWebkit = document as Document & {
    webkitExitFullscreen?: () => Promise<void> | void;
  };
  const exitFullscreen = document.exitFullscreen ?? documentWithWebkit.webkitExitFullscreen;
  if (!exitFullscreen) return;
  await exitFullscreen.call(documentWithWebkit);
}
