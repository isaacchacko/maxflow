import { log, post, shortened } from "./inbox-board";

const BARE_ACK = /^(?:checked|thanks?(?: you)?|thx|ty|ok(?:ay)?|k|got it|sounds good|lgtm|looks good(?: to me)?|done|nice|cool|great|perfect|merged|:[\w+-]+:|\p{Extended_Pictographic}+)[\s.!]*$/iu;

const withoutMarkup = (text: string) => text.replaceAll(/<[^>]*>/g, "").trim();
export const isBareAck = (text = "") => {
  const said = withoutMarkup(text);
  return said !== "" && BARE_ACK.test(said);
};

export async function noteFyi(line: string, link: string) {
  const res = await post("/api/fyi", { text: shortened(line, 200), link });
  if (res.ok) log(`fyi: ${shortened(line, 80)}`);
  else log(`fyi note failed: ${await res.text()}`);
}
