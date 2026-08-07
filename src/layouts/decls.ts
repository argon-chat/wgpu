/**
 * The declaration DSL that `scripts/gen-layouts.ts` emits and the registry consumes.
 *
 * A generated declaration is a plain object of `"<member>:<tag>"` strings:
 *
 * ```ts
 * export const WEBGPU_STRUCTS = {
 *   WGPUStringView: ["data:ptr", "length:usize"],
 *   WGPUBufferDescriptor: ["nextInChain:ptr", "label:@WGPUStringView", "usage:flags64", "size:u64",
 *                          "mappedAtCreation:bool32"],
 * } as const;
 * ```
 *
 * Strings rather than objects, for three reasons that all pull the same way:
 *
 *  - **No numbers can appear.** The emitted file is structurally incapable of carrying an offset, so
 *    "the generator hand-counted something" is not a failure mode that exists.
 *  - **The member names survive into the type system.** TypeScript can take
 *    `"data:ptr" | "length:usize"` apart with template-literal inference, so `view.setPtr("lenght")`
 *    is a compile error and `setU32` on a pointer member is too. That is the whole reason the
 *    accessor API can be described as "callable without ever seeing a number" — the alternative,
 *    string keys checked only at runtime, moves typos to the GPU.
 *  - **It diffs legibly.** A version bump shows as `+"viewFormatCount:usize"` on one line rather than
 *    as a wall of re-indented objects.
 *
 * Nested aggregates passed by value are written `@Name`; everything else is a
 * {@link import("./cabi.ts").CScalarTag}. Pointer members are all just `ptr` — what they point *at*
 * is the caller's business and deliberately not encoded here, because encoding it would tempt this
 * layer into owning allocation, which it must not.
 */

import type { CScalarTag } from "./cabi.ts";

/** A member's declared type: a scalar tag, or `@Name` for an aggregate held by value. */
export type CMemberTag = CScalarTag | `@${string}`;

/** One member declaration, `"<name>:<tag>"`. */
export type CMemberDecl = `${string}:${CMemberTag}`;

/** A map of aggregate name to its declaration-order members. */
export type CAggregateDecls = Readonly<Record<string, readonly CMemberDecl[]>>;

/**
 * Split a `"<name>:<tag>"` declaration.
 *
 * The split is on the **first** colon, not the last: a synthesised inline aggregate is named
 * `Parent::member`, so `"data:@WGPUNativeDisplayHandle::data"` is a perfectly ordinary declaration
 * whose tag happens to contain colons. Member names never do.
 *
 * @throws on a malformed declaration rather than guessing at a split point.
 */
export function splitMemberDecl(decl: string): { name: string; tag: string } {
  const colon = decl.indexOf(":");
  if (colon <= 0 || colon === decl.length - 1) {
    throw new Error(`Malformed member declaration "${decl}" — expected "<name>:<tag>".`);
  }
  return { name: decl.slice(0, colon), tag: decl.slice(colon + 1) };
}

/** `true` when a tag names an aggregate held by value. */
export function isAggregateTag(tag: string): tag is `@${string}` {
  return tag.charCodeAt(0) === 64; // '@'
}

/* ── Type-level projections ─────────────────────────────────────────────────────────────────────
 *
 * These are what make the accessor API safe. `MemberNames<D>` is every member of an aggregate;
 * `MembersOfTag<D, T>` narrows to members of one type, so `setU32` accepts only the `u32` members.
 * Both distribute over the union of declaration strings, which is why the helpers take a naked type
 * parameter — that is the only form TypeScript distributes.
 */

/** The member name of a single declaration string. */
export type MemberNameOf<D> = D extends `${infer N}:${string}` ? N : never;

/** The tag of a single declaration string. */
export type MemberTagOf<D> = D extends `${string}:${infer T}` ? T : never;

/** Every member name declared by an aggregate. */
export type MemberNames<D extends readonly string[]> = MemberNameOf<D[number]>;

/** Member names of an aggregate whose tag matches `T` (which may itself be a union or pattern). */
export type MembersOfTag<D extends readonly string[], T extends string> = D[number] extends infer S
  ? S extends `${infer N}:${T}`
    ? N
    : never
  : never;

/** Member names holding a nested aggregate by value. */
export type AggregateMembers<D extends readonly string[]> = MembersOfTag<D, `@${string}`>;

/** The aggregate named by member `M` of `D` — e.g. `"WGPUStringView"` for `"label:@WGPUStringView"`. */
export type AggregateOf<D extends readonly string[], M extends string> = D[number] extends infer S
  ? S extends `${M}:@${infer A}`
    ? A
    : never
  : never;
