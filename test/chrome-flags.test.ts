import { expect, test } from "bun:test";
import { chromeFlags, KEYCHAIN_UNTOUCHED } from "../browsers";

test("an agent's Chrome never touches the keychain, so it can't raise a dialog on Isaac's screen", () => {
  expect(KEYCHAIN_UNTOUCHED).toEqual(["--use-mock-keychain", "--password-store=basic"]);
  expect(chromeFlags("/tmp/profile")).toEqual(expect.arrayContaining(KEYCHAIN_UNTOUCHED));
});
