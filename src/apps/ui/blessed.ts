import { createRequire } from "node:module";
import type * as Blessed from "neo-neo-bblessed";

const require = createRequire(import.meta.url);
const blessed = require("neo-neo-bblessed") as typeof Blessed;

export const {
	box,
	escape,
	line,
	list,
	log,
	program,
	screen,
	scrollablebox,
	scrollabletext,
} = blessed;

// neo-neo-bblessed rebinds `this.__listener = this._listener.bind(this)` on
// every readInput() call, orphaning the previously-bound keypress handler so it
// can never be removeListener()'d. When that stale handler later fires (after
// _done has been deleted by submit/cancel/blur), `_listener` runs with
// `this._done === undefined` and the first `done(null, null)` (e.g. on escape)
// throws "done is not a function", crashing the whole TUI. A textbox only ever
// has its `__listener` attached while it is actively reading, so short-circuit
// `_listener` whenever `_reading` is false — that is exactly the orphaned case.
const rawTextbox = blessed.textbox as (
	...args: unknown[]
) => Blessed.TextboxInterface;
export const textbox: typeof blessed.textbox = ((...args: unknown[]) => {
	const instance = rawTextbox(...args) as Blessed.TextboxInterface & {
		_reading?: boolean;
		_listener?: (ch: unknown, key: unknown) => unknown;
	};
	const original = instance._listener?.bind(instance);
	if (original) {
		instance._listener = function guardedListener(ch: unknown, key: unknown) {
			if (!this._reading) return;
			return original(ch, key);
		};
	}
	return instance;
}) as typeof blessed.textbox;

export type {
	BoxInterface,
	ElementInterface,
	LineInterface,
	ListInterface,
	ProgramInterface,
	ScreenInterface,
	ScreenOptions,
	ScrollableTextInterface,
	TextboxInterface,
} from "neo-neo-bblessed";
