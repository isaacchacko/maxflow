import { createStore } from "../store";

export type Cursor = {
  x: number;
  y: number;
  visible: boolean;
  pressing: boolean;
  duration: number;
  ghost?: string;
  clicks: number;
};

export const cursorStore = createStore<Cursor>({
  x: innerWidth - 48,
  y: innerHeight - 48,
  visible: false,
  pressing: false,
  duration: 0,
  clicks: 0,
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function find(target: string) {
  return document.querySelector<HTMLElement>(`[data-agent="${target}"]`);
}

async function waitFor(target: string) {
  for (let i = 0; i < 40; i++) {
    const el = find(target);
    if (el) return el;
    await sleep(50);
  }
  throw new Error(`agent target not found: ${target}`);
}

export async function show() {
  const home = find("face")!.getBoundingClientRect();
  cursorStore.set(c => ({ ...c, x: home.x + home.width / 2, y: home.y + home.height / 2, duration: 0, visible: true }));
  await sleep(150);
}

export async function hide() {
  await moveTo("face");
  cursorStore.set(c => ({ ...c, visible: false }));
}

export async function moveTo(target: string) {
  const el = await waitFor(target);
  const r = el.getBoundingClientRect();
  const x = r.x + Math.min(r.width / 2, 60);
  const y = r.y + r.height / 2;
  const { x: cx, y: cy } = cursorStore.get();
  const duration = Math.min(1100, 350 + Math.hypot(x - cx, y - cy) * 0.6);
  cursorStore.set(c => ({ ...c, x, y, duration }));
  await sleep(duration + 120);
  return el;
}

export async function click(target: string) {
  const el = await moveTo(target);
  cursorStore.set(c => ({ ...c, pressing: true, clicks: c.clicks + 1 }));
  await sleep(140);
  el.click();
  cursorStore.set(c => ({ ...c, pressing: false }));
  await sleep(350);
}

export async function drag(from: string, to: string, label: string, onDrop: () => void) {
  await moveTo(from);
  cursorStore.set(c => ({ ...c, pressing: true, ghost: label }));
  await sleep(250);
  await moveTo(to);
  onDrop();
  cursorStore.set(c => ({ ...c, pressing: false, ghost: undefined, clicks: c.clicks + 1 }));
  await sleep(400);
}

export async function type(target: string, text: string, write: (value: string) => void) {
  await click(target);
  for (let i = 1; i <= text.length; i++) {
    write(text.slice(0, i));
    await sleep(18 + Math.random() * 40);
  }
  await sleep(250);
}
