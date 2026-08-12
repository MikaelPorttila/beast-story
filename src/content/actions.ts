// Dispatcher for `Action`, the mirror of conditions.ts.
// A malformed action REPORTS and is skipped, never thrown out of: a dead UI
// mid-dialogue is unrecoverable where one skipped action is not.
// A list runs front to back, and a failure does not abort the ones after it.

import type { Action, ActionHandler, Diagnostic, EvalCtx, QuestStatus } from './types';
import { isId } from './ids';
import { isFlagName, isObjectiveName } from './state';

// Actions chain through STATE (set a flag -> something becomes available -> its
// own actions run), so two pieces of content can trigger each other forever.
// 8 leaves room for a real chain and reports a loop close to its cause.
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

  get actionNames(): readonly string[] {
    return [...this.handlers.keys()].sort();
  }

  /** `undefined` and empty are both "nothing to do" — the common case. */
  run(actions: readonly Action[] | undefined, ctx: EvalCtx): void {
    if (actions === undefined || actions.length === 0) return;
    if (this.depth >= MAX_DEPTH) {
      // Named for the first action: that is where the loop closes.
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
      // `finally`: a throwing handler must not leave the counter high and refuse
      // every action for the rest of the session.
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

  // Once per problem: re-entrant content re-runs its list, so a per-occurrence
  // diagnostic would grow with session length instead of with what is wrong.
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

function describe(action: unknown): string {
  if (action !== null && typeof action === 'object') {
    const name = (action as { do?: unknown }).do;
    if (typeof name === 'string') return name;
  }
  return '<malformed>';
}

// Shipped actions. Unlike a condition test these run at human rates, so they can
// afford to report why they did nothing.
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

// Names are `<subject>.<verb>`: a namespace, so a sorted list and an editor palette
// group. `discover` stands alone — a namespace with one member buys nothing.
export function registerCoreActions(d: ActionDispatcher): void {
  /** `value: false` is accepted so generated actions have one shape to emit. */
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

  d.define('flag.clear', (params, ctx) => {
    const flag = params.flag;
    if (!isFlagName(flag)) {
      bad(d, 'flag.clear', 'flag', 'needs a `flag` name (printable, no spaces)');
      return;
    }
    ctx.state.setFlag(flag, false);
  });

  d.define('quest.start', questSetter(d, 'quest.start', 'active'));
  d.define('quest.complete', questSetter(d, 'quest.complete', 'completed'));
  d.define('quest.fail', questSetter(d, 'quest.fail', 'failed'));

  // ADD, not set: the caller knows one thing happened, not the total. `by` defaults
  // to 1 and may be negative; the store's floor of 0 catches the rest.
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

  d.define('discover', (params, ctx) => {
    const id = params.id;
    if (typeof id !== 'string' || !isId(id)) {
      bad(d, 'discover', 'id', 'needs an `id` like "town:stonewatch"');
      return;
    }
    ctx.state.discover(id);
  });
}
