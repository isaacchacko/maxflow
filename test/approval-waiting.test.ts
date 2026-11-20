import { expect, test } from "bun:test";
import { isWaitingOnReview } from "../sentries/approval-score";

test("a REVIEW_REQUIRED PR waits on a review", () => {
  expect(isWaitingOnReview({ reviewDecision: "REVIEW_REQUIRED", mergeStateStatus: "BLOCKED", approved: false })).toBe(true);
});

test("a BLOCKED PR with a null decision and no approval waits on a review", () => {
  expect(isWaitingOnReview({ reviewDecision: null, mergeStateStatus: "BLOCKED", approved: false })).toBe(true);
  expect(isWaitingOnReview({ reviewDecision: "", mergeStateStatus: "BLOCKED", approved: false })).toBe(true);
});

test("a null-decision PR that is approved, conflicting, clean or not yet polled for its merge state does not", () => {
  expect(isWaitingOnReview({ reviewDecision: null, mergeStateStatus: "BLOCKED", approved: true })).toBe(false);
  expect(isWaitingOnReview({ reviewDecision: null, mergeStateStatus: "DIRTY", approved: false })).toBe(false);
  expect(isWaitingOnReview({ reviewDecision: null, mergeStateStatus: "CLEAN", approved: false })).toBe(false);
  expect(isWaitingOnReview({ reviewDecision: null, approved: false })).toBe(false);
});

test("an approved or changes-requested PR does not", () => {
  expect(isWaitingOnReview({ reviewDecision: "APPROVED", mergeStateStatus: "BLOCKED", approved: true })).toBe(false);
  expect(isWaitingOnReview({ reviewDecision: "CHANGES_REQUESTED", mergeStateStatus: "BLOCKED", approved: false })).toBe(false);
});
