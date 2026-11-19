import { namesTable, objectivesTable, tasksTable, threadsTable, todosTable } from "./state";
import { type Session, sessions } from "./sessions";
import { type Objective, type Task, type Thread, type Todo } from "./model";

export const live = (s?: Session): s is Session => !!s && s.exitCode === null;
export const objectives = objectivesTable.read() as Objective[];
export const saveObjectives = () => objectivesTable.write(objectives);
export const threads = threadsTable.read() as Thread[];
// Written a moment after the last change, not inside each request: a burst of changes writes once, and the request that made one
// doesn't wait on serializing every thread. Flushed on the way out, so a restart loses nothing.
export let threadsDirty: ReturnType<typeof setTimeout> | undefined;
export const writeThreads = () => (clearTimeout(threadsDirty), (threadsDirty = undefined), threadsTable.write(threads));
export const saveThreads = () => void (threadsDirty ??= setTimeout(writeThreads, 200));
// The last name each session went by, so a message from one that has ended reads as it rather than as a bare id.
export const names = namesTable.all();
export function rememberNames() {
  let changed = false;
  for (const s of sessions.values()) if (names[s.id] !== s.name) (names[s.id] = s.name), (changed = true);
  if (changed) namesTable.write(names);
}
export const tasks = tasksTable.read() as Task[];
export const saveTasks = () => tasksTable.write(tasks);
// Todos saved before states were a done flag, or before a todo held several threads.
export const todos: Todo[] = (todosTable.read() as (Todo & { done?: boolean; threadId?: string })[]).map(
  ({ done, threadId, ...t }: Todo & { done?: boolean; threadId?: string }) => ({ ...t, state: t.state ?? (done ? "done" : "todo"), threadIds: t.threadIds ?? (threadId ? [threadId] : []) }),
);
export const saveTodos = () => todosTable.write(todos);
