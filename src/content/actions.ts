/**
 * WHAT CONTENT IS ALLOWED TO DO — the dispatcher for `Action` (spec §8.4).
 *
 * The mirror of conditions.ts: an action NAMES a registered handler and carries
 * its parameters flat beside it (`{ "do": "flag.set", "flag": "met-gain" }`), so
 * the set of things a piece of content can do to a save is exactly the set of
 * handlers the engine registered — a closed, inspectable list rather than
 * whatever a script could reach. An action list is the thing a reviewer reads to
 * know what a dialogue choice will do to their game, and it only tells them that
 * if it cannot do anything that is not written in it.
 *
 * A MALFORMED ACTION MUST NOT TAKE THE GAME DOWN (spec §21). Every handler
 * validates its own params and REPORTS rather than throws, and the runner keeps
 * going through the rest of the list. The reasoning is the asymmetry again: a
 * bad action in a remote pack that throws out of a click handler leaves the
 * player mid-dialogue with a dead UI and no way back, where one skipped action
 * is one thing that did not happen — recoverable, diagnosable, and visible in
 * `diagnostics()`. Throwing is reserved for a bug in the engine, and there are
 * none of those in this file.
 *
 * ORDER IS PART OF THE MEANING. A list runs front to back, and an action that
 * fails is SKIPPED rather than aborting the ones after it — the alternative
 * would make a typo in an early parameter silently swallow the quest completion
 * three lines below it, which is the worst of both: nothing happened, and
 * nothing said so loudly.
 */

import type { Action, ActionHandler, Diagnostic, EvalCtx, QuestStatus } from './types';
import { isId } from './ids';
import { isFlagName, isObjectiveName } from './state';

/**
 * How many action lists may be on the stack at once.
 *
 * Actions reach each other through STATE: `flag.set` notifies, a listener
 * re-evaluates availability, something becomes available and runs its own
 * `onEnter` actions, which set a flag. That is a legitimate and useful chain,
 * and it is also a cycle the moment two pieces of content each trigger the
 * other — with no cap, the first player to walk into it gets an unbounded
 * recursion and a frozen tab, and the stack trace names the dispatcher rather
 * than either piece of content that caused it.
 *
 * 8 rather than 2 because a chain of a few is real content design (an item
 * grants a flag, which completes an objective, which completes a quest, which
 * starts the next one), and rather than 64 because nothing past a handful is
 * design — it is a loop, and the sooner it is reported the closer the diagnostic
 * is to the content that caused it.
 */
const MAX_DEPTH = 8;

export class ActionDispatcher {
  private readonly handlers = new Map<string, ActionHandler>();
  private readonly diags: Diagnostic[] = [];
  private readonly reported = new Set<string>();
  private depth = 0;

  /** A later definition replaces an earlier one — see the note in conditions.ts. */
  define(name: string, fn: ActionHandler): void {
    this.handlers.set(name, fn);
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }

  /** Registered action names, sorted — for the validator and for `__dbgContent`. */
  get actionNames(): readonly string[] {
    return [...this.handlers.keys()].sort();
  }

  /**
   * Run a list in order. `undefined` and an empty list are both "nothing to do",
   * which is the common case — most content has no actions at all.
   */
  run(actions: readonly Action[] | undefined, ctx: EvalCtx): void {
    if (actions === undefined || actions.length === 0) return;
    if (this.depth >= MAX_DEPTH) {
      // Reported against the first action in the list, because that is the one
      // whose name identifies where the loop closes.
      this.reportOnce(`depth:${describe(actions[0])}`, {
        severity: 'error',
        code: 'action-recursion',
        message:
          `action lists nested ${MAX_DEPTH} deep at "${describe(actions[0])}"; ` +
          'stopped without running it',
        fix: 'two pieces of content are probably triggering each other through a flag',
      });
      return;
    }
    this.depth++;
    try {
      for (let i = 0; i < actions.length; i++) this.one(actions[i], ctx);
    } finally {
      // `finally` and not a plain decrement: a handler is engine code and may
      // legitimately throw on an engine bug, and a depth counter left high by
      // that throw would silently refuse every action for the rest of the
      // session — a second, worse failure that outlives the first.
      this.depth--;
    }
  }

  private one(action: unknown, ctx: EvalCtx): void {
    if (action === null || typeof action !== 'object') {
      this.reportOnce('shape', {
        severity: 'error',
        code: 'bad-action',
        message: 'an action must be an object with a `do` field',
      });
      return;
    }
    const name = (action as { do?: unknown }).do;
    if (typeof name !== 'string') {
      this.reportOnce('shape', {
        severity: 'error',
        code: 'bad-action',
        message: 'an action must be an object with a `do` field',
      });
      return;
    }
    const fn = this.handlers.get(name);
    if (fn === undefined) {
      this.reportOnce(`do:${name}`, {
        severity: 'error',
        code: 'unknown-action',
        message: `unknown action "${name}"; skipped`,
        field: 'do',
        fix: 'register it with defineAction(), or correct the spelling',
      });
      return;
    }
    fn(action as Readonly<Record<string, unknown>>, ctx);
  }

  /**
   * ONCE PER PROBLEM, keyed by what makes it distinct — the same discipline as
   * the evaluator, and needed for the same reason even though actions are rarer
   * than conditions: an action list attached to something a player can re-enter
   * (a dialogue node, a zone volume) runs again on every re-entry, so a
   * per-occurrence diagnostic grows with how long the session lasts rather than
   * with how much is wrong. Keyed this way, the list is bounded by the CONTENT,
   * which is finite.
   */
  private reportOnce(key: string, d: Diagnostic): void {
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.diags.push(d);
  }

  /** Handlers report through this, so a core action needs no privileged access. */
  report(d: Diagnostic): void {
    this.reportOnce(`${d.code}|${d.message}`, d);
  }

