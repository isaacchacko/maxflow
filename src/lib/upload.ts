import { isRecord } from "../../shared/guards";

export async function uploadKeptAsFile(file: Blob) {
  const res = await fetch("/api/uploads", { method: "POST", headers: { "content-type": file.type }, body: file });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const body: unknown = await res.json();
  if (!isRecord(body) || typeof body["path"] !== "string") throw new Error("upload returned no path");
  return body["path"];
}
