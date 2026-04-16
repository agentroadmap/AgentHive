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
	textbox,
} = blessed;

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