  diagnostics(): readonly Diagnostic[] {
    return this.diags;
  }

  clearDiagnostics(): void {
    this.diags.length = 0;
    this.reported.clear();
  }
}

/** A name for an action in a diagnostic, without trusting it to have one. */
function describe(action: unknown): string {
  if (action !== null && typeof action === 'object') {
    const name = (action as { do?: unknown }).do;
    if (typeof name === 'string') return name;
  }
  return '<malformed>';
}

// ---------------------------------------------------------------------------
// The shipped actions
// ---------------------------------------------------------------------------

/**
 * Each of these reports on a bad parameter and does nothing else.
 *
 * Unlike a condition test — which runs per frame and so must stay silent — an
 * action runs when something HAPPENED, at human rates, so it can afford to say
 * why it did nothing. That is the whole reason a bad action is worth reporting
 * here and a bad condition param is left to the load-time validator: this is the
 * only place that can tell you the action ran and was refused, as opposed to the
 * content never being reached at all.
 */
function bad(
  d: ActionDispatcher,
  name: string,
  field: string,
  message: string,
): void {
  d.report({
    severity: 'error',
    code: 'bad-action-param',
    message: `${name}: ${message}`,
    field,
    fix: 'correct the parameter in the authored content',
  });
}

/** `quest.start`/`complete`/`fail` are one handler shape with one status each. */
function questSetter(d: ActionDispatcher, name: string, status: QuestStatus): ActionHandler {
  return (params, ctx) => {
    const quest = params.quest;
    if (typeof quest !== 'string' || !isId(quest)) {
      bad(d, name, 'quest', 'needs a `quest` id like "quest:first-steps"');
      return;
    }
    ctx.state.setQuestStatus(quest, status);
  };
}

/**
 * The actions every package may assume exists.
 *
 * NAMING IS `<subject>.<verb>`, and it is a namespace rather than decoration:
 * `flag.set` / `flag.clear` sit next to each other in a sorted list of
 * registered names, an editor can group its palette by the part before the dot,
 * and a pack that adds its own is expected to claim a subject rather than a
 * bare verb. `discover` is the exception and is deliberately not `discovery.add`
 * — there is exactly one thing to do to a discovery, and a namespace with one
 * member is a longer name for nothing.
 */
export function registerCoreActions(d: ActionDispatcher): void {
  /**
   * `{ do: "flag.set", flag: "met-gain" }` — set a world flag.
   *
   * `value: false` is accepted so a generated action (an editor's toggle row,
   * a table-driven import) has one shape to emit; `flag.clear` is the spelling
   * a human writes.
   */
  d.define('flag.set', (params, ctx) => {
    const flag = params.flag;
    if (!isFlagName(flag)) {
      bad(d, 'flag.set', 'flag', 'needs a `flag` name (printable, no spaces)');
      return;
    }
    const value = params.value;
    if (value !== undefined && typeof value !== 'boolean') {
      bad(d, 'flag.set', 'value', '`value` must be true or false when present');
      return;
    }
    ctx.state.setFlag(flag, value ?? true);
  });

  /** `{ do: "flag.clear", flag: "met-gain" }` — clear it. Cleared is ABSENT. */
  d.define('flag.clear', (params, ctx) => {
    const flag = params.flag;
    if (!isFlagName(flag)) {
      bad(d, 'flag.clear', 'flag', 'needs a `flag` name (printable, no spaces)');
      return;
    }
    ctx.state.setFlag(flag, false);
  });

  /** `{ do: "quest.start", quest: "quest:first-steps" }` — status `active`. */
  d.define('quest.start', questSetter(d, 'quest.start', 'active'));
  /** `{ do: "quest.complete", quest: "quest:first-steps" }` — status `completed`. */
  d.define('quest.complete', questSetter(d, 'quest.complete', 'completed'));
  /** `{ do: "quest.fail", quest: "quest:first-steps" }` — status `failed`. */
  d.define('quest.fail', questSetter(d, 'quest.fail', 'failed'));

  /**
   * `{ do: "progress.add", quest: "quest:cull", objective: "gloopling", by: 1 }`
   * — advance an objective counter.
   *
   * ADD RATHER THAN SET, and that is the interesting decision here. A counter is
   * incremented from a place that knows one thing happened (an enemy died, an
   * item was handed over) and does not know the total; making content compute
   * `n + 1` would mean content reading state to write it, which is a
   * read-modify-write every re-entrant trigger gets wrong. `by` defaults to 1
   * and may be negative — an escort that loses a follower counts down — and the
   * store's own floor of 0 keeps that from going below nothing.
   */
  d.define('progress.add', (params, ctx) => {
    const quest = params.quest;
    const objective = params.objective;
    if (typeof quest !== 'string' || !isId(quest)) {
      bad(d, 'progress.add', 'quest', 'needs a `quest` id like "quest:cull"');
      return;
    }
    if (!isObjectiveName(objective)) {
      bad(d, 'progress.add', 'objective', 'needs an `objective` name with no "/" in it');
      return;
    }
    const by = params.by;
    if (by !== undefined && (typeof by !== 'number' || !Number.isFinite(by))) {
      bad(d, 'progress.add', 'by', '`by` must be a finite number when present');
      return;
    }
    ctx.state.setProgress(quest, objective, ctx.state.progress(quest, objective) + (by ?? 1));
  });

  /** `{ do: "discover", id: "town:stonewatch" }` — mark a place as found. */
  d.define('discover', (params, ctx) => {
    const id = params.id;
    if (typeof id !== 'string' || !isId(id)) {
      bad(d, 'discover', 'id', 'needs an `id` like "town:stonewatch"');
      return;
    }
    ctx.state.discover(id);
  });
}
