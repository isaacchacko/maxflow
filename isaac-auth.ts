import { createHash, randomBytes } from "node:crypto";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse, type AuthenticatorTransportFuture } from "@simplewebauthn/server";
import { callerOf } from "./shared/legacy-maxflow";
import { PORT } from "./instance";
import { readStateJson, writeStateJson } from "./state";
import { isRecord } from "./shared/guards";

const PASSKEYS_FILE = "isaac-passkeys.json";
const SESSIONS_FILE = "isaac-sessions.json";
export const TOKEN_HEADER = "x-yarn-isaac-token";
const RP_ID = "localhost";
const ORIGIN = `http://localhost:${String(PORT)}`;
const SESSION_MS = 30 * 86_400_000;
const FRESH_MS = 2 * 60_000;
const CHALLENGE_MS = 2 * 60_000;
export const NEEDS_HEADER = "x-yarn-isaac";

type Passkey = { id: string; publicKey: string; counter: number; transports: string[]; at: number; label: string };
type IsaacSession = { hash: string; at: number; verifiedAt: number };
const isList = (value: unknown): value is unknown[] => Array.isArray(value);
const isPasskeys = (value: unknown): value is Passkey[] => isList(value) && value.every((p) => isRecord(p) && typeof p["id"] === "string" && typeof p["publicKey"] === "string");
const isSessions = (value: unknown): value is IsaacSession[] => isList(value) && value.every((s) => isRecord(s) && typeof s["hash"] === "string");

const passkeys: Passkey[] = readStateJson(PASSKEYS_FILE, isPasskeys) ?? [];
const signedIn: IsaacSession[] = readStateJson(SESSIONS_FILE, isSessions) ?? [];
const challenges = new Map<string, { kind: "register" | "login"; at: number }>();

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");
// constraint: a cookie on localhost reaches every port, previews and dev servers running agent code included; localStorage and a header stay on this origin
const tokenIn = (req: Request) => req.headers.get(TOKEN_HEADER) ?? undefined;

function sessionOf(req: Request): IsaacSession | undefined {
  const token = tokenIn(req);
  if (token === undefined || token === "") return undefined;
  const hash = hashOf(token);
  return signedIn.find((s) => s.hash === hash && Date.now() - s.at < SESSION_MS);
}

const isEnrolled = () => passkeys.length > 0;
// constraint: before his first passkey there is nothing to check against, so the old same-origin test holds until he enrolls
const isTheOldBrowserTest = (req: Request) => req.headers.get("sec-fetch-site") === "same-origin";

export function isIsaacsBrowser(req: Request) {
  if (callerOf(req) !== "") return false;
  return isEnrolled() ? sessionOf(req) !== undefined : isTheOldBrowserTest(req);
}

// constraint: a browser can't set headers on a WebSocket, so the terminal sends his token in its URL
export function isIsaacsSocket(url: URL) {
  if (!isEnrolled()) return true;
  const token = url.searchParams.get("t") ?? "";
  const hash = hashOf(token);
  return token !== "" && signedIn.some((s) => s.hash === hash && Date.now() - s.at < SESSION_MS);
}

export function isIsaacsFresh(req: Request) {
  if (!isIsaacsBrowser(req)) return false;
  const session = sessionOf(req);
  return !isEnrolled() || (session !== undefined && Date.now() - session.verifiedAt < FRESH_MS);
}

export function isaacRefusal(req: Request, what: string, isFreshNeeded = false): Response | undefined {
  const isOk = isFreshNeeded ? isIsaacsFresh(req) : isIsaacsBrowser(req);
  if (isOk) return undefined;
  if (callerOf(req) !== "") return new Response(`only Isaac ${what}, from his own browser; an agent can't`, { status: 403 });
  const needs = isIsaacsBrowser(req) ? "fresh" : "sign-in";
  return new Response(`only Isaac ${what}: ${needs === "fresh" ? "confirm with Touch ID" : "sign in with his passkey"} first`, { status: 401, headers: { [NEEDS_HEADER]: needs } });
}

function issueSession(): string {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const kept = signedIn.filter((s) => now - s.at < SESSION_MS);
  signedIn.splice(0, signedIn.length, ...kept, { hash: hashOf(token), at: now, verifiedAt: now });
  writeStateJson(SESSIONS_FILE, signedIn);
  return token;
}

