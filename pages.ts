import type { Block } from "./model";
import { objectives, saveObjectives, saveTasks, tasks } from "./stores";

type CardGridOfAnObjectiveOrTask = { page: Block[]; save: () => void };

export function pageOf(ref: string): CardGridOfAnObjectiveOrTask | null {
  const [type, id = ""] = ref.split("/", 2);
  if (type === "objective") {
    const o = objectives.find((x) => x.id === id);
    return o ? { page: o.page, save: saveObjectives } : null;
  }
  const t = type === "task" ? tasks.find((x) => x.id === Number(id.replace(/^t/, ""))) : undefined;
  return t ? { page: (t.page ??= []), save: saveTasks } : null;
}
