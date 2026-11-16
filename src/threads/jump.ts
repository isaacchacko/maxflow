// Landing on a message: scrolled to and flashed once, whether by climbing out of its subthread or clicking a quote's link to it.
const arriving: { message?: string } = {};

export function flashMessage(id = arriving.message) {
  arriving.message = undefined;
  const el = id && document.querySelector(`[data-msg="${id}"]`);
  if (!el) return;
  el.scrollIntoView({ block: "center" });
  el.animate([{ backgroundColor: "color-mix(in oklch, var(--color-sky-400) 25%, transparent)" }, { backgroundColor: "transparent" }], { duration: 1600, easing: "ease-out" });
}

/** Opens a thread at one of its messages; the thread page flashes it once it has drawn. */
export function goToMessage(threadId: string, messageId?: string) {
  if (location.hash === `#thread/${threadId}`) return flashMessage(messageId);
  arriving.message = messageId;
  location.hash = `thread/${threadId}`;
}
