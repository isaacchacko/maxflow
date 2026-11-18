import { createStore } from "@/store";

/** The agent he is pointing at (a row in a thread's Agents, a face in its header, a message's picture): its messages light up. */
export const hoverAgent = createStore<string | undefined>(undefined);

/** Handlers that point at an agent while the pointer is over the element, and stop when it leaves. */
export const pointsAt = (id: string) => ({ onMouseEnter: () => hoverAgent.set(id), onMouseLeave: () => hoverAgent.get() === id && hoverAgent.set(undefined) });
