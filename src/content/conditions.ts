/**
 * DECLARATIVE AVAILABILITY — the evaluator for `Condition` (spec §8.3).
 *
 * Three combinators (`all`, `any`, `not`) over one leaf, and the leaf NAMES a
 * registered test rather than carrying code: `{ "test": "flag", "flag":
 * "met-gain" }`. That is content/types.ts §4.6's line — remote JSON selects
 * behaviour, it never supplies it — and it is what makes a condition something a
 * validator can check, an editor can render as a form and a reviewer can read.
 *
 * THIS IS CALLED FROM UI PATHS AND MAY RUN PER FRAME. "Is there a prompt over
 * this NPC", "does this shop row appear", "is this quest offerable" are all
 * `evaluate` calls, and the query layer asks the same question of every loaded
 * asset of a type. So the whole hot path is allocation-free: THE LEAF NODE IS
 * ITSELF THE PARAMS RECORD (it is `{test} & Record<string, unknown>`, so it is
 * handed to the test as-is rather than copied into a params object), the
 * combinators walk their children with an indexed loop rather than `for…of`
 * (which builds an iterator per array), and recursion carries its depth as an
 * argument rather than as a stack of frames anyone has to allocate. Nothing in
 * here builds an object, an array or a closure on a path that answers true or
 * false. Diagnostics allocate — and they are once-per-problem, below.
 *
 * FALSE IS THE ANSWER TO EVERY QUESTION IT CANNOT ANSWER: an unknown test, a
 * malformed node, a recursion cap. The `Condition` doc comment states why, and
 * it is worth restating because the instinct is the other way: the failure modes
 * are NOT symmetric. Content hidden by a misspelled test is a quest nobody can
 * find — a bug report. Content REVEALED by a misspelled test is a spoiler, a
 * boss the player meets twenty levels early, or a soft-lock, and the player
 * cannot un-see it. Fail toward the recoverable one.
 */

import type { Condition, ConditionTest, Diagnostic, EvalCtx, QuestStatus } from './types';
import { isId } from './ids';
import { isFlagName, isObjectiveName, isQuestStatus } from './state';

/**
 * How deep a condition tree may nest.
 *
 * A cap rather than trust, because a condition may arrive in a remote pack
 * (spec §22) and JSON nests as deep as it likes: without one, a hand-written
 * `{"not":{"not":{"not":…}}}` ten thousand deep is a stack overflow inside a
 * frame, which is a crash rather than a piece of broken content. 32 is far past
 * anything an author writes by hand — the deepest shipped condition is 3 — and
 * far short of any engine's stack.
 */
const MAX_DEPTH = 32;

/** How the untrusted node is READ. Every field is unknown until it is checked. */
interface CondView {
  readonly all?: unknown;
  readonly any?: unknown;
  readonly not?: unknown;
  readonly test?: unknown;
}

export class ConditionEvaluator {
  private readonly tests = new Map<string, ConditionTest>();
  private readonly diags: Diagnostic[] = [];
  /** Keys already reported. See `reportOnce`. */
  private readonly reported = new Set<string>();
  /**
   * A REFUSAL TO ANSWER, which is not the same thing as the answer false — and
   * the difference is a hole big enough to walk content through.
   *
   * The depth cap and a node that is not a condition at all are refusals: the
   * evaluator did not evaluate anything. Returned as a plain false they are
   * INVERTIBLE, so `{"not": <33 levels of nesting>}` comes back TRUE and the
   * cheapest way to make any gated content appear is to nest garbage until the
   * guard fires. Measured on the first version of this file: a 40-deep `not`
   * chain evaluated true. So a refusal latches for the whole walk and
   * `evaluate` answers false whatever the tree above it did with the value.
   *
   * An unknown TEST is deliberately NOT one of these. Content naming a test
   * this build does not register may be perfectly valid content — a pack
   * written against a newer engine — and the contract in types.ts fixes its
   * value at false, `not` and all. That is an answer, and it composes.
   */
  private aborted = false;

  /**
   * Register a test. A later definition of the same name REPLACES the earlier
   * one, deliberately: that is how a debug tool or a test stubs `quest` without
   * a second registry, and a duplicate registration inside the engine is a
   * programming error a diagnostic here would only hide.
   */
  define(name: string, fn: ConditionTest): void {
    this.tests.set(name, fn);
  }

  has(name: string): boolean {
    return this.tests.has(name);
  }

  /** Registered test names, sorted — for the validator and for `__dbgContent`. */
  get testNames(): readonly string[] {
    return [...this.tests.keys()].sort();
  }