function refreshSession(req: Request): string | undefined {
  const session = sessionOf(req);
  if (!session) return issueSession();
  session.verifiedAt = Date.now();
  writeStateJson(SESSIONS_FILE, signedIn);
  return undefined;
}

function isChallengeTaken(kind: "register" | "login", challenge: string) {
  const held = challenges.get(challenge);
  challenges.delete(challenge);
  return held?.kind === kind && Date.now() - held.at < CHALLENGE_MS;
}

const keepChallenge = (kind: "register" | "login", challenge: string) => challenges.set(challenge, { kind, at: Date.now() });

export const status = (req: Request) => ({
  enrolled: passkeys.map((p) => ({ label: p.label, at: p.at })),
  signedIn: isEnrolled() && sessionOf(req) !== undefined,
  fresh: isEnrolled() && isIsaacsFresh(req),
});

// constraint: the first passkey can be enrolled by whoever asks first, so only while none exists; another one needs him already signed in, with Touch ID just now
export const canEnroll = (req: Request) => callerOf(req) === "" && (isEnrolled() ? isIsaacsFresh(req) : isTheOldBrowserTest(req));

export async function registrationOptions() {
  const options = await generateRegistrationOptions({
    rpName: "yarn",
    rpID: RP_ID,
    userName: "isaac",
    attestationType: "none",
    excludeCredentials: passkeys.map((p) => ({ id: p.id, transports: p.transports as AuthenticatorTransportFuture[] })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "required", authenticatorAttachment: "platform" },
  });
  keepChallenge("register", options.challenge);
  return options;
}

const challengeIn = (response: unknown) => {
  const client = isRecord(response) && isRecord(response["response"]) ? response["response"]["clientDataJSON"] : undefined;
  if (typeof client !== "string") return "";
  const parsed: unknown = JSON.parse(Buffer.from(client, "base64url").toString("utf8"));
  return isRecord(parsed) && typeof parsed["challenge"] === "string" ? parsed["challenge"] : "";
};

export async function enroll(response: unknown, label: string): Promise<{ token: string } | { error: string }> {
  const challenge = challengeIn(response);
  if (!isChallengeTaken("register", challenge)) return { error: "that enrollment expired; start again" };
  const verified = await verifyRegistrationResponse({ response: response as Parameters<typeof verifyRegistrationResponse>[0]["response"], expectedChallenge: challenge, expectedOrigin: ORIGIN, expectedRPID: RP_ID, requireUserVerification: true });
  if (!verified.verified || !verified.registrationInfo) return { error: "the passkey didn't verify" };
  const { credential } = verified.registrationInfo;
  passkeys.push({ id: credential.id, publicKey: Buffer.from(credential.publicKey).toString("base64url"), counter: credential.counter, transports: credential.transports ?? [], at: Date.now(), label });
  writeStateJson(PASSKEYS_FILE, passkeys);
  return { token: issueSession() };
}

export async function loginOptions() {
  const options = await generateAuthenticationOptions({ rpID: RP_ID, userVerification: "required", allowCredentials: passkeys.map((p) => ({ id: p.id, transports: p.transports as AuthenticatorTransportFuture[] })) });
  keepChallenge("login", options.challenge);
  return options;
}

export async function signIn(req: Request, response: unknown): Promise<{ token?: string } | { error: string }> {
  const challenge = challengeIn(response);
  if (!isChallengeTaken("login", challenge)) return { error: "that sign-in expired; start again" };
  const id = isRecord(response) ? response["id"] : undefined;
  const passkey = passkeys.find((p) => p.id === id);
  if (!passkey) return { error: "not one of his passkeys" };
  const verified = await verifyAuthenticationResponse({
    response: response as Parameters<typeof verifyAuthenticationResponse>[0]["response"],
    expectedChallenge: challenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    requireUserVerification: true,
    credential: { id: passkey.id, publicKey: Buffer.from(passkey.publicKey, "base64url"), counter: passkey.counter, transports: passkey.transports as AuthenticatorTransportFuture[] },
  });
  if (!verified.verified) return { error: "the passkey didn't verify" };
  passkey.counter = verified.authenticationInfo.newCounter;
  writeStateJson(PASSKEYS_FILE, passkeys);
  const token = refreshSession(req);
  return token === undefined ? {} : { token };
}
