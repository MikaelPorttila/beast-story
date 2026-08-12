/**
 * Developer console — toggled with §. main.ts registers the commands. While open
 * it swallows keys in the CAPTURE phase, so typing does not also drive the hero
 * (core/input.ts listens on window in the bubble phase).
 */

export interface ConsoleCommand {
  /** Name without the leading slash, e.g. 'show-colliders'. */
  name: string;
  help: string;
  /** Argument sketch, e.g. '<on|off>'. */
  args?: string;
  run(args: string[]): string | void;
}

/** `§` reports as Backquote or IntlBackslash, so match the character too. */
const TOGGLE_CODES = new Set(["Backquote", "IntlBackslash"]);
const TOGGLE_CHARS = new Set(["§", "½", "`"]);

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
    this.root = document.createElement("div");
    this.root.className = "bs-console";
    this.log = document.createElement("div");
    this.log.className = "bs-console-log";
    this.input = document.createElement("input");
    this.input.className = "bs-console-input";
    this.input.type = "text";
    this.input.spellcheck = false;
    this.input.autocapitalize = "off";
    this.input.setAttribute("autocomplete", "off");
    this.input.placeholder = "type /help";
    this.root.append(this.log, this.input);
    document.body.appendChild(this.root);
    this.root.style.display = "none";

    // Capture: runs before the game's own window listener.
    window.addEventListener("keydown", (e) => this.onKeyDown(e), true);

    this.register({
      name: "help",
      help: "List every command.",
      run: () => this.helpText(),
    });
    this.register({
      name: "clear",
      help: "Clear the console log.",
      run: () => {
        this.log.textContent = "";
      },
    });

    this.print("Beast Story console. § closes it, /help lists commands.");
  }

  /** Later registrations of the same name replace earlier ones. */
  register(cmd: ConsoleCommand): void {
    this.commands.set(cmd.name, cmd);
  }

  get isOpen(): boolean {
    return this.open;
  }

  toggle(): void {
    this.open = !this.open;
    this.root.style.display = this.open ? "flex" : "none";
    if (this.open) {
      document.exitPointerLock?.();
      this.input.focus();
    } else {
      this.input.blur();
    }
  }

  print(line: string): void {
    const el = document.createElement("div");
    el.className = "bs-console-line";
    el.textContent = line;
    this.log.appendChild(el);
    while (this.log.childElementCount > MAX_LINES) {
      this.log.removeChild(this.log.firstChild!);
    }
    this.log.scrollTop = this.log.scrollHeight;
  }

  private helpText(): string {
    const names = [...this.commands.values()].sort((a, b) => a.name.localeCompare(b.name));
    const width = Math.max(...names.map((c) => c.name.length + (c.args ? c.args.length + 1 : 0)));
    return names
      .map((c) => {
        const sig = `/${c.name}${c.args ? " " + c.args : ""}`;
        return `${sig.padEnd(width + 2)}  ${c.help}`;
      })
      .join("\n");
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (TOGGLE_CHARS.has(e.key) || (TOGGLE_CODES.has(e.code) && !this.open)) {
      e.preventDefault();
      e.stopPropagation();
      this.toggle();
      return;
    }
    if (!this.open) {
      return;
    }

    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      this.toggle();
    } else if (e.key === "Enter") {
      e.preventDefault();
      this.submit(this.input.value);
      this.input.value = "";
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      if (this.history.length === 0) {
        return;
      }
      this.historyIdx =
        e.key === "ArrowUp"
          ? Math.max(0, this.historyIdx - 1)
          : Math.min(this.history.length, this.historyIdx + 1);
      this.input.value = this.history[this.historyIdx] ?? "";
    }
  }

  private submit(raw: string): void {
    const line = raw.trim();
    if (!line) {
      return;
    }
    this.history.push(line);
    this.historyIdx = this.history.length;
    this.print(`> ${line}`);

    const parts = line.replace(/^\//, "").split(/\s+/);
    const cmd = this.commands.get(parts[0]);
    if (!cmd) {
      this.print(`unknown command "${parts[0]}" — /help lists them`);
      return;
    }
    try {
      const out = cmd.run(parts.slice(1));
      if (out) {
        this.print(out);
      }
    } catch (err) {
      this.print(`error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  dispose(): void {
    this.root.remove();
  }
}