  /**
   * `undefined` MEANS ALWAYS AVAILABLE. An asset with no `when` is the common
   * case by a wide margin (a town, an enemy, most NPCs), so the alternative —
   * making every author write `{"test":"always"}` — would be ceremony on the
   * majority to serve the minority.
   */
  evaluate(when: Condition | undefined, ctx: EvalCtx): boolean {
    if (when === undefined) return true;
    this.aborted = false;
    const value = this.node(when, ctx, 0);
    return this.aborted ? false : value;
  }

  private node(node: unknown, ctx: EvalCtx, depth: number): boolean {
    if (this.aborted) return false;   // the walk is over; do not run more tests
    if (depth > MAX_DEPTH) {
      this.aborted = true;
      this.reportOnce('depth', {
        severity: 'error',
        code: 'condition-too-deep',
        message: `condition nested deeper than ${MAX_DEPTH}; evaluated as false`,
        fix: 'flatten the condition — nesting this deep is almost always generated by accident',
      });
      return false;
    }
    if (node === null || typeof node !== 'object') {
      return this.badShape();
    }
    const c = node as CondView;

    // Leaf first: it is the overwhelmingly common node, and every combinator
    // bottoms out in one.
    if (typeof c.test === 'string') return this.leaf(c.test, node, ctx);

    if (c.all !== undefined) {
      // AN EMPTY `all` IS TRUE. Vacuous truth — "every one of these zero
      // requirements is met" — and it is the empty case a hand-rolled evaluator
      // usually gets backwards. It has to be this way round for the identity to
      // hold: adding a requirement to a list may only ever make availability
      // narrower, so the list with nothing in it is the widest one there is.
      // A generated condition (an editor's empty group, a filter that matched
      // nothing) therefore behaves like no condition at all rather than
      // silently hiding the asset it is attached to.
      if (!Array.isArray(c.all)) return this.badList('all');
      for (let i = 0; i < c.all.length; i++) {
        if (!this.node(c.all[i], ctx, depth + 1)) return false;
      }
      return true;
    }

    if (c.any !== undefined) {
      // AN EMPTY `any` IS FALSE, and by the mirror of the same argument: adding
      // an alternative may only ever make availability wider, so the list with
      // no alternatives in it is the narrowest — there is no way in. The pair
      // matters more than either alone: get one of them wrong and content that
      // composes them inverts somewhere in the middle of a tree, where nothing
      // points at the node that did it.
      if (!Array.isArray(c.any)) return this.badList('any');
      for (let i = 0; i < c.any.length; i++) {
        if (this.node(c.any[i], ctx, depth + 1)) return true;
      }
      return false;
    }

    if (c.not !== undefined) return !this.node(c.not, ctx, depth + 1);

    return this.badShape();
  }

  private badShape(): boolean {
    this.aborted = true;
    this.reportOnce('shape', {
      severity: 'error',
      code: 'bad-condition',
      message: 'a condition must be an object with `all`, `any`, `not` or `test`',
    });
    return false;
  }

  private leaf(name: string, params: unknown, ctx: EvalCtx): boolean {
    const fn = this.tests.get(name);
    if (fn === undefined) {
      // ONCE PER NAME, not once per evaluation. This runs from availability
      // checks that may fire every frame for every loaded asset, so a
      // diagnostic per call is an array that grows without bound until the tab
      // dies — a memory leak whose cause is the error reporting. The name is
      // what identifies the problem; the thousandth occurrence adds nothing.
      this.reportOnce(`test:${name}`, {
        severity: 'error',
        code: 'unknown-test',
        message: `unknown condition test "${name}"; evaluated as false`,
        field: 'when.test',
        fix: 'register it with defineTest(), or correct the spelling',
      });
      return false;
    }
    return fn(params as Readonly<Record<string, unknown>>, ctx);
  }

  /**
   * FALSE for both, and NOT the empty-list answer for the key involved. An
   * empty `all` is true because the author said "no requirements"; a MALFORMED
   * `all` is an author who said something unreadable, so it is a REFUSAL (see
   * `aborted`) and not an answer — a broken condition hides content rather than
   * revealing it, whatever is wrapped around it.
   */
  private badList(key: 'all' | 'any'): boolean {
    this.aborted = true;
    this.reportOnce(`list:${key}`, {
      severity: 'error',
      code: 'bad-condition',
      message: `\`${key}\` must be an array of conditions; evaluated as false`,
      field: `when.${key}`,
    });
    return false;
  }

  private reportOnce(key: string, d: Diagnostic): void {
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.diags.push(d);
  }

  diagnostics(): readonly Diagnostic[] {
    return this.diags;
  }

  /**
   * Clears the once-per-problem memory along with the list. Keeping it would
   * mean a problem reported before a clear could never be reported again, which
   * makes "load a pack, clear, load another" silently lose the second pack's
   * findings.
   */
  clearDiagnostics(): void {
    this.diags.length = 0;
    this.reported.clear();
  }
}

