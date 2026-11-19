import { namesTable, objectivesTable, tasksTable, threadsTable, todosTable } from "./state";
import { type Session, sessions } from "./sessions";
import type { Objective, Task, Thread, Todo } from "./model";

const THREADS_WRITE_DEBOUNCE_MS = 200;

export const live = (s?: Session): s is Session => s?.exitCode === null;
export const objectives = objectivesTable.read() as Objective[];
export const saveObjectives = () => objectivesTable.write(objectives);
export const threads = threadsTable.read() as Thread[];
export let threadsDirty: ReturnType<typeof setTimeout> | undefined;
export const writeThreads = () => {
  clearTimeout(threadsDirty);
  threadsDirty = undefined;
  threadsTable.write(threads);
};
export const saveThreads = () => {
  threadsDirty ??= setTimeout(writeThreads, THREADS_WRITE_DEBOUNCE_MS);
};
export const names = namesTable.all();
export function rememberNames() {
  let hasChanged = false;
  for (const s of sessions.values()) {
    if (names[s.id] === s.name) continue;
    names[s.id] = s.name;
    hasChanged = true;
  }
  if (hasChanged) namesTable.write(names);
}
export const tasks = tasksTable.read() as Task[];
export const saveTasks = () => tasksTable.write(tasks);

type TodoBeforeStatesAndThreadLists = Omit<Todo, "state" | "threadIds"> & { state?: Todo["state"]; threadIds?: string[]; done?: boolean; threadId?: string };

const todoFromAnyVersion = ({ done, threadId, ...t }: TodoBeforeStatesAndThreadLists): Todo => ({
  ...t,
  state: t.state ?? (done === true ? "done" : "todo"),
  threadIds: t.threadIds ?? (threadId === undefined || threadId === "" ? [] : [threadId]),
});

export const todos: Todo[] = (todosTable.read() as TodoBeforeStatesAndThreadLists[]).map(todoFromAnyVersion);
export const saveTodos = () => todosTable.write(todos);
