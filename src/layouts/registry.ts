/**
 * Turning the generated declaration tables into laid-out C aggregates.
 *
 * Resolution is lazy and memoised: asking for `WGPURenderPipelineDescriptor` lays out
 * `WGPUStringView`, `WGPUVertexState`, `WGPUPrimitiveState` and `WGPUMultisampleState` on the way
 * (because they are held by value), caches all of them, and never does it again. Laziness is not an
 * optimisation here — it is what lets the generated tables be emitted in header order without the
 * generator having to topologically sort anything, which is one fewer thing that can be subtly
 * wrong.
 *
 * A by-value cycle is impossible in C (a struct cannot contain itself), so hitting one means the
 * table is corrupt; the resolver says so with the full path rather than overflowing the stack.
 */

import {
  ABI_64,
  assertHost64Bit,
  assertLittleEndian,
  assertNoWiderThanModel,
  layoutStruct,
  layoutUnion,
  scalarType,
  type CScalarTag,
  type ICAbiModel,
  type ICAggregateLayout,
  type ICField,
  type ICMemberInput,
} from "./cabi.ts";
import { isAggregateTag, splitMemberDecl } from "./decls.ts";
import { ALL_AGGREGATES, isUnion, type AggregateName } from "./generated/index.ts";

export type { ICAggregateLayout, ICField } from "./cabi.ts";
export type { AggregateName } from "./generated/index.ts";

/**
 * A resolver bound to one ABI model.
 *
 * Exported as a class rather than only as module-level functions so the oracle test can lay the same
 * tables out under a hypothetical second model and compare — the model is a parameter of the
 * derivation, not a global truth.
 */
export class LayoutRegistry {
  private readonly cache = new Map<string, ICAggregateLayout>();
  private readonly inProgress = new Set<string>();

  constructor(
    readonly model: ICAbiModel,
    private readonly decls: Readonly<Record<string, readonly string[]>> = ALL_AGGREGATES,
    private readonly unionTest: (name: string) => boolean = isUnion,
  ) {
    const seen = new Set<string>();
    for (const name of Object.keys(decls)) {
      if (seen.has(name)) throw new Error(`Duplicate aggregate "${name}" in the generated tables.`);
      seen.add(name);
    }
  }

  /** Every aggregate name the tables define, in declaration order. */
  names(): string[] {
    return Object.keys(this.decls);
  }

  /**
   * Lay out one aggregate, resolving nested by-value members first.
   *
   * @throws when the name is unknown, when a member's tag is unknown, or on a by-value cycle.
   */
  layout(name: string): ICAggregateLayout {
    const cached = this.cache.get(name);
    if (cached) return cached;

    const decl = this.decls[name];
    if (!decl) {
      throw new Error(
        `Unknown C aggregate "${name}". It is not in the generated tables — either the spelling is ` +
          `wrong, or the pinned headers do not define it (they define ${this.names().length}).`,
      );
    }
    if (this.inProgress.has(name)) {
      throw new Error(
        `By-value cycle reaching "${name}" via ${[...this.inProgress].join(" -> ")}. A C struct ` +
          `cannot contain itself, so the generated table is inconsistent.`,
      );
    }
    this.inProgress.add(name);
    try {
      const members: ICMemberInput[] = decl.map((entry) => {
        const { name: member, tag } = splitMemberDecl(entry);
        if (isAggregateTag(tag)) {
          const nested = this.layout(tag.slice(1));
          return {
            name: member,
            tag,
            type: { size: nested.size, align: nested.align },
            aggregate: nested.name,
          };
        }
        return {
          name: member,
          tag,
          type: scalarType(assertScalarTag(tag, `${name}.${member}`), this.model),
          aggregate: null,
        };
      });
      const built = this.unionTest(name)
        ? layoutUnion(name, members)
        : layoutStruct(name, members);
      assertNoWiderThanModel(built, this.model);
      this.cache.set(name, built);
      return built;
    } finally {
      this.inProgress.delete(name);
    }
  }

  /** Lay out every aggregate in the tables. Used by the oracle so nothing goes unchecked. */
  layoutAll(): ICAggregateLayout[] {
    return this.names().map((n) => this.layout(n));
  }
}

const SCALAR_TAGS: ReadonlySet<string> = new Set<CScalarTag>([
  "i8",
  "u8",
  "i16",
  "u16",
  "i32",
  "u32",
  "i64",
  "u64",
  "f32",
  "f64",
  "usize",
  "ptr",
  "bool32",
  "enum32",
  "flags64",
]);

function assertScalarTag(tag: string, where: string): CScalarTag {
  if (SCALAR_TAGS.has(tag)) return tag as CScalarTag;
  throw new Error(
    `${where}: unknown C-ABI tag "${tag}". Regenerate with \`bun run scripts/gen-layouts.ts\`; if it ` +
      `persists, the generator emitted a tag \`cabi.ts\` does not model.`,
  );
}

/**
 * The registry every consumer uses: the generated tables under the 64-bit C ABI.
 *
 * The host check runs once, here, at first import. Every supported RID — `win32-x64`, `linux-x64`,
 * `linux-arm64`, `darwin-x64`, `darwin-arm64` — produces *identical* layouts, because every member
 * of both headers is either a fixed-width `<stdint.h>` scalar, a `float`/`double`, an enum, a
 * pointer, a `size_t`, or an aggregate of those. Nothing is a `long`, a `long double`, a bitfield or
 * an array, and those are the only places Win64 (LLP64) and the Unix targets (LP64) disagree.
 *
 * What is *not* invariant is 32-bit, and it fails here rather than silently producing half-width
 * pointers.
 */
export const registry = /* @__PURE__ */ (() => {
  assertHost64Bit();
  assertLittleEndian();
  return new LayoutRegistry(ABI_64);
})();

/** Layout of one aggregate under the shipped model. */
export function layoutOf(name: AggregateName | (string & {})): ICAggregateLayout {
  return registry.layout(name);
}

/** `sizeof(<name>)` — also the correct stride for an array of them. */
export function sizeOf(name: AggregateName | (string & {})): number {
  return registry.layout(name).size;
}

/** `_Alignof(<name>)`. */
export function alignOf(name: AggregateName | (string & {})): number {
  return registry.layout(name).align;
}

/**
 * One member's laid-out description.
 *
 * @throws when the member does not exist — a typo names a member, never an offset, so this cannot
 * degrade into writing at 0.
 */
export function fieldOf(name: AggregateName | (string & {}), member: string): ICField {
  const layout = registry.layout(name);
  const field = layout.byName.get(member);
  if (!field) {
    throw new Error(
      `${name} has no member "${member}". It has: ${layout.fields.map((f) => f.name).join(", ")}.`,
    );
  }
  return field;
}