// ---------------------------------------------------------------------------
// The shipped tests
// ---------------------------------------------------------------------------

/**
 * A TEST WITH BAD PARAMS RETURNS FALSE AND REPORTS NOTHING, and that division of
 * labour is deliberate. These functions run per frame, so they have no bounded
 * way to complain — the once-per-name trick above works for a test NAME, of
 * which there are finitely many, and not for "quest id 3 fields down in this
 * asset". Authoring mistakes belong to the load-time validator, which sees every
 * condition in a package exactly once, knows which asset and which field it is
 * looking at, and can say so. Here the only job is to answer safely.
 */

function pStr(params: Readonly<Record<string, unknown>>, key: string): string | null {
  const v = params[key];
  return typeof v === 'string' ? v : null;
}

function pBool(params: Readonly<Record<string, unknown>>, key: string, dflt: boolean): boolean {
  const v = params[key];
  return typeof v === 'boolean' ? v : dflt;
}

function pNum(params: Readonly<Record<string, unknown>>, key: string, dflt: number): number {
  const v = params[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

/**
 * The tests every package may assume exists.
 *
 * NOTE WHAT IS NOT HERE: `all-of` and `any-of`. Composition is the CONDITION's
 * shape (`{"all":[…]}`, `{"any":[…]}`), not a test name — the evaluator has to
 * understand nesting anyway to walk it, and a second spelling of the same idea
 * would mean two ways to write one tree, two things for a validator to check
 * and two things for an editor to render. If you find yourself reaching for
 * `{"test":"all-of"}`, the shape you want is `{"all":[…]}`.
 */
export function registerCoreTests(ev: ConditionEvaluator): void {
  /**
   * `{ test: "flag", flag: "met-gain" }` — is a world flag set?
   *
   * `value` (default true) is what makes the negative case readable inline:
   * `{ "test": "flag", "flag": "met-gain", "value": false }` says "has not met
   * Gain" without a `not` wrapper around it. Both spellings work and mean the
   * same thing; this one reads better in a list of prerequisites.
   */
  ev.define('flag', (params, ctx) => {
    const name = pStr(params, 'flag');
    if (name === null || !isFlagName(name)) return false;
    return ctx.state.flag(name) === pBool(params, 'value', true);
  });

  /**
   * `{ test: "quest", quest: "quest:first-steps", status: "completed" }` — is a
   * quest in exactly this state?
   *
   * Exact rather than "at least": the statuses are not a ladder (`failed` is not
   * further along than `active`), so an ordering comparison would have to invent
   * one. A quest that is either active or completed is `{"any":[…]}` of two of
   * these, which says what it means.
   */
  ev.define('quest', (params, ctx) => {
    const quest = pStr(params, 'quest');
    const status = params.status;
    if (quest === null || !isId(quest) || !isQuestStatus(status)) return false;
    return ctx.state.questStatus(quest) === (status as QuestStatus);
  });

  /**
   * `{ test: "discovered", id: "town:stonewatch" }` — has the player found this?
   *
   * Deliberately does NOT check that the id names loaded content: a landmark in
   * a zone pack that is not resident right now was still discovered, and
   * answering false because the pack is unloaded would make availability depend
   * on where the player is standing.
   */
  ev.define('discovered', (params, ctx) => {
    const id = pStr(params, 'id');
    if (id === null || !isId(id)) return false;
    return ctx.state.discovered(id);
  });

  /**
   * `{ test: "progress", quest: "quest:cull", objective: "gloopling", atLeast: 5 }`
   * — has an objective counter reached a threshold?
   *
   * `atLeast` defaults to 1, i.e. "has this been touched at all", which is the
   * common case for a boolean-shaped objective and saves authoring the 1.
   */
  ev.define('progress', (params, ctx) => {
    const quest = pStr(params, 'quest');
    const objective = pStr(params, 'objective');
    if (quest === null || objective === null) return false;
    if (!isId(quest) || !isObjectiveName(objective)) return false;
    return ctx.state.progress(quest, objective) >= pNum(params, 'atLeast', 1);
  });

  /**
   * `always` and `never` exist for the TOOLS rather than for the content.
   *
   * A validator needs a condition it knows the answer to in order to test the
   * evaluator itself; an editor creating a new gated asset needs a placeholder
   * that is valid, obviously a stub, and does not have to be filled in before
   * the asset will load. Without them the stub is a misspelled test, which is
   * false AND an error — indistinguishable from the mistake it is imitating.
   * `never` is also the honest way to disable a piece of content in place while
   * keeping it, its refs and its diagnostics in the graph.
   */
  ev.define('always', () => true);
  ev.define('never', () => false);
}
