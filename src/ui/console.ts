/**
 * Developer console — toggled with the § key.
 *
 * A command REGISTRY rather than a switch: `/help` prints whatever is
 * registered, so a command added later shows up in the listing for free and
 * cannot drift out of sync with the help text. main.ts registers the commands
 * it can service; this module knows nothing about the game.
 *
 * While the console is open it swallows keyboard input in the CAPTURE phase, so
 * typing "show" does not also make the hero strafe — core/input.ts listens on
 * window in the bubble phase and never sees the event.
 */

export interface ConsoleCommand {
  /** Name without the leading slash, e.g. 'show-colliders'. */
  name: string;
  /** One line, shown by /help. */
  help: string;
  /** Optional argument sketch for the help listing, e.g. '<on|off>'. */
  args?: string;
  /** Returns a line to print, or nothing. */
  run(args: string[]): string | void;
}

/**
 * Keys that open the console. `§` sits left of 1 on a Nordic layout, where the
 * physical key reports as Backquote on some layouts and IntlBackslash on
 * others, so match the produced CHARACTER as well as both codes — the character
 * is the thing the user actually pressed.
 */
const TOGGLE_CODES = new Set(['Backquote', 'IntlBackslash']);
const TOGGLE_CHARS = new Set(['§', '½', '`']);

const MAX_LINES = 200;

export class DevConsole {
  private root: HTMLDivElement;
  private log: HTMLDivElement;
  private input: HTMLInputElement;
  private commands = new Map<string, ConsoleCommand>();
  private history: string[] = [];
  private historyIdx = -1;
  private open = false;

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'cp-console';
    this.log = document.createElement('div');
    this.log.className = 'cp-console-log';
    this.input = document.createElement('input');
    this.input.className = 'cp-console-input';
    this.input.type = 'text';
    this.input.spellcheck = false;
    this.input.autocapitalize = 'off';
    this.input.setAttribute('autocomplete', 'off');
    this.input.placeholder = 'type /help';
    this.root.append(this.log, this.input);
    document.body.appendChild(this.root);
    this.root.style.display = 'none';

    // Capture phase: this runs before the game's own window listener, so an
    // open console eats the keystroke instead of sharing it with the hero.
    window.addEventListener('keydown', (e) => this.onKeyDown(e), true);

    this.register({
      name: 'help',
      help: 'List every command.',
      run: () => this.helpText(),
    });
    this.register({
      name: 'clear',
      help: 'Clear the console log.',
      run: () => { this.log.textContent = ''; },
    });

    this.print('Cube Pals console. § closes it, /help lists commands.');
  }

  /** Add a command. Later registrations of the same name replace earlier ones. */
  register(cmd: ConsoleCommand): void {
    this.commands.set(cmd.name, cmd);
  }

  get isOpen(): boolean { return this.open; }

  toggle(): void {
    this.open = !this.open;
    this.root.style.display = this.open ? 'flex' : 'none';
    if (this.open) {
      document.exitPointerLock?.();
      this.input.focus();
    } else {
      this.input.blur();
    }
  }

  print(line: string): void {
    const el = document.createElement('div');
    el.className = 'cp-console-line';
    el.textContent = line;
    this.log.appendChild(el);
    while (this.log.childElementCount > MAX_LINES) this.log.removeChild(this.log.firstChild!);
    this.log.scrollTop = this.log.scrollHeight;
  }

  private helpText(): string {
    // Sorted, and built from the registry so a new command needs no edit here.
    const names = [...this.commands.values()].sort((a, b) => a.name.localeCompare(b.name));
    const width = Math.max(...names.map((c) => c.name.length + (c.args ? c.args.length + 1 : 0)));
    return names
      .map((c) => {
        const sig = `/${c.name}${c.args ? ' ' + c.args : ''}`;
        return `${sig.padEnd(width + 2)}  ${c.help}`;
      })
      .join('\n');
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (TOGGLE_CHARS.has(e.key) || (TOGGLE_CODES.has(e.code) && !this.open)) {
      // Never let the toggle key reach the page or type itself into the field.
      e.preventDefault();
      e.stopPropagation();
      this.toggle();
      return;
    }
    if (!this.open) return;

    // Console owns the keyboard while it is open.
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      this.toggle();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.submit(this.input.value);
      this.input.value = '';
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (this.history.length === 0) return;
      this.historyIdx = e.key === 'ArrowUp'
        ? Math.max(0, this.historyIdx - 1)
        : Math.min(this.history.length, this.historyIdx + 1);
      this.input.value = this.history[this.historyIdx] ?? '';
    }
  }

  private submit(raw: string): void {
    const line = raw.trim();
    if (!line) return;
    this.history.push(line);
    this.historyIdx = this.history.length;
    this.print(`> ${line}`);

    // A leading slash is optional — typing `help` is the same as `/help`.
    const parts = line.replace(/^\//, '').split(/\s+/);
    const cmd = this.commands.get(parts[0]);
    if (!cmd) {
      this.print(`unknown command "${parts[0]}" — /help lists them`);
      return;
    }
    try {
      const out = cmd.run(parts.slice(1));
      if (out) this.print(out);
    } catch (err) {
      this.print(`error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  dispose(): void {
    this.root.remove();
  }
}
