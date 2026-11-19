import { isRecord } from "./shared/guards";

export type CdpEvent = { method: string; params: Record<string, unknown> };
type Pending = { resolve: (result: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

const COMMAND_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 10_000;

export class CdpError extends Error {}

export async function unlessItFails<T>(work: Promise<T>): Promise<T | undefined> {
  const [settled] = await Promise.allSettled([work]);
  return settled.status === "fulfilled" ? settled.value : undefined;
}

export class Cdp {
  static async connect(url: string): Promise<Cdp> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new CdpError(`no answer from ${url} in ${String(CONNECT_TIMEOUT_MS)}ms`));
      }, CONNECT_TIMEOUT_MS);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new CdpError(`couldn't connect to ${url}`));
      });
    });
    return new Cdp(socket);
  }

  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(event: CdpEvent) => void>();
  private readonly socket: WebSocket;

  closed = false;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      this.receive(String(event.data));
    });
    socket.addEventListener("close", () => {
      this.closed = true;
      for (const listener of this.listeners) listener({ method: "closed", params: {} });
      for (const waiting of this.pending.values()) waiting.reject(new CdpError("the browser closed"));
      this.pending.clear();
    });
  }

  private receive(text: string) {
    const message: unknown = JSON.parse(text);
    if (!isRecord(message)) return;
    if (typeof message["id"] === "number") {
      this.settle(message["id"], message);
      return;
    }
    if (typeof message["method"] !== "string") return;
    const event = { method: message["method"], params: isRecord(message["params"]) ? message["params"] : {} };
    for (const listener of this.listeners) listener(event);
  }

  private settle(id: number, message: Record<string, unknown>) {
    const waiting = this.pending.get(id);
    if (!waiting) return;
    this.pending.delete(id);
    clearTimeout(waiting.timer);
    const error = message["error"];
    if (isRecord(error)) waiting.reject(new CdpError(String(error["message"])));
    else waiting.resolve(isRecord(message["result"]) ? message["result"] : {});
  }

  async send(method: string, params: Record<string, unknown> = {}, timeoutMs = COMMAND_TIMEOUT_MS): Promise<Record<string, unknown>> {
    if (this.closed) throw new CdpError("the browser closed");
    this.nextId += 1;
    const id = this.nextId;
    const reply = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`${method} got no answer in ${String(timeoutMs)}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return reply;
  }

  on(listener: (event: CdpEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  close() {
    this.socket.close();
  }
}
