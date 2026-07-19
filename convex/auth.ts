import { v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

// Minimal username/password auth. No third-party provider, no CLI provisioning —
// self-contained so it works on any Convex deployment immediately. Passwords are
// PBKDF2-hashed (Web Crypto, available in the Convex runtime) with a per-user
// random salt; sign-in mints an opaque bearer token stored in localStorage and
// validated server-side on every authenticated call.

const PBKDF2_ITERATIONS = 100_000;
const DERIVED_KEY_BITS = 256;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

async function pbkdf2(password: string, saltHex: string): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: hexToBytes(saltHex) as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    DERIVED_KEY_BITS,
  );
  return bytesToHex(new Uint8Array(bits));
}

// Length-independent constant-time-ish comparison for password hashes.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

function publicUser(user: Doc<"users">) {
  return { id: user._id, username: user.username, displayName: user.displayName };
}

export type PublicUser = ReturnType<typeof publicUser>;

// Resolve a bearer token to its user, or null. Used by every authenticated
// function; token is a secret validated here (never trust a raw userId arg).
export async function userForToken(
  ctx: QueryCtx | MutationCtx,
  token: string | undefined,
): Promise<Doc<"users"> | null> {
  if (!token) return null;
  const session = await ctx.db
    .query("sessions")
    .withIndex("by_token", (q) => q.eq("token", token))
    .unique();
  if (!session) return null;
  return ctx.db.get(session.userId);
}

export async function requireUserId(
  ctx: QueryCtx | MutationCtx,
  token: string | undefined,
): Promise<Id<"users">> {
  const user = await userForToken(ctx, token);
  if (!user) throw new Error("Not signed in.");
  return user._id;
}

async function createSession(ctx: MutationCtx, userId: Id<"users">): Promise<string> {
  const token = randomHex(32);
  await ctx.db.insert("sessions", { token, userId, createdAt: Date.now() });
  return token;
}

export const signUp = mutation({
  args: { username: v.string(), password: v.string() },
  handler: async (ctx, args) => {
    const displayName = args.username.trim();
    const username = normalizeUsername(args.username);
    // Accepts a plain username OR an email address.
    if (username.length < 3 || username.length > 50 || !/^[a-z0-9._+@-]+$/.test(username)) {
      throw new Error("Enter a username or email, 3–50 characters (letters, numbers, . _ - + @).");
    }
    if (args.password.length < 6) {
      throw new Error("Password must be at least 6 characters.");
    }
    const existing = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", username))
      .unique();
    if (existing) throw new Error("That username is taken.");

    const passwordSalt = randomHex(16);
    const passwordHash = await pbkdf2(args.password, passwordSalt);
    const userId = await ctx.db.insert("users", {
      username,
      displayName,
      passwordHash,
      passwordSalt,
      createdAt: Date.now(),
    });
    const token = await createSession(ctx, userId);
    const user = (await ctx.db.get(userId))!;
    return { token, user: publicUser(user) };
  },
});

export const signIn = mutation({
  args: { username: v.string(), password: v.string() },
  handler: async (ctx, args) => {
    const username = normalizeUsername(args.username);
    const user = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", username))
      .unique();
    // Always hash (even on unknown user) so response time doesn't leak existence.
    const candidate = await pbkdf2(args.password, user?.passwordSalt ?? "00");
    if (!user || !timingSafeEqual(candidate, user.passwordHash)) {
      throw new Error("Wrong username or password.");
    }
    const token = await createSession(ctx, user._id);
    return { token, user: publicUser(user) };
  },
});

export const me = query({
  args: { token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const user = await userForToken(ctx, args.token);
    return user ? publicUser(user) : null;
  },
});

export const signOut = mutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();
    if (session) await ctx.db.delete(session._id);
    return null;
  },
});
