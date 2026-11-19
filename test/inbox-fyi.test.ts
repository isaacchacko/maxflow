import { expect, test } from "bun:test";
import { isBareAck } from "../sentries/inbox-fyi";

test("a bare acknowledgement is an FYI", () => {
  for (const said of ["Checked", "thanks!", "Thank you.", "ok", "LGTM", "👍", ":white_check_mark:", "<@U123> thanks"]) expect(isBareAck(said)).toBe(true);
});

test("anything that says more is not", () => {
  for (const said of ["", "thanks, can you also check the PO table?", "ok but why is CI red", "checked: the date is wrong", undefined]) expect(isBareAck(said)).toBe(false);
});
