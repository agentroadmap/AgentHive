#!/usr/bin/env node
import { createRequire } from "node:module";
var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toESMCache_node;
var __toESMCache_esm;
var __toESM = (mod, isNodeMode, target) => {
  var canCache = mod != null && typeof mod === "object";
  if (canCache) {
    var cache = isNodeMode ? __toESMCache_node ??= new WeakMap : __toESMCache_esm ??= new WeakMap;
    var cached = cache.get(mod);
    if (cached)
      return cached;
  }
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  for (let key of __getOwnPropNames(mod))
    if (!__hasOwnProp.call(to, key))
      __defProp(to, key, {
        get: __accessProp.bind(mod, key),
        enumerable: true
      });
  if (canCache)
    cache.set(mod, to);
  return to;
};
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};
var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// node_modules/picocolors/picocolors.js
var require_picocolors = __commonJS((exports, module) => {
  var p = process || {};
  var argv = p.argv || [];
  var env = p.env || {};
  var isColorSupported = !(!!env.NO_COLOR || argv.includes("--no-color")) && (!!env.FORCE_COLOR || argv.includes("--color") || p.platform === "win32" || (p.stdout || {}).isTTY && env.TERM !== "dumb" || !!env.CI);
  var formatter = (open, close, replace = open) => (input) => {
    let string = "" + input, index = string.indexOf(close, open.length);
    return ~index ? open + replaceClose(string, close, replace, index) + close : open + string + close;
  };
  var replaceClose = (string, close, replace, index) => {
    let result = "", cursor = 0;
    do {
      result += string.substring(cursor, index) + replace;
      cursor = index + close.length;
      index = string.indexOf(close, cursor);
    } while (~index);
    return result + string.substring(cursor);
  };
  var createColors = (enabled = isColorSupported) => {
    let f = enabled ? formatter : () => String;
    return {
      isColorSupported: enabled,
      reset: f("\x1B[0m", "\x1B[0m"),
      bold: f("\x1B[1m", "\x1B[22m", "\x1B[22m\x1B[1m"),
      dim: f("\x1B[2m", "\x1B[22m", "\x1B[22m\x1B[2m"),
      italic: f("\x1B[3m", "\x1B[23m"),
      underline: f("\x1B[4m", "\x1B[24m"),
      inverse: f("\x1B[7m", "\x1B[27m"),
      hidden: f("\x1B[8m", "\x1B[28m"),
      strikethrough: f("\x1B[9m", "\x1B[29m"),
      black: f("\x1B[30m", "\x1B[39m"),
      red: f("\x1B[31m", "\x1B[39m"),
      green: f("\x1B[32m", "\x1B[39m"),
      yellow: f("\x1B[33m", "\x1B[39m"),
      blue: f("\x1B[34m", "\x1B[39m"),
      magenta: f("\x1B[35m", "\x1B[39m"),
      cyan: f("\x1B[36m", "\x1B[39m"),
      white: f("\x1B[37m", "\x1B[39m"),
      gray: f("\x1B[90m", "\x1B[39m"),
      bgBlack: f("\x1B[40m", "\x1B[49m"),
      bgRed: f("\x1B[41m", "\x1B[49m"),
      bgGreen: f("\x1B[42m", "\x1B[49m"),
      bgYellow: f("\x1B[43m", "\x1B[49m"),
      bgBlue: f("\x1B[44m", "\x1B[49m"),
      bgMagenta: f("\x1B[45m", "\x1B[49m"),
      bgCyan: f("\x1B[46m", "\x1B[49m"),
      bgWhite: f("\x1B[47m", "\x1B[49m"),
      blackBright: f("\x1B[90m", "\x1B[39m"),
      redBright: f("\x1B[91m", "\x1B[39m"),
      greenBright: f("\x1B[92m", "\x1B[39m"),
      yellowBright: f("\x1B[93m", "\x1B[39m"),
      blueBright: f("\x1B[94m", "\x1B[39m"),
      magentaBright: f("\x1B[95m", "\x1B[39m"),
      cyanBright: f("\x1B[96m", "\x1B[39m"),
      whiteBright: f("\x1B[97m", "\x1B[39m"),
      bgBlackBright: f("\x1B[100m", "\x1B[49m"),
      bgRedBright: f("\x1B[101m", "\x1B[49m"),
      bgGreenBright: f("\x1B[102m", "\x1B[49m"),
      bgYellowBright: f("\x1B[103m", "\x1B[49m"),
      bgBlueBright: f("\x1B[104m", "\x1B[49m"),
      bgMagentaBright: f("\x1B[105m", "\x1B[49m"),
      bgCyanBright: f("\x1B[106m", "\x1B[49m"),
      bgWhiteBright: f("\x1B[107m", "\x1B[49m")
    };
  };
  module.exports = createColors();
  module.exports.createColors = createColors;
});

// node_modules/sisteransi/src/index.js
var require_src = __commonJS((exports, module) => {
  var ESC = "\x1B";
  var CSI = `${ESC}[`;
  var beep = "\x07";
  var cursor = {
    to(x, y) {
      if (!y)
        return `${CSI}${x + 1}G`;
      return `${CSI}${y + 1};${x + 1}H`;
    },
    move(x, y) {
      let ret = "";
      if (x < 0)
        ret += `${CSI}${-x}D`;
      else if (x > 0)
        ret += `${CSI}${x}C`;
      if (y < 0)
        ret += `${CSI}${-y}A`;
      else if (y > 0)
        ret += `${CSI}${y}B`;
      return ret;
    },
    up: (count = 1) => `${CSI}${count}A`,
    down: (count = 1) => `${CSI}${count}B`,
    forward: (count = 1) => `${CSI}${count}C`,
    backward: (count = 1) => `${CSI}${count}D`,
    nextLine: (count = 1) => `${CSI}E`.repeat(count),
    prevLine: (count = 1) => `${CSI}F`.repeat(count),
    left: `${CSI}G`,
    hide: `${CSI}?25l`,
    show: `${CSI}?25h`,
    save: `${ESC}7`,
    restore: `${ESC}8`
  };
  var scroll = {
    up: (count = 1) => `${CSI}S`.repeat(count),
    down: (count = 1) => `${CSI}T`.repeat(count)
  };
  var erase = {
    screen: `${CSI}2J`,
    up: (count = 1) => `${CSI}1J`.repeat(count),
    down: (count = 1) => `${CSI}J`.repeat(count),
    line: `${CSI}2K`,
    lineEnd: `${CSI}K`,
    lineStart: `${CSI}1K`,
    lines(count) {
      let clear = "";
      for (let i = 0;i < count; i++)
        clear += this.line + (i < count - 1 ? cursor.up() : "");
      if (count)
        clear += cursor.left;
      return clear;
    }
  };
  module.exports = { cursor, scroll, erase, beep };
});

// node_modules/commander/lib/error.js
var require_error = __commonJS((exports) => {
  class CommanderError extends Error {
    constructor(exitCode, code, message) {
      super(message);
      Error.captureStackTrace(this, this.constructor);
      this.name = this.constructor.name;
      this.code = code;
      this.exitCode = exitCode;
      this.nestedError = undefined;
    }
  }

  class InvalidArgumentError extends CommanderError {
    constructor(message) {
      super(1, "commander.invalidArgument", message);
      Error.captureStackTrace(this, this.constructor);
      this.name = this.constructor.name;
    }
  }
  exports.CommanderError = CommanderError;
  exports.InvalidArgumentError = InvalidArgumentError;
});

// node_modules/commander/lib/argument.js
var require_argument = __commonJS((exports) => {
  var { InvalidArgumentError } = require_error();

  class Argument {
    constructor(name, description) {
      this.description = description || "";
      this.variadic = false;
      this.parseArg = undefined;
      this.defaultValue = undefined;
      this.defaultValueDescription = undefined;
      this.argChoices = undefined;
      switch (name[0]) {
        case "<":
          this.required = true;
          this._name = name.slice(1, -1);
          break;
        case "[":
          this.required = false;
          this._name = name.slice(1, -1);
          break;
        default:
          this.required = true;
          this._name = name;
          break;
      }
      if (this._name.endsWith("...")) {
        this.variadic = true;
        this._name = this._name.slice(0, -3);
      }
    }
    name() {
      return this._name;
    }
    _collectValue(value, previous) {
      if (previous === this.defaultValue || !Array.isArray(previous)) {
        return [value];
      }
      previous.push(value);
      return previous;
    }
    default(value, description) {
      this.defaultValue = value;
      this.defaultValueDescription = description;
      return this;
    }
    argParser(fn) {
      this.parseArg = fn;
      return this;
    }
    choices(values) {
      this.argChoices = values.slice();
      this.parseArg = (arg, previous) => {
        if (!this.argChoices.includes(arg)) {
          throw new InvalidArgumentError(`Allowed choices are ${this.argChoices.join(", ")}.`);
        }
        if (this.variadic) {
          return this._collectValue(arg, previous);
        }
        return arg;
      };
      return this;
    }
    argRequired() {
      this.required = true;
      return this;
    }
    argOptional() {
      this.required = false;
      return this;
    }
  }
  function humanReadableArgName(arg) {
    const nameOutput = arg.name() + (arg.variadic === true ? "..." : "");
    return arg.required ? "<" + nameOutput + ">" : "[" + nameOutput + "]";
  }
  exports.Argument = Argument;
  exports.humanReadableArgName = humanReadableArgName;
});

// node_modules/commander/lib/help.js
var require_help = __commonJS((exports) => {
  var { humanReadableArgName } = require_argument();

  class Help {
    constructor() {
      this.helpWidth = undefined;
      this.minWidthToWrap = 40;
      this.sortSubcommands = false;
      this.sortOptions = false;
      this.showGlobalOptions = false;
    }
    prepareContext(contextOptions) {
      this.helpWidth = this.helpWidth ?? contextOptions.helpWidth ?? 80;
    }
    visibleCommands(cmd) {
      const visibleCommands = cmd.commands.filter((cmd2) => !cmd2._hidden);
      const helpCommand = cmd._getHelpCommand();
      if (helpCommand && !helpCommand._hidden) {
        visibleCommands.push(helpCommand);
      }
      if (this.sortSubcommands) {
        visibleCommands.sort((a, b) => {
          return a.name().localeCompare(b.name());
        });
      }
      return visibleCommands;
    }
    compareOptions(a, b) {
      const getSortKey = (option) => {
        return option.short ? option.short.replace(/^-/, "") : option.long.replace(/^--/, "");
      };
      return getSortKey(a).localeCompare(getSortKey(b));
    }
    visibleOptions(cmd) {
      const visibleOptions = cmd.options.filter((option) => !option.hidden);
      const helpOption = cmd._getHelpOption();
      if (helpOption && !helpOption.hidden) {
        const removeShort = helpOption.short && cmd._findOption(helpOption.short);
        const removeLong = helpOption.long && cmd._findOption(helpOption.long);
        if (!removeShort && !removeLong) {
          visibleOptions.push(helpOption);
        } else if (helpOption.long && !removeLong) {
          visibleOptions.push(cmd.createOption(helpOption.long, helpOption.description));
        } else if (helpOption.short && !removeShort) {
          visibleOptions.push(cmd.createOption(helpOption.short, helpOption.description));
        }
      }
      if (this.sortOptions) {
        visibleOptions.sort(this.compareOptions);
      }
      return visibleOptions;
    }
    visibleGlobalOptions(cmd) {
      if (!this.showGlobalOptions)
        return [];
      const globalOptions = [];
      for (let ancestorCmd = cmd.parent;ancestorCmd; ancestorCmd = ancestorCmd.parent) {
        const visibleOptions = ancestorCmd.options.filter((option) => !option.hidden);
        globalOptions.push(...visibleOptions);
      }
      if (this.sortOptions) {
        globalOptions.sort(this.compareOptions);
      }
      return globalOptions;
    }
    visibleArguments(cmd) {
      if (cmd._argsDescription) {
        cmd.registeredArguments.forEach((argument) => {
          argument.description = argument.description || cmd._argsDescription[argument.name()] || "";
        });
      }
      if (cmd.registeredArguments.find((argument) => argument.description)) {
        return cmd.registeredArguments;
      }
      return [];
    }
    subcommandTerm(cmd) {
      const args = cmd.registeredArguments.map((arg) => humanReadableArgName(arg)).join(" ");
      return cmd._name + (cmd._aliases[0] ? "|" + cmd._aliases[0] : "") + (cmd.options.length ? " [options]" : "") + (args ? " " + args : "");
    }
    optionTerm(option) {
      return option.flags;
    }
    argumentTerm(argument) {
      return argument.name();
    }
    longestSubcommandTermLength(cmd, helper) {
      return helper.visibleCommands(cmd).reduce((max, command) => {
        return Math.max(max, this.displayWidth(helper.styleSubcommandTerm(helper.subcommandTerm(command))));
      }, 0);
    }
    longestOptionTermLength(cmd, helper) {
      return helper.visibleOptions(cmd).reduce((max, option) => {
        return Math.max(max, this.displayWidth(helper.styleOptionTerm(helper.optionTerm(option))));
      }, 0);
    }
    longestGlobalOptionTermLength(cmd, helper) {
      return helper.visibleGlobalOptions(cmd).reduce((max, option) => {
        return Math.max(max, this.displayWidth(helper.styleOptionTerm(helper.optionTerm(option))));
      }, 0);
    }
    longestArgumentTermLength(cmd, helper) {
      return helper.visibleArguments(cmd).reduce((max, argument) => {
        return Math.max(max, this.displayWidth(helper.styleArgumentTerm(helper.argumentTerm(argument))));
      }, 0);
    }
    commandUsage(cmd) {
      let cmdName = cmd._name;
      if (cmd._aliases[0]) {
        cmdName = cmdName + "|" + cmd._aliases[0];
      }
      let ancestorCmdNames = "";
      for (let ancestorCmd = cmd.parent;ancestorCmd; ancestorCmd = ancestorCmd.parent) {
        ancestorCmdNames = ancestorCmd.name() + " " + ancestorCmdNames;
      }
      return ancestorCmdNames + cmdName + " " + cmd.usage();
    }
    commandDescription(cmd) {
      return cmd.description();
    }
    subcommandDescription(cmd) {
      return cmd.summary() || cmd.description();
    }
    optionDescription(option) {
      const extraInfo = [];
      if (option.argChoices) {
        extraInfo.push(`choices: ${option.argChoices.map((choice) => JSON.stringify(choice)).join(", ")}`);
      }
      if (option.defaultValue !== undefined) {
        const showDefault = option.required || option.optional || option.isBoolean() && typeof option.defaultValue === "boolean";
        if (showDefault) {
          extraInfo.push(`default: ${option.defaultValueDescription || JSON.stringify(option.defaultValue)}`);
        }
      }
      if (option.presetArg !== undefined && option.optional) {
        extraInfo.push(`preset: ${JSON.stringify(option.presetArg)}`);
      }
      if (option.envVar !== undefined) {
        extraInfo.push(`env: ${option.envVar}`);
      }
      if (extraInfo.length > 0) {
        const extraDescription = `(${extraInfo.join(", ")})`;
        if (option.description) {
          return `${option.description} ${extraDescription}`;
        }
        return extraDescription;
      }
      return option.description;
    }
    argumentDescription(argument) {
      const extraInfo = [];
      if (argument.argChoices) {
        extraInfo.push(`choices: ${argument.argChoices.map((choice) => JSON.stringify(choice)).join(", ")}`);
      }
      if (argument.defaultValue !== undefined) {
        extraInfo.push(`default: ${argument.defaultValueDescription || JSON.stringify(argument.defaultValue)}`);
      }
      if (extraInfo.length > 0) {
        const extraDescription = `(${extraInfo.join(", ")})`;
        if (argument.description) {
          return `${argument.description} ${extraDescription}`;
        }
        return extraDescription;
      }
      return argument.description;
    }
    formatItemList(heading, items, helper) {
      if (items.length === 0)
        return [];
      return [helper.styleTitle(heading), ...items, ""];
    }
    groupItems(unsortedItems, visibleItems, getGroup) {
      const result = new Map;
      unsortedItems.forEach((item) => {
        const group = getGroup(item);
        if (!result.has(group))
          result.set(group, []);
      });
      visibleItems.forEach((item) => {
        const group = getGroup(item);
        if (!result.has(group)) {
          result.set(group, []);
        }
        result.get(group).push(item);
      });
      return result;
    }
    formatHelp(cmd, helper) {
      const termWidth = helper.padWidth(cmd, helper);
      const helpWidth = helper.helpWidth ?? 80;
      function callFormatItem(term, description) {
        return helper.formatItem(term, termWidth, description, helper);
      }
      let output = [
        `${helper.styleTitle("Usage:")} ${helper.styleUsage(helper.commandUsage(cmd))}`,
        ""
      ];
      const commandDescription = helper.commandDescription(cmd);
      if (commandDescription.length > 0) {
        output = output.concat([
          helper.boxWrap(helper.styleCommandDescription(commandDescription), helpWidth),
          ""
        ]);
      }
      const argumentList = helper.visibleArguments(cmd).map((argument) => {
        return callFormatItem(helper.styleArgumentTerm(helper.argumentTerm(argument)), helper.styleArgumentDescription(helper.argumentDescription(argument)));
      });
      output = output.concat(this.formatItemList("Arguments:", argumentList, helper));
      const optionGroups = this.groupItems(cmd.options, helper.visibleOptions(cmd), (option) => option.helpGroupHeading ?? "Options:");
      optionGroups.forEach((options, group) => {
        const optionList = options.map((option) => {
          return callFormatItem(helper.styleOptionTerm(helper.optionTerm(option)), helper.styleOptionDescription(helper.optionDescription(option)));
        });
        output = output.concat(this.formatItemList(group, optionList, helper));
      });
      if (helper.showGlobalOptions) {
        const globalOptionList = helper.visibleGlobalOptions(cmd).map((option) => {
          return callFormatItem(helper.styleOptionTerm(helper.optionTerm(option)), helper.styleOptionDescription(helper.optionDescription(option)));
        });
        output = output.concat(this.formatItemList("Global Options:", globalOptionList, helper));
      }
      const commandGroups = this.groupItems(cmd.commands, helper.visibleCommands(cmd), (sub) => sub.helpGroup() || "Commands:");
      commandGroups.forEach((commands, group) => {
        const commandList = commands.map((sub) => {
          return callFormatItem(helper.styleSubcommandTerm(helper.subcommandTerm(sub)), helper.styleSubcommandDescription(helper.subcommandDescription(sub)));
        });
        output = output.concat(this.formatItemList(group, commandList, helper));
      });
      return output.join(`
`);
    }
    displayWidth(str) {
      return stripColor(str).length;
    }
    styleTitle(str) {
      return str;
    }
    styleUsage(str) {
      return str.split(" ").map((word) => {
        if (word === "[options]")
          return this.styleOptionText(word);
        if (word === "[command]")
          return this.styleSubcommandText(word);
        if (word[0] === "[" || word[0] === "<")
          return this.styleArgumentText(word);
        return this.styleCommandText(word);
      }).join(" ");
    }
    styleCommandDescription(str) {
      return this.styleDescriptionText(str);
    }
    styleOptionDescription(str) {
      return this.styleDescriptionText(str);
    }
    styleSubcommandDescription(str) {
      return this.styleDescriptionText(str);
    }
    styleArgumentDescription(str) {
      return this.styleDescriptionText(str);
    }
    styleDescriptionText(str) {
      return str;
    }
    styleOptionTerm(str) {
      return this.styleOptionText(str);
    }
    styleSubcommandTerm(str) {
      return str.split(" ").map((word) => {
        if (word === "[options]")
          return this.styleOptionText(word);
        if (word[0] === "[" || word[0] === "<")
          return this.styleArgumentText(word);
        return this.styleSubcommandText(word);
      }).join(" ");
    }
    styleArgumentTerm(str) {
      return this.styleArgumentText(str);
    }
    styleOptionText(str) {
      return str;
    }
    styleArgumentText(str) {
      return str;
    }
    styleSubcommandText(str) {
      return str;
    }
    styleCommandText(str) {
      return str;
    }
    padWidth(cmd, helper) {
      return Math.max(helper.longestOptionTermLength(cmd, helper), helper.longestGlobalOptionTermLength(cmd, helper), helper.longestSubcommandTermLength(cmd, helper), helper.longestArgumentTermLength(cmd, helper));
    }
    preformatted(str) {
      return /\n[^\S\r\n]/.test(str);
    }
    formatItem(term, termWidth, description, helper) {
      const itemIndent = 2;
      const itemIndentStr = " ".repeat(itemIndent);
      if (!description)
        return itemIndentStr + term;
      const paddedTerm = term.padEnd(termWidth + term.length - helper.displayWidth(term));
      const spacerWidth = 2;
      const helpWidth = this.helpWidth ?? 80;
      const remainingWidth = helpWidth - termWidth - spacerWidth - itemIndent;
      let formattedDescription;
      if (remainingWidth < this.minWidthToWrap || helper.preformatted(description)) {
        formattedDescription = description;
      } else {
        const wrappedDescription = helper.boxWrap(description, remainingWidth);
        formattedDescription = wrappedDescription.replace(/\n/g, `
` + " ".repeat(termWidth + spacerWidth));
      }
      return itemIndentStr + paddedTerm + " ".repeat(spacerWidth) + formattedDescription.replace(/\n/g, `
${itemIndentStr}`);
    }
    boxWrap(str, width) {
      if (width < this.minWidthToWrap)
        return str;
      const rawLines = str.split(/\r\n|\n/);
      const chunkPattern = /[\s]*[^\s]+/g;
      const wrappedLines = [];
      rawLines.forEach((line) => {
        const chunks = line.match(chunkPattern);
        if (chunks === null) {
          wrappedLines.push("");
          return;
        }
        let sumChunks = [chunks.shift()];
        let sumWidth = this.displayWidth(sumChunks[0]);
        chunks.forEach((chunk) => {
          const visibleWidth = this.displayWidth(chunk);
          if (sumWidth + visibleWidth <= width) {
            sumChunks.push(chunk);
            sumWidth += visibleWidth;
            return;
          }
          wrappedLines.push(sumChunks.join(""));
          const nextChunk = chunk.trimStart();
          sumChunks = [nextChunk];
          sumWidth = this.displayWidth(nextChunk);
        });
        wrappedLines.push(sumChunks.join(""));
      });
      return wrappedLines.join(`
`);
    }
  }
  function stripColor(str) {
    const sgrPattern = /\x1b\[\d*(;\d*)*m/g;
    return str.replace(sgrPattern, "");
  }
  exports.Help = Help;
  exports.stripColor = stripColor;
});

// node_modules/commander/lib/option.js
var require_option = __commonJS((exports) => {
  var { InvalidArgumentError } = require_error();

  class Option {
    constructor(flags, description) {
      this.flags = flags;
      this.description = description || "";
      this.required = flags.includes("<");
      this.optional = flags.includes("[");
      this.variadic = /\w\.\.\.[>\]]$/.test(flags);
      this.mandatory = false;
      const optionFlags = splitOptionFlags(flags);
      this.short = optionFlags.shortFlag;
      this.long = optionFlags.longFlag;
      this.negate = false;
      if (this.long) {
        this.negate = this.long.startsWith("--no-");
      }
      this.defaultValue = undefined;
      this.defaultValueDescription = undefined;
      this.presetArg = undefined;
      this.envVar = undefined;
      this.parseArg = undefined;
      this.hidden = false;
      this.argChoices = undefined;
      this.conflictsWith = [];
      this.implied = undefined;
      this.helpGroupHeading = undefined;
    }
    default(value, description) {
      this.defaultValue = value;
      this.defaultValueDescription = description;
      return this;
    }
    preset(arg) {
      this.presetArg = arg;
      return this;
    }
    conflicts(names) {
      this.conflictsWith = this.conflictsWith.concat(names);
      return this;
    }
    implies(impliedOptionValues) {
      let newImplied = impliedOptionValues;
      if (typeof impliedOptionValues === "string") {
        newImplied = { [impliedOptionValues]: true };
      }
      this.implied = Object.assign(this.implied || {}, newImplied);
      return this;
    }
    env(name) {
      this.envVar = name;
      return this;
    }
    argParser(fn) {
      this.parseArg = fn;
      return this;
    }
    makeOptionMandatory(mandatory = true) {
      this.mandatory = !!mandatory;
      return this;
    }
    hideHelp(hide = true) {
      this.hidden = !!hide;
      return this;
    }
    _collectValue(value, previous) {
      if (previous === this.defaultValue || !Array.isArray(previous)) {
        return [value];
      }
      previous.push(value);
      return previous;
    }
    choices(values) {
      this.argChoices = values.slice();
      this.parseArg = (arg, previous) => {
        if (!this.argChoices.includes(arg)) {
          throw new InvalidArgumentError(`Allowed choices are ${this.argChoices.join(", ")}.`);
        }
        if (this.variadic) {
          return this._collectValue(arg, previous);
        }
        return arg;
      };
      return this;
    }
    name() {
      if (this.long) {
        return this.long.replace(/^--/, "");
      }
      return this.short.replace(/^-/, "");
    }
    attributeName() {
      if (this.negate) {
        return camelcase(this.name().replace(/^no-/, ""));
      }
      return camelcase(this.name());
    }
    helpGroup(heading) {
      this.helpGroupHeading = heading;
      return this;
    }
    is(arg) {
      return this.short === arg || this.long === arg;
    }
    isBoolean() {
      return !this.required && !this.optional && !this.negate;
    }
  }

  class DualOptions {
    constructor(options) {
      this.positiveOptions = new Map;
      this.negativeOptions = new Map;
      this.dualOptions = new Set;
      options.forEach((option) => {
        if (option.negate) {
          this.negativeOptions.set(option.attributeName(), option);
        } else {
          this.positiveOptions.set(option.attributeName(), option);
        }
      });
      this.negativeOptions.forEach((value, key) => {
        if (this.positiveOptions.has(key)) {
          this.dualOptions.add(key);
        }
      });
    }
    valueFromOption(value, option) {
      const optionKey = option.attributeName();
      if (!this.dualOptions.has(optionKey))
        return true;
      const preset = this.negativeOptions.get(optionKey).presetArg;
      const negativeValue = preset !== undefined ? preset : false;
      return option.negate === (negativeValue === value);
    }
  }
  function camelcase(str) {
    return str.split("-").reduce((str2, word) => {
      return str2 + word[0].toUpperCase() + word.slice(1);
    });
  }
  function splitOptionFlags(flags) {
    let shortFlag;
    let longFlag;
    const shortFlagExp = /^-[^-]$/;
    const longFlagExp = /^--[^-]/;
    const flagParts = flags.split(/[ |,]+/).concat("guard");
    if (shortFlagExp.test(flagParts[0]))
      shortFlag = flagParts.shift();
    if (longFlagExp.test(flagParts[0]))
      longFlag = flagParts.shift();
    if (!shortFlag && shortFlagExp.test(flagParts[0]))
      shortFlag = flagParts.shift();
    if (!shortFlag && longFlagExp.test(flagParts[0])) {
      shortFlag = longFlag;
      longFlag = flagParts.shift();
    }
    if (flagParts[0].startsWith("-")) {
      const unsupportedFlag = flagParts[0];
      const baseError = `option creation failed due to '${unsupportedFlag}' in option flags '${flags}'`;
      if (/^-[^-][^-]/.test(unsupportedFlag))
        throw new Error(`${baseError}
- a short flag is a single dash and a single character
  - either use a single dash and a single character (for a short flag)
  - or use a double dash for a long option (and can have two, like '--ws, --workspace')`);
      if (shortFlagExp.test(unsupportedFlag))
        throw new Error(`${baseError}
- too many short flags`);
      if (longFlagExp.test(unsupportedFlag))
        throw new Error(`${baseError}
- too many long flags`);
      throw new Error(`${baseError}
- unrecognised flag format`);
    }
    if (shortFlag === undefined && longFlag === undefined)
      throw new Error(`option creation failed due to no flags found in '${flags}'.`);
    return { shortFlag, longFlag };
  }
  exports.Option = Option;
  exports.DualOptions = DualOptions;
});

// node_modules/commander/lib/suggestSimilar.js
var require_suggestSimilar = __commonJS((exports) => {
  var maxDistance = 3;
  function editDistance(a, b) {
    if (Math.abs(a.length - b.length) > maxDistance)
      return Math.max(a.length, b.length);
    const d2 = [];
    for (let i = 0;i <= a.length; i++) {
      d2[i] = [i];
    }
    for (let j2 = 0;j2 <= b.length; j2++) {
      d2[0][j2] = j2;
    }
    for (let j2 = 1;j2 <= b.length; j2++) {
      for (let i = 1;i <= a.length; i++) {
        let cost = 1;
        if (a[i - 1] === b[j2 - 1]) {
          cost = 0;
        } else {
          cost = 1;
        }
        d2[i][j2] = Math.min(d2[i - 1][j2] + 1, d2[i][j2 - 1] + 1, d2[i - 1][j2 - 1] + cost);
        if (i > 1 && j2 > 1 && a[i - 1] === b[j2 - 2] && a[i - 2] === b[j2 - 1]) {
          d2[i][j2] = Math.min(d2[i][j2], d2[i - 2][j2 - 2] + 1);
        }
      }
    }
    return d2[a.length][b.length];
  }
  function suggestSimilar(word, candidates) {
    if (!candidates || candidates.length === 0)
      return "";
    candidates = Array.from(new Set(candidates));
    const searchingOptions = word.startsWith("--");
    if (searchingOptions) {
      word = word.slice(2);
      candidates = candidates.map((candidate) => candidate.slice(2));
    }
    let similar = [];
    let bestDistance = maxDistance;
    const minSimilarity = 0.4;
    candidates.forEach((candidate) => {
      if (candidate.length <= 1)
        return;
      const distance = editDistance(word, candidate);
      const length = Math.max(word.length, candidate.length);
      const similarity = (length - distance) / length;
      if (similarity > minSimilarity) {
        if (distance < bestDistance) {
          bestDistance = distance;
          similar = [candidate];
        } else if (distance === bestDistance) {
          similar.push(candidate);
        }
      }
    });
    similar.sort((a, b) => a.localeCompare(b));
    if (searchingOptions) {
      similar = similar.map((candidate) => `--${candidate}`);
    }
    if (similar.length > 1) {
      return `
(Did you mean one of ${similar.join(", ")}?)`;
    }
    if (similar.length === 1) {
      return `
(Did you mean ${similar[0]}?)`;
    }
    return "";
  }
  exports.suggestSimilar = suggestSimilar;
});

// node_modules/commander/lib/command.js
var require_command = __commonJS((exports) => {
  var EventEmitter = __require("node:events").EventEmitter;
  var childProcess = __require("node:child_process");
  var path = __require("node:path");
  var fs = __require("node:fs");
  var process2 = __require("node:process");
  var { Argument, humanReadableArgName } = require_argument();
  var { CommanderError } = require_error();
  var { Help, stripColor } = require_help();
  var { Option, DualOptions } = require_option();
  var { suggestSimilar } = require_suggestSimilar();

  class Command extends EventEmitter {
    constructor(name) {
      super();
      this.commands = [];
      this.options = [];
      this.parent = null;
      this._allowUnknownOption = false;
      this._allowExcessArguments = false;
      this.registeredArguments = [];
      this._args = this.registeredArguments;
      this.args = [];
      this.rawArgs = [];
      this.processedArgs = [];
      this._scriptPath = null;
      this._name = name || "";
      this._optionValues = {};
      this._optionValueSources = {};
      this._storeOptionsAsProperties = false;
      this._actionHandler = null;
      this._executableHandler = false;
      this._executableFile = null;
      this._executableDir = null;
      this._defaultCommandName = null;
      this._exitCallback = null;
      this._aliases = [];
      this._combineFlagAndOptionalValue = true;
      this._description = "";
      this._summary = "";
      this._argsDescription = undefined;
      this._enablePositionalOptions = false;
      this._passThroughOptions = false;
      this._lifeCycleHooks = {};
      this._showHelpAfterError = false;
      this._showSuggestionAfterError = true;
      this._savedState = null;
      this._outputConfiguration = {
        writeOut: (str) => process2.stdout.write(str),
        writeErr: (str) => process2.stderr.write(str),
        outputError: (str, write) => write(str),
        getOutHelpWidth: () => process2.stdout.isTTY ? process2.stdout.columns : undefined,
        getErrHelpWidth: () => process2.stderr.isTTY ? process2.stderr.columns : undefined,
        getOutHasColors: () => useColor() ?? (process2.stdout.isTTY && process2.stdout.hasColors?.()),
        getErrHasColors: () => useColor() ?? (process2.stderr.isTTY && process2.stderr.hasColors?.()),
        stripColor: (str) => stripColor(str)
      };
      this._hidden = false;
      this._helpOption = undefined;
      this._addImplicitHelpCommand = undefined;
      this._helpCommand = undefined;
      this._helpConfiguration = {};
      this._helpGroupHeading = undefined;
      this._defaultCommandGroup = undefined;
      this._defaultOptionGroup = undefined;
    }
    copyInheritedSettings(sourceCommand) {
      this._outputConfiguration = sourceCommand._outputConfiguration;
      this._helpOption = sourceCommand._helpOption;
      this._helpCommand = sourceCommand._helpCommand;
      this._helpConfiguration = sourceCommand._helpConfiguration;
      this._exitCallback = sourceCommand._exitCallback;
      this._storeOptionsAsProperties = sourceCommand._storeOptionsAsProperties;
      this._combineFlagAndOptionalValue = sourceCommand._combineFlagAndOptionalValue;
      this._allowExcessArguments = sourceCommand._allowExcessArguments;
      this._enablePositionalOptions = sourceCommand._enablePositionalOptions;
      this._showHelpAfterError = sourceCommand._showHelpAfterError;
      this._showSuggestionAfterError = sourceCommand._showSuggestionAfterError;
      return this;
    }
    _getCommandAndAncestors() {
      const result = [];
      for (let command = this;command; command = command.parent) {
        result.push(command);
      }
      return result;
    }
    command(nameAndArgs, actionOptsOrExecDesc, execOpts) {
      let desc = actionOptsOrExecDesc;
      let opts = execOpts;
      if (typeof desc === "object" && desc !== null) {
        opts = desc;
        desc = null;
      }
      opts = opts || {};
      const [, name, args] = nameAndArgs.match(/([^ ]+) *(.*)/);
      const cmd = this.createCommand(name);
      if (desc) {
        cmd.description(desc);
        cmd._executableHandler = true;
      }
      if (opts.isDefault)
        this._defaultCommandName = cmd._name;
      cmd._hidden = !!(opts.noHelp || opts.hidden);
      cmd._executableFile = opts.executableFile || null;
      if (args)
        cmd.arguments(args);
      this._registerCommand(cmd);
      cmd.parent = this;
      cmd.copyInheritedSettings(this);
      if (desc)
        return this;
      return cmd;
    }
    createCommand(name) {
      return new Command(name);
    }
    createHelp() {
      return Object.assign(new Help, this.configureHelp());
    }
    configureHelp(configuration) {
      if (configuration === undefined)
        return this._helpConfiguration;
      this._helpConfiguration = configuration;
      return this;
    }
    configureOutput(configuration) {
      if (configuration === undefined)
        return this._outputConfiguration;
      this._outputConfiguration = {
        ...this._outputConfiguration,
        ...configuration
      };
      return this;
    }
    showHelpAfterError(displayHelp = true) {
      if (typeof displayHelp !== "string")
        displayHelp = !!displayHelp;
      this._showHelpAfterError = displayHelp;
      return this;
    }
    showSuggestionAfterError(displaySuggestion = true) {
      this._showSuggestionAfterError = !!displaySuggestion;
      return this;
    }
    addCommand(cmd, opts) {
      if (!cmd._name) {
        throw new Error(`Command passed to .addCommand() must have a name
- specify the name in Command constructor or using .name()`);
      }
      opts = opts || {};
      if (opts.isDefault)
        this._defaultCommandName = cmd._name;
      if (opts.noHelp || opts.hidden)
        cmd._hidden = true;
      this._registerCommand(cmd);
      cmd.parent = this;
      cmd._checkForBrokenPassThrough();
      return this;
    }
    createArgument(name, description) {
      return new Argument(name, description);
    }
    argument(name, description, parseArg, defaultValue) {
      const argument = this.createArgument(name, description);
      if (typeof parseArg === "function") {
        argument.default(defaultValue).argParser(parseArg);
      } else {
        argument.default(parseArg);
      }
      this.addArgument(argument);
      return this;
    }
    arguments(names) {
      names.trim().split(/ +/).forEach((detail) => {
        this.argument(detail);
      });
      return this;
    }
    addArgument(argument) {
      const previousArgument = this.registeredArguments.slice(-1)[0];
      if (previousArgument?.variadic) {
        throw new Error(`only the last argument can be variadic '${previousArgument.name()}'`);
      }
      if (argument.required && argument.defaultValue !== undefined && argument.parseArg === undefined) {
        throw new Error(`a default value for a required argument is never used: '${argument.name()}'`);
      }
      this.registeredArguments.push(argument);
      return this;
    }
    helpCommand(enableOrNameAndArgs, description) {
      if (typeof enableOrNameAndArgs === "boolean") {
        this._addImplicitHelpCommand = enableOrNameAndArgs;
        if (enableOrNameAndArgs && this._defaultCommandGroup) {
          this._initCommandGroup(this._getHelpCommand());
        }
        return this;
      }
      const nameAndArgs = enableOrNameAndArgs ?? "help [command]";
      const [, helpName, helpArgs] = nameAndArgs.match(/([^ ]+) *(.*)/);
      const helpDescription = description ?? "display help for command";
      const helpCommand = this.createCommand(helpName);
      helpCommand.helpOption(false);
      if (helpArgs)
        helpCommand.arguments(helpArgs);
      if (helpDescription)
        helpCommand.description(helpDescription);
      this._addImplicitHelpCommand = true;
      this._helpCommand = helpCommand;
      if (enableOrNameAndArgs || description)
        this._initCommandGroup(helpCommand);
      return this;
    }
    addHelpCommand(helpCommand, deprecatedDescription) {
      if (typeof helpCommand !== "object") {
        this.helpCommand(helpCommand, deprecatedDescription);
        return this;
      }
      this._addImplicitHelpCommand = true;
      this._helpCommand = helpCommand;
      this._initCommandGroup(helpCommand);
      return this;
    }
    _getHelpCommand() {
      const hasImplicitHelpCommand = this._addImplicitHelpCommand ?? (this.commands.length && !this._actionHandler && !this._findCommand("help"));
      if (hasImplicitHelpCommand) {
        if (this._helpCommand === undefined) {
          this.helpCommand(undefined, undefined);
        }
        return this._helpCommand;
      }
      return null;
    }
    hook(event, listener) {
      const allowedValues = ["preSubcommand", "preAction", "postAction"];
      if (!allowedValues.includes(event)) {
        throw new Error(`Unexpected value for event passed to hook : '${event}'.
Expecting one of '${allowedValues.join("', '")}'`);
      }
      if (this._lifeCycleHooks[event]) {
        this._lifeCycleHooks[event].push(listener);
      } else {
        this._lifeCycleHooks[event] = [listener];
      }
      return this;
    }
    exitOverride(fn) {
      if (fn) {
        this._exitCallback = fn;
      } else {
        this._exitCallback = (err) => {
          if (err.code !== "commander.executeSubCommandAsync") {
            throw err;
          } else {}
        };
      }
      return this;
    }
    _exit(exitCode, code, message) {
      if (this._exitCallback) {
        this._exitCallback(new CommanderError(exitCode, code, message));
      }
      process2.exit(exitCode);
    }
    action(fn) {
      const listener = (args) => {
        const expectedArgsCount = this.registeredArguments.length;
        const actionArgs = args.slice(0, expectedArgsCount);
        if (this._storeOptionsAsProperties) {
          actionArgs[expectedArgsCount] = this;
        } else {
          actionArgs[expectedArgsCount] = this.opts();
        }
        actionArgs.push(this);
        return fn.apply(this, actionArgs);
      };
      this._actionHandler = listener;
      return this;
    }
    createOption(flags, description) {
      return new Option(flags, description);
    }
    _callParseArg(target, value, previous, invalidArgumentMessage) {
      try {
        return target.parseArg(value, previous);
      } catch (err) {
        if (err.code === "commander.invalidArgument") {
          const message = `${invalidArgumentMessage} ${err.message}`;
          this.error(message, { exitCode: err.exitCode, code: err.code });
        }
        throw err;
      }
    }
    _registerOption(option) {
      const matchingOption = option.short && this._findOption(option.short) || option.long && this._findOption(option.long);
      if (matchingOption) {
        const matchingFlag = option.long && this._findOption(option.long) ? option.long : option.short;
        throw new Error(`Cannot add option '${option.flags}'${this._name && ` to command '${this._name}'`} due to conflicting flag '${matchingFlag}'
-  already used by option '${matchingOption.flags}'`);
      }
      this._initOptionGroup(option);
      this.options.push(option);
    }
    _registerCommand(command) {
      const knownBy = (cmd) => {
        return [cmd.name()].concat(cmd.aliases());
      };
      const alreadyUsed = knownBy(command).find((name) => this._findCommand(name));
      if (alreadyUsed) {
        const existingCmd = knownBy(this._findCommand(alreadyUsed)).join("|");
        const newCmd = knownBy(command).join("|");
        throw new Error(`cannot add command '${newCmd}' as already have command '${existingCmd}'`);
      }
      this._initCommandGroup(command);
      this.commands.push(command);
    }
    addOption(option) {
      this._registerOption(option);
      const oname = option.name();
      const name = option.attributeName();
      if (option.negate) {
        const positiveLongFlag = option.long.replace(/^--no-/, "--");
        if (!this._findOption(positiveLongFlag)) {
          this.setOptionValueWithSource(name, option.defaultValue === undefined ? true : option.defaultValue, "default");
        }
      } else if (option.defaultValue !== undefined) {
        this.setOptionValueWithSource(name, option.defaultValue, "default");
      }
      const handleOptionValue = (val, invalidValueMessage, valueSource) => {
        if (val == null && option.presetArg !== undefined) {
          val = option.presetArg;
        }
        const oldValue = this.getOptionValue(name);
        if (val !== null && option.parseArg) {
          val = this._callParseArg(option, val, oldValue, invalidValueMessage);
        } else if (val !== null && option.variadic) {
          val = option._collectValue(val, oldValue);
        }
        if (val == null) {
          if (option.negate) {
            val = false;
          } else if (option.isBoolean() || option.optional) {
            val = true;
          } else {
            val = "";
          }
        }
        this.setOptionValueWithSource(name, val, valueSource);
      };
      this.on("option:" + oname, (val) => {
        const invalidValueMessage = `error: option '${option.flags}' argument '${val}' is invalid.`;
        handleOptionValue(val, invalidValueMessage, "cli");
      });
      if (option.envVar) {
        this.on("optionEnv:" + oname, (val) => {
          const invalidValueMessage = `error: option '${option.flags}' value '${val}' from env '${option.envVar}' is invalid.`;
          handleOptionValue(val, invalidValueMessage, "env");
        });
      }
      return this;
    }
    _optionEx(config, flags, description, fn, defaultValue) {
      if (typeof flags === "object" && flags instanceof Option) {
        throw new Error("To add an Option object use addOption() instead of option() or requiredOption()");
      }
      const option = this.createOption(flags, description);
      option.makeOptionMandatory(!!config.mandatory);
      if (typeof fn === "function") {
        option.default(defaultValue).argParser(fn);
      } else if (fn instanceof RegExp) {
        const regex = fn;
        fn = (val, def) => {
          const m = regex.exec(val);
          return m ? m[0] : def;
        };
        option.default(defaultValue).argParser(fn);
      } else {
        option.default(fn);
      }
      return this.addOption(option);
    }
    option(flags, description, parseArg, defaultValue) {
      return this._optionEx({}, flags, description, parseArg, defaultValue);
    }
    requiredOption(flags, description, parseArg, defaultValue) {
      return this._optionEx({ mandatory: true }, flags, description, parseArg, defaultValue);
    }
    combineFlagAndOptionalValue(combine = true) {
      this._combineFlagAndOptionalValue = !!combine;
      return this;
    }
    allowUnknownOption(allowUnknown = true) {
      this._allowUnknownOption = !!allowUnknown;
      return this;
    }
    allowExcessArguments(allowExcess = true) {
      this._allowExcessArguments = !!allowExcess;
      return this;
    }
    enablePositionalOptions(positional = true) {
      this._enablePositionalOptions = !!positional;
      return this;
    }
    passThroughOptions(passThrough = true) {
      this._passThroughOptions = !!passThrough;
      this._checkForBrokenPassThrough();
      return this;
    }
    _checkForBrokenPassThrough() {
      if (this.parent && this._passThroughOptions && !this.parent._enablePositionalOptions) {
        throw new Error(`passThroughOptions cannot be used for '${this._name}' without turning on enablePositionalOptions for parent command(s)`);
      }
    }
    storeOptionsAsProperties(storeAsProperties = true) {
      if (this.options.length) {
        throw new Error("call .storeOptionsAsProperties() before adding options");
      }
      if (Object.keys(this._optionValues).length) {
        throw new Error("call .storeOptionsAsProperties() before setting option values");
      }
      this._storeOptionsAsProperties = !!storeAsProperties;
      return this;
    }
    getOptionValue(key) {
      if (this._storeOptionsAsProperties) {
        return this[key];
      }
      return this._optionValues[key];
    }
    setOptionValue(key, value) {
      return this.setOptionValueWithSource(key, value, undefined);
    }
    setOptionValueWithSource(key, value, source) {
      if (this._storeOptionsAsProperties) {
        this[key] = value;
      } else {
        this._optionValues[key] = value;
      }
      this._optionValueSources[key] = source;
      return this;
    }
    getOptionValueSource(key) {
      return this._optionValueSources[key];
    }
    getOptionValueSourceWithGlobals(key) {
      let source;
      this._getCommandAndAncestors().forEach((cmd) => {
        if (cmd.getOptionValueSource(key) !== undefined) {
          source = cmd.getOptionValueSource(key);
        }
      });
      return source;
    }
    _prepareUserArgs(argv, parseOptions) {
      if (argv !== undefined && !Array.isArray(argv)) {
        throw new Error("first parameter to parse must be array or undefined");
      }
      parseOptions = parseOptions || {};
      if (argv === undefined && parseOptions.from === undefined) {
        if (process2.versions?.electron) {
          parseOptions.from = "electron";
        }
        const execArgv = process2.execArgv ?? [];
        if (execArgv.includes("-e") || execArgv.includes("--eval") || execArgv.includes("-p") || execArgv.includes("--print")) {
          parseOptions.from = "eval";
        }
      }
      if (argv === undefined) {
        argv = process2.argv;
      }
      this.rawArgs = argv.slice();
      let userArgs;
      switch (parseOptions.from) {
        case undefined:
        case "node":
          this._scriptPath = argv[1];
          userArgs = argv.slice(2);
          break;
        case "electron":
          if (process2.defaultApp) {
            this._scriptPath = argv[1];
            userArgs = argv.slice(2);
          } else {
            userArgs = argv.slice(1);
          }
          break;
        case "user":
          userArgs = argv.slice(0);
          break;
        case "eval":
          userArgs = argv.slice(1);
          break;
        default:
          throw new Error(`unexpected parse option { from: '${parseOptions.from}' }`);
      }
      if (!this._name && this._scriptPath)
        this.nameFromFilename(this._scriptPath);
      this._name = this._name || "program";
      return userArgs;
    }
    parse(argv, parseOptions) {
      this._prepareForParse();
      const userArgs = this._prepareUserArgs(argv, parseOptions);
      this._parseCommand([], userArgs);
      return this;
    }
    async parseAsync(argv, parseOptions) {
      this._prepareForParse();
      const userArgs = this._prepareUserArgs(argv, parseOptions);
      await this._parseCommand([], userArgs);
      return this;
    }
    _prepareForParse() {
      if (this._savedState === null) {
        this.saveStateBeforeParse();
      } else {
        this.restoreStateBeforeParse();
      }
    }
    saveStateBeforeParse() {
      this._savedState = {
        _name: this._name,
        _optionValues: { ...this._optionValues },
        _optionValueSources: { ...this._optionValueSources }
      };
    }
    restoreStateBeforeParse() {
      if (this._storeOptionsAsProperties)
        throw new Error(`Can not call parse again when storeOptionsAsProperties is true.
- either make a new Command for each call to parse, or stop storing options as properties`);
      this._name = this._savedState._name;
      this._scriptPath = null;
      this.rawArgs = [];
      this._optionValues = { ...this._savedState._optionValues };
      this._optionValueSources = { ...this._savedState._optionValueSources };
      this.args = [];
      this.processedArgs = [];
    }
    _checkForMissingExecutable(executableFile, executableDir, subcommandName) {
      if (fs.existsSync(executableFile))
        return;
      const executableDirMessage = executableDir ? `searched for local subcommand relative to directory '${executableDir}'` : "no directory for search for local subcommand, use .executableDir() to supply a custom directory";
      const executableMissing = `'${executableFile}' does not exist
 - if '${subcommandName}' is not meant to be an executable command, remove description parameter from '.command()' and use '.description()' instead
 - if the default executable name is not suitable, use the executableFile option to supply a custom name or path
 - ${executableDirMessage}`;
      throw new Error(executableMissing);
    }
    _executeSubCommand(subcommand, args) {
      args = args.slice();
      let launchWithNode = false;
      const sourceExt = [".js", ".ts", ".tsx", ".mjs", ".cjs"];
      function findFile(baseDir, baseName) {
        const localBin = path.resolve(baseDir, baseName);
        if (fs.existsSync(localBin))
          return localBin;
        if (sourceExt.includes(path.extname(baseName)))
          return;
        const foundExt = sourceExt.find((ext) => fs.existsSync(`${localBin}${ext}`));
        if (foundExt)
          return `${localBin}${foundExt}`;
        return;
      }
      this._checkForMissingMandatoryOptions();
      this._checkForConflictingOptions();
      let executableFile = subcommand._executableFile || `${this._name}-${subcommand._name}`;
      let executableDir = this._executableDir || "";
      if (this._scriptPath) {
        let resolvedScriptPath;
        try {
          resolvedScriptPath = fs.realpathSync(this._scriptPath);
        } catch {
          resolvedScriptPath = this._scriptPath;
        }
        executableDir = path.resolve(path.dirname(resolvedScriptPath), executableDir);
      }
      if (executableDir) {
        let localFile = findFile(executableDir, executableFile);
        if (!localFile && !subcommand._executableFile && this._scriptPath) {
          const legacyName = path.basename(this._scriptPath, path.extname(this._scriptPath));
          if (legacyName !== this._name) {
            localFile = findFile(executableDir, `${legacyName}-${subcommand._name}`);
          }
        }
        executableFile = localFile || executableFile;
      }
      launchWithNode = sourceExt.includes(path.extname(executableFile));
      let proc;
      if (process2.platform !== "win32") {
        if (launchWithNode) {
          args.unshift(executableFile);
          args = incrementNodeInspectorPort(process2.execArgv).concat(args);
          proc = childProcess.spawn(process2.argv[0], args, { stdio: "inherit" });
        } else {
          proc = childProcess.spawn(executableFile, args, { stdio: "inherit" });
        }
      } else {
        this._checkForMissingExecutable(executableFile, executableDir, subcommand._name);
        args.unshift(executableFile);
        args = incrementNodeInspectorPort(process2.execArgv).concat(args);
        proc = childProcess.spawn(process2.execPath, args, { stdio: "inherit" });
      }
      if (!proc.killed) {
        const signals = ["SIGUSR1", "SIGUSR2", "SIGTERM", "SIGINT", "SIGHUP"];
        signals.forEach((signal) => {
          process2.on(signal, () => {
            if (proc.killed === false && proc.exitCode === null) {
              proc.kill(signal);
            }
          });
        });
      }
      const exitCallback = this._exitCallback;
      proc.on("close", (code) => {
        code = code ?? 1;
        if (!exitCallback) {
          process2.exit(code);
        } else {
          exitCallback(new CommanderError(code, "commander.executeSubCommandAsync", "(close)"));
        }
      });
      proc.on("error", (err) => {
        if (err.code === "ENOENT") {
          this._checkForMissingExecutable(executableFile, executableDir, subcommand._name);
        } else if (err.code === "EACCES") {
          throw new Error(`'${executableFile}' not executable`);
        }
        if (!exitCallback) {
          process2.exit(1);
        } else {
          const wrappedError = new CommanderError(1, "commander.executeSubCommandAsync", "(error)");
          wrappedError.nestedError = err;
          exitCallback(wrappedError);
        }
      });
      this.runningCommand = proc;
    }
    _dispatchSubcommand(commandName, operands, unknown) {
      const subCommand = this._findCommand(commandName);
      if (!subCommand)
        this.help({ error: true });
      subCommand._prepareForParse();
      let promiseChain;
      promiseChain = this._chainOrCallSubCommandHook(promiseChain, subCommand, "preSubcommand");
      promiseChain = this._chainOrCall(promiseChain, () => {
        if (subCommand._executableHandler) {
          this._executeSubCommand(subCommand, operands.concat(unknown));
        } else {
          return subCommand._parseCommand(operands, unknown);
        }
      });
      return promiseChain;
    }
    _dispatchHelpCommand(subcommandName) {
      if (!subcommandName) {
        this.help();
      }
      const subCommand = this._findCommand(subcommandName);
      if (subCommand && !subCommand._executableHandler) {
        subCommand.help();
      }
      return this._dispatchSubcommand(subcommandName, [], [this._getHelpOption()?.long ?? this._getHelpOption()?.short ?? "--help"]);
    }
    _checkNumberOfArguments() {
      this.registeredArguments.forEach((arg, i) => {
        if (arg.required && this.args[i] == null) {
          this.missingArgument(arg.name());
        }
      });
      if (this.registeredArguments.length > 0 && this.registeredArguments[this.registeredArguments.length - 1].variadic) {
        return;
      }
      if (this.args.length > this.registeredArguments.length) {
        this._excessArguments(this.args);
      }
    }
    _processArguments() {
      const myParseArg = (argument, value, previous) => {
        let parsedValue = value;
        if (value !== null && argument.parseArg) {
          const invalidValueMessage = `error: command-argument value '${value}' is invalid for argument '${argument.name()}'.`;
          parsedValue = this._callParseArg(argument, value, previous, invalidValueMessage);
        }
        return parsedValue;
      };
      this._checkNumberOfArguments();
      const processedArgs = [];
      this.registeredArguments.forEach((declaredArg, index) => {
        let value = declaredArg.defaultValue;
        if (declaredArg.variadic) {
          if (index < this.args.length) {
            value = this.args.slice(index);
            if (declaredArg.parseArg) {
              value = value.reduce((processed, v) => {
                return myParseArg(declaredArg, v, processed);
              }, declaredArg.defaultValue);
            }
          } else if (value === undefined) {
            value = [];
          }
        } else if (index < this.args.length) {
          value = this.args[index];
          if (declaredArg.parseArg) {
            value = myParseArg(declaredArg, value, declaredArg.defaultValue);
          }
        }
        processedArgs[index] = value;
      });
      this.processedArgs = processedArgs;
    }
    _chainOrCall(promise, fn) {
      if (promise?.then && typeof promise.then === "function") {
        return promise.then(() => fn());
      }
      return fn();
    }
    _chainOrCallHooks(promise, event) {
      let result = promise;
      const hooks = [];
      this._getCommandAndAncestors().reverse().filter((cmd) => cmd._lifeCycleHooks[event] !== undefined).forEach((hookedCommand) => {
        hookedCommand._lifeCycleHooks[event].forEach((callback) => {
          hooks.push({ hookedCommand, callback });
        });
      });
      if (event === "postAction") {
        hooks.reverse();
      }
      hooks.forEach((hookDetail) => {
        result = this._chainOrCall(result, () => {
          return hookDetail.callback(hookDetail.hookedCommand, this);
        });
      });
      return result;
    }
    _chainOrCallSubCommandHook(promise, subCommand, event) {
      let result = promise;
      if (this._lifeCycleHooks[event] !== undefined) {
        this._lifeCycleHooks[event].forEach((hook) => {
          result = this._chainOrCall(result, () => {
            return hook(this, subCommand);
          });
        });
      }
      return result;
    }
    _parseCommand(operands, unknown) {
      const parsed = this.parseOptions(unknown);
      this._parseOptionsEnv();
      this._parseOptionsImplied();
      operands = operands.concat(parsed.operands);
      unknown = parsed.unknown;
      this.args = operands.concat(unknown);
      if (operands && this._findCommand(operands[0])) {
        return this._dispatchSubcommand(operands[0], operands.slice(1), unknown);
      }
      if (this._getHelpCommand() && operands[0] === this._getHelpCommand().name()) {
        return this._dispatchHelpCommand(operands[1]);
      }
      if (this._defaultCommandName) {
        this._outputHelpIfRequested(unknown);
        return this._dispatchSubcommand(this._defaultCommandName, operands, unknown);
      }
      if (this.commands.length && this.args.length === 0 && !this._actionHandler && !this._defaultCommandName) {
        this.help({ error: true });
      }
      this._outputHelpIfRequested(parsed.unknown);
      this._checkForMissingMandatoryOptions();
      this._checkForConflictingOptions();
      const checkForUnknownOptions = () => {
        if (parsed.unknown.length > 0) {
          this.unknownOption(parsed.unknown[0]);
        }
      };
      const commandEvent = `command:${this.name()}`;
      if (this._actionHandler) {
        checkForUnknownOptions();
        this._processArguments();
        let promiseChain;
        promiseChain = this._chainOrCallHooks(promiseChain, "preAction");
        promiseChain = this._chainOrCall(promiseChain, () => this._actionHandler(this.processedArgs));
        if (this.parent) {
          promiseChain = this._chainOrCall(promiseChain, () => {
            this.parent.emit(commandEvent, operands, unknown);
          });
        }
        promiseChain = this._chainOrCallHooks(promiseChain, "postAction");
        return promiseChain;
      }
      if (this.parent?.listenerCount(commandEvent)) {
        checkForUnknownOptions();
        this._processArguments();
        this.parent.emit(commandEvent, operands, unknown);
      } else if (operands.length) {
        if (this._findCommand("*")) {
          return this._dispatchSubcommand("*", operands, unknown);
        }
        if (this.listenerCount("command:*")) {
          this.emit("command:*", operands, unknown);
        } else if (this.commands.length) {
          this.unknownCommand();
        } else {
          checkForUnknownOptions();
          this._processArguments();
        }
      } else if (this.commands.length) {
        checkForUnknownOptions();
        this.help({ error: true });
      } else {
        checkForUnknownOptions();
        this._processArguments();
      }
    }
    _findCommand(name) {
      if (!name)
        return;
      return this.commands.find((cmd) => cmd._name === name || cmd._aliases.includes(name));
    }
    _findOption(arg) {
      return this.options.find((option) => option.is(arg));
    }
    _checkForMissingMandatoryOptions() {
      this._getCommandAndAncestors().forEach((cmd) => {
        cmd.options.forEach((anOption) => {
          if (anOption.mandatory && cmd.getOptionValue(anOption.attributeName()) === undefined) {
            cmd.missingMandatoryOptionValue(anOption);
          }
        });
      });
    }
    _checkForConflictingLocalOptions() {
      const definedNonDefaultOptions = this.options.filter((option) => {
        const optionKey = option.attributeName();
        if (this.getOptionValue(optionKey) === undefined) {
          return false;
        }
        return this.getOptionValueSource(optionKey) !== "default";
      });
      const optionsWithConflicting = definedNonDefaultOptions.filter((option) => option.conflictsWith.length > 0);
      optionsWithConflicting.forEach((option) => {
        const conflictingAndDefined = definedNonDefaultOptions.find((defined) => option.conflictsWith.includes(defined.attributeName()));
        if (conflictingAndDefined) {
          this._conflictingOption(option, conflictingAndDefined);
        }
      });
    }
    _checkForConflictingOptions() {
      this._getCommandAndAncestors().forEach((cmd) => {
        cmd._checkForConflictingLocalOptions();
      });
    }
    parseOptions(args) {
      const operands = [];
      const unknown = [];
      let dest = operands;
      function maybeOption(arg) {
        return arg.length > 1 && arg[0] === "-";
      }
      const negativeNumberArg = (arg) => {
        if (!/^-(\d+|\d*\.\d+)(e[+-]?\d+)?$/.test(arg))
          return false;
        return !this._getCommandAndAncestors().some((cmd) => cmd.options.map((opt) => opt.short).some((short) => /^-\d$/.test(short)));
      };
      let activeVariadicOption = null;
      let activeGroup = null;
      let i = 0;
      while (i < args.length || activeGroup) {
        const arg = activeGroup ?? args[i++];
        activeGroup = null;
        if (arg === "--") {
          if (dest === unknown)
            dest.push(arg);
          dest.push(...args.slice(i));
          break;
        }
        if (activeVariadicOption && (!maybeOption(arg) || negativeNumberArg(arg))) {
          this.emit(`option:${activeVariadicOption.name()}`, arg);
          continue;
        }
        activeVariadicOption = null;
        if (maybeOption(arg)) {
          const option = this._findOption(arg);
          if (option) {
            if (option.required) {
              const value = args[i++];
              if (value === undefined)
                this.optionMissingArgument(option);
              this.emit(`option:${option.name()}`, value);
            } else if (option.optional) {
              let value = null;
              if (i < args.length && (!maybeOption(args[i]) || negativeNumberArg(args[i]))) {
                value = args[i++];
              }
              this.emit(`option:${option.name()}`, value);
            } else {
              this.emit(`option:${option.name()}`);
            }
            activeVariadicOption = option.variadic ? option : null;
            continue;
          }
        }
        if (arg.length > 2 && arg[0] === "-" && arg[1] !== "-") {
          const option = this._findOption(`-${arg[1]}`);
          if (option) {
            if (option.required || option.optional && this._combineFlagAndOptionalValue) {
              this.emit(`option:${option.name()}`, arg.slice(2));
            } else {
              this.emit(`option:${option.name()}`);
              activeGroup = `-${arg.slice(2)}`;
            }
            continue;
          }
        }
        if (/^--[^=]+=/.test(arg)) {
          const index = arg.indexOf("=");
          const option = this._findOption(arg.slice(0, index));
          if (option && (option.required || option.optional)) {
            this.emit(`option:${option.name()}`, arg.slice(index + 1));
            continue;
          }
        }
        if (dest === operands && maybeOption(arg) && !(this.commands.length === 0 && negativeNumberArg(arg))) {
          dest = unknown;
        }
        if ((this._enablePositionalOptions || this._passThroughOptions) && operands.length === 0 && unknown.length === 0) {
          if (this._findCommand(arg)) {
            operands.push(arg);
            unknown.push(...args.slice(i));
            break;
          } else if (this._getHelpCommand() && arg === this._getHelpCommand().name()) {
            operands.push(arg, ...args.slice(i));
            break;
          } else if (this._defaultCommandName) {
            unknown.push(arg, ...args.slice(i));
            break;
          }
        }
        if (this._passThroughOptions) {
          dest.push(arg, ...args.slice(i));
          break;
        }
        dest.push(arg);
      }
      return { operands, unknown };
    }
    opts() {
      if (this._storeOptionsAsProperties) {
        const result = {};
        const len = this.options.length;
        for (let i = 0;i < len; i++) {
          const key = this.options[i].attributeName();
          result[key] = key === this._versionOptionName ? this._version : this[key];
        }
        return result;
      }
      return this._optionValues;
    }
    optsWithGlobals() {
      return this._getCommandAndAncestors().reduce((combinedOptions, cmd) => Object.assign(combinedOptions, cmd.opts()), {});
    }
    error(message, errorOptions) {
      this._outputConfiguration.outputError(`${message}
`, this._outputConfiguration.writeErr);
      if (typeof this._showHelpAfterError === "string") {
        this._outputConfiguration.writeErr(`${this._showHelpAfterError}
`);
      } else if (this._showHelpAfterError) {
        this._outputConfiguration.writeErr(`
`);
        this.outputHelp({ error: true });
      }
      const config = errorOptions || {};
      const exitCode = config.exitCode || 1;
      const code = config.code || "commander.error";
      this._exit(exitCode, code, message);
    }
    _parseOptionsEnv() {
      this.options.forEach((option) => {
        if (option.envVar && option.envVar in process2.env) {
          const optionKey = option.attributeName();
          if (this.getOptionValue(optionKey) === undefined || ["default", "config", "env"].includes(this.getOptionValueSource(optionKey))) {
            if (option.required || option.optional) {
              this.emit(`optionEnv:${option.name()}`, process2.env[option.envVar]);
            } else {
              this.emit(`optionEnv:${option.name()}`);
            }
          }
        }
      });
    }
    _parseOptionsImplied() {
      const dualHelper = new DualOptions(this.options);
      const hasCustomOptionValue = (optionKey) => {
        return this.getOptionValue(optionKey) !== undefined && !["default", "implied"].includes(this.getOptionValueSource(optionKey));
      };
      this.options.filter((option) => option.implied !== undefined && hasCustomOptionValue(option.attributeName()) && dualHelper.valueFromOption(this.getOptionValue(option.attributeName()), option)).forEach((option) => {
        Object.keys(option.implied).filter((impliedKey) => !hasCustomOptionValue(impliedKey)).forEach((impliedKey) => {
          this.setOptionValueWithSource(impliedKey, option.implied[impliedKey], "implied");
        });
      });
    }
    missingArgument(name) {
      const message = `error: missing required argument '${name}'`;
      this.error(message, { code: "commander.missingArgument" });
    }
    optionMissingArgument(option) {
      const message = `error: option '${option.flags}' argument missing`;
      this.error(message, { code: "commander.optionMissingArgument" });
    }
    missingMandatoryOptionValue(option) {
      const message = `error: required option '${option.flags}' not specified`;
      this.error(message, { code: "commander.missingMandatoryOptionValue" });
    }
    _conflictingOption(option, conflictingOption) {
      const findBestOptionFromValue = (option2) => {
        const optionKey = option2.attributeName();
        const optionValue = this.getOptionValue(optionKey);
        const negativeOption = this.options.find((target) => target.negate && optionKey === target.attributeName());
        const positiveOption = this.options.find((target) => !target.negate && optionKey === target.attributeName());
        if (negativeOption && (negativeOption.presetArg === undefined && optionValue === false || negativeOption.presetArg !== undefined && optionValue === negativeOption.presetArg)) {
          return negativeOption;
        }
        return positiveOption || option2;
      };
      const getErrorMessage = (option2) => {
        const bestOption = findBestOptionFromValue(option2);
        const optionKey = bestOption.attributeName();
        const source = this.getOptionValueSource(optionKey);
        if (source === "env") {
          return `environment variable '${bestOption.envVar}'`;
        }
        return `option '${bestOption.flags}'`;
      };
      const message = `error: ${getErrorMessage(option)} cannot be used with ${getErrorMessage(conflictingOption)}`;
      this.error(message, { code: "commander.conflictingOption" });
    }
    unknownOption(flag) {
      if (this._allowUnknownOption)
        return;
      let suggestion = "";
      if (flag.startsWith("--") && this._showSuggestionAfterError) {
        let candidateFlags = [];
        let command = this;
        do {
          const moreFlags = command.createHelp().visibleOptions(command).filter((option) => option.long).map((option) => option.long);
          candidateFlags = candidateFlags.concat(moreFlags);
          command = command.parent;
        } while (command && !command._enablePositionalOptions);
        suggestion = suggestSimilar(flag, candidateFlags);
      }
      const message = `error: unknown option '${flag}'${suggestion}`;
      this.error(message, { code: "commander.unknownOption" });
    }
    _excessArguments(receivedArgs) {
      if (this._allowExcessArguments)
        return;
      const expected = this.registeredArguments.length;
      const s = expected === 1 ? "" : "s";
      const forSubcommand = this.parent ? ` for '${this.name()}'` : "";
      const message = `error: too many arguments${forSubcommand}. Expected ${expected} argument${s} but got ${receivedArgs.length}.`;
      this.error(message, { code: "commander.excessArguments" });
    }
    unknownCommand() {
      const unknownName = this.args[0];
      let suggestion = "";
      if (this._showSuggestionAfterError) {
        const candidateNames = [];
        this.createHelp().visibleCommands(this).forEach((command) => {
          candidateNames.push(command.name());
          if (command.alias())
            candidateNames.push(command.alias());
        });
        suggestion = suggestSimilar(unknownName, candidateNames);
      }
      const message = `error: unknown command '${unknownName}'${suggestion}`;
      this.error(message, { code: "commander.unknownCommand" });
    }
    version(str, flags, description) {
      if (str === undefined)
        return this._version;
      this._version = str;
      flags = flags || "-V, --version";
      description = description || "output the version number";
      const versionOption = this.createOption(flags, description);
      this._versionOptionName = versionOption.attributeName();
      this._registerOption(versionOption);
      this.on("option:" + versionOption.name(), () => {
        this._outputConfiguration.writeOut(`${str}
`);
        this._exit(0, "commander.version", str);
      });
      return this;
    }
    description(str, argsDescription) {
      if (str === undefined && argsDescription === undefined)
        return this._description;
      this._description = str;
      if (argsDescription) {
        this._argsDescription = argsDescription;
      }
      return this;
    }
    summary(str) {
      if (str === undefined)
        return this._summary;
      this._summary = str;
      return this;
    }
    alias(alias) {
      if (alias === undefined)
        return this._aliases[0];
      let command = this;
      if (this.commands.length !== 0 && this.commands[this.commands.length - 1]._executableHandler) {
        command = this.commands[this.commands.length - 1];
      }
      if (alias === command._name)
        throw new Error("Command alias can't be the same as its name");
      const matchingCommand = this.parent?._findCommand(alias);
      if (matchingCommand) {
        const existingCmd = [matchingCommand.name()].concat(matchingCommand.aliases()).join("|");
        throw new Error(`cannot add alias '${alias}' to command '${this.name()}' as already have command '${existingCmd}'`);
      }
      command._aliases.push(alias);
      return this;
    }
    aliases(aliases) {
      if (aliases === undefined)
        return this._aliases;
      aliases.forEach((alias) => this.alias(alias));
      return this;
    }
    usage(str) {
      if (str === undefined) {
        if (this._usage)
          return this._usage;
        const args = this.registeredArguments.map((arg) => {
          return humanReadableArgName(arg);
        });
        return [].concat(this.options.length || this._helpOption !== null ? "[options]" : [], this.commands.length ? "[command]" : [], this.registeredArguments.length ? args : []).join(" ");
      }
      this._usage = str;
      return this;
    }
    name(str) {
      if (str === undefined)
        return this._name;
      this._name = str;
      return this;
    }
    helpGroup(heading) {
      if (heading === undefined)
        return this._helpGroupHeading ?? "";
      this._helpGroupHeading = heading;
      return this;
    }
    commandsGroup(heading) {
      if (heading === undefined)
        return this._defaultCommandGroup ?? "";
      this._defaultCommandGroup = heading;
      return this;
    }
    optionsGroup(heading) {
      if (heading === undefined)
        return this._defaultOptionGroup ?? "";
      this._defaultOptionGroup = heading;
      return this;
    }
    _initOptionGroup(option) {
      if (this._defaultOptionGroup && !option.helpGroupHeading)
        option.helpGroup(this._defaultOptionGroup);
    }
    _initCommandGroup(cmd) {
      if (this._defaultCommandGroup && !cmd.helpGroup())
        cmd.helpGroup(this._defaultCommandGroup);
    }
    nameFromFilename(filename) {
      this._name = path.basename(filename, path.extname(filename));
      return this;
    }
    executableDir(path2) {
      if (path2 === undefined)
        return this._executableDir;
      this._executableDir = path2;
      return this;
    }
    helpInformation(contextOptions) {
      const helper = this.createHelp();
      const context = this._getOutputContext(contextOptions);
      helper.prepareContext({
        error: context.error,
        helpWidth: context.helpWidth,
        outputHasColors: context.hasColors
      });
      const text = helper.formatHelp(this, helper);
      if (context.hasColors)
        return text;
      return this._outputConfiguration.stripColor(text);
    }
    _getOutputContext(contextOptions) {
      contextOptions = contextOptions || {};
      const error = !!contextOptions.error;
      let baseWrite;
      let hasColors;
      let helpWidth;
      if (error) {
        baseWrite = (str) => this._outputConfiguration.writeErr(str);
        hasColors = this._outputConfiguration.getErrHasColors();
        helpWidth = this._outputConfiguration.getErrHelpWidth();
      } else {
        baseWrite = (str) => this._outputConfiguration.writeOut(str);
        hasColors = this._outputConfiguration.getOutHasColors();
        helpWidth = this._outputConfiguration.getOutHelpWidth();
      }
      const write = (str) => {
        if (!hasColors)
          str = this._outputConfiguration.stripColor(str);
        return baseWrite(str);
      };
      return { error, write, hasColors, helpWidth };
    }
    outputHelp(contextOptions) {
      let deprecatedCallback;
      if (typeof contextOptions === "function") {
        deprecatedCallback = contextOptions;
        contextOptions = undefined;
      }
      const outputContext = this._getOutputContext(contextOptions);
      const eventContext = {
        error: outputContext.error,
        write: outputContext.write,
        command: this
      };
      this._getCommandAndAncestors().reverse().forEach((command) => command.emit("beforeAllHelp", eventContext));
      this.emit("beforeHelp", eventContext);
      let helpInformation = this.helpInformation({ error: outputContext.error });
      if (deprecatedCallback) {
        helpInformation = deprecatedCallback(helpInformation);
        if (typeof helpInformation !== "string" && !Buffer.isBuffer(helpInformation)) {
          throw new Error("outputHelp callback must return a string or a Buffer");
        }
      }
      outputContext.write(helpInformation);
      if (this._getHelpOption()?.long) {
        this.emit(this._getHelpOption().long);
      }
      this.emit("afterHelp", eventContext);
      this._getCommandAndAncestors().forEach((command) => command.emit("afterAllHelp", eventContext));
    }
    helpOption(flags, description) {
      if (typeof flags === "boolean") {
        if (flags) {
          if (this._helpOption === null)
            this._helpOption = undefined;
          if (this._defaultOptionGroup) {
            this._initOptionGroup(this._getHelpOption());
          }
        } else {
          this._helpOption = null;
        }
        return this;
      }
      this._helpOption = this.createOption(flags ?? "-h, --help", description ?? "display help for command");
      if (flags || description)
        this._initOptionGroup(this._helpOption);
      return this;
    }
    _getHelpOption() {
      if (this._helpOption === undefined) {
        this.helpOption(undefined, undefined);
      }
      return this._helpOption;
    }
    addHelpOption(option) {
      this._helpOption = option;
      this._initOptionGroup(option);
      return this;
    }
    help(contextOptions) {
      this.outputHelp(contextOptions);
      let exitCode = Number(process2.exitCode ?? 0);
      if (exitCode === 0 && contextOptions && typeof contextOptions !== "function" && contextOptions.error) {
        exitCode = 1;
      }
      this._exit(exitCode, "commander.help", "(outputHelp)");
    }
    addHelpText(position, text) {
      const allowedValues = ["beforeAll", "before", "after", "afterAll"];
      if (!allowedValues.includes(position)) {
        throw new Error(`Unexpected value for position to addHelpText.
Expecting one of '${allowedValues.join("', '")}'`);
      }
      const helpEvent = `${position}Help`;
      this.on(helpEvent, (context) => {
        let helpStr;
        if (typeof text === "function") {
          helpStr = text({ error: context.error, command: context.command });
        } else {
          helpStr = text;
        }
        if (helpStr) {
          context.write(`${helpStr}
`);
        }
      });
      return this;
    }
    _outputHelpIfRequested(args) {
      const helpOption = this._getHelpOption();
      const helpRequested = helpOption && args.find((arg) => helpOption.is(arg));
      if (helpRequested) {
        this.outputHelp();
        this._exit(0, "commander.helpDisplayed", "(outputHelp)");
      }
    }
  }
  function incrementNodeInspectorPort(args) {
    return args.map((arg) => {
      if (!arg.startsWith("--inspect")) {
        return arg;
      }
      let debugOption;
      let debugHost = "127.0.0.1";
      let debugPort = "9229";
      let match;
      if ((match = arg.match(/^(--inspect(-brk)?)$/)) !== null) {
        debugOption = match[1];
      } else if ((match = arg.match(/^(--inspect(-brk|-port)?)=([^:]+)$/)) !== null) {
        debugOption = match[1];
        if (/^\d+$/.test(match[3])) {
          debugPort = match[3];
        } else {
          debugHost = match[3];
        }
      } else if ((match = arg.match(/^(--inspect(-brk|-port)?)=([^:]+):(\d+)$/)) !== null) {
        debugOption = match[1];
        debugHost = match[3];
        debugPort = match[4];
      }
      if (debugOption && debugPort !== "0") {
        return `${debugOption}=${debugHost}:${parseInt(debugPort) + 1}`;
      }
      return arg;
    });
  }
  function useColor() {
    if (process2.env.NO_COLOR || process2.env.FORCE_COLOR === "0" || process2.env.FORCE_COLOR === "false")
      return false;
    if (process2.env.FORCE_COLOR || process2.env.CLICOLOR_FORCE !== undefined)
      return true;
    return;
  }
  exports.Command = Command;
  exports.useColor = useColor;
});

// node_modules/commander/index.js
var require_commander = __commonJS((exports) => {
  var { Argument } = require_argument();
  var { Command } = require_command();
  var { CommanderError, InvalidArgumentError } = require_error();
  var { Help } = require_help();
  var { Option } = require_option();
  exports.program = new Command;
  exports.createCommand = (name) => new Command(name);
  exports.createOption = (flags, description) => new Option(flags, description);
  exports.createArgument = (name, description) => new Argument(name, description);
  exports.Command = Command;
  exports.Option = Option;
  exports.Argument = Argument;
  exports.Help = Help;
  exports.CommanderError = CommanderError;
  exports.InvalidArgumentError = InvalidArgumentError;
  exports.InvalidOptionArgumentError = InvalidArgumentError;
});

// src/shared/identity/agent-context.ts
var exports_agent_context = {};
__export(exports_agent_context, {
  agentContextStorage: () => agentContextStorage
});
import { AsyncLocalStorage } from "node:async_hooks";
var agentContextStorage;
var init_agent_context = __esm(() => {
  agentContextStorage = new AsyncLocalStorage;
});

// src/shared/runtime/config-keys.ts
var exports_config_keys = {};
__export(exports_config_keys, {
  getConfigKeyByName: () => getConfigKeyByName,
  StructuralKeys: () => StructuralKeys,
  SecretKeys: () => SecretKeys,
  RegistryKeys: () => RegistryKeys,
  FlagKeys: () => FlagKeys,
  DiagnosticKeys: () => DiagnosticKeys,
  AllConfigKeys: () => AllConfigKeys
});
function getConfigKeyByName(name) {
  const key = AllConfigKeys[name];
  if (!key) {
    throw new Error(`[Config] Unknown configuration key: ${name}. ` + `Known keys: ${Object.keys(AllConfigKeys).join(", ")}`);
  }
  return key;
}
var SecretKeys, StructuralKeys, RegistryKeys, FlagKeys, DiagnosticKeys, AllConfigKeys;
var init_config_keys = __esm(() => {
  SecretKeys = {
    PGPASSWORD: {
      name: "PGPASSWORD",
      class: "secret",
      parse: (v) => v,
      required: false,
      description: "PostgreSQL password (rely on .pgpass / libpq implicit auth if not set)"
    },
    DISCORD_BOT_TOKEN: {
      name: "DISCORD_BOT_TOKEN",
      class: "secret",
      parse: (v) => v,
      required: false,
      description: "Discord bot token for bridge integration"
    },
    GITHUB_TOKEN: {
      name: "GITHUB_TOKEN",
      class: "secret",
      parse: (v) => v,
      required: false,
      description: "GitHub personal access token"
    }
  };
  StructuralKeys = {
    PGHOST: {
      name: "PGHOST",
      class: "structural",
      parse: (v) => v,
      required: true,
      description: "PostgreSQL hostname",
      yamlPath: "database.host",
      envOverride: true,
      defaultValue: "127.0.0.1"
    },
    PGPORT: {
      name: "PGPORT",
      class: "structural",
      parse: (v) => {
        const parsed = Number(v);
        if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
          throw new Error(`Invalid port number: ${v}`);
        }
        return parsed;
      },
      required: true,
      description: "PostgreSQL port",
      yamlPath: "database.port",
      envOverride: true,
      defaultValue: 5432
    },
    PGDATABASE: {
      name: "PGDATABASE",
      class: "structural",
      parse: (v) => v,
      required: true,
      description: "PostgreSQL database name",
      yamlPath: "database.name",
      envOverride: true,
      defaultValue: "agenthive"
    },
    PGUSER: {
      name: "PGUSER",
      class: "structural",
      parse: (v) => v,
      required: true,
      description: "PostgreSQL username",
      yamlPath: "database.user",
      envOverride: true
    },
    PG_SCHEMA: {
      name: "PG_SCHEMA",
      class: "structural",
      parse: (v) => {
        const trimmed = v.trim();
        if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(trimmed)) {
          throw new Error(`Invalid schema name: ${trimmed}`);
        }
        return trimmed;
      },
      required: false,
      description: "PostgreSQL schema name",
      yamlPath: "database.schema",
      envOverride: true
    },
    AGENTHIVE_MCP_URL: {
      name: "AGENTHIVE_MCP_URL",
      class: "structural",
      parse: (v) => {
        try {
          new URL(v);
          return v;
        } catch {
          throw new Error(`Invalid MCP URL: ${v}`);
        }
      },
      required: true,
      description: "MCP server endpoint URL",
      yamlPath: "mcp.url",
      envOverride: true
    },
    AGENTHIVE_DAEMON_URL: {
      name: "AGENTHIVE_DAEMON_URL",
      class: "structural",
      parse: (v) => {
        try {
          new URL(v);
          return v;
        } catch {
          throw new Error(`Invalid daemon URL: ${v}`);
        }
      },
      required: false,
      description: "Daemon endpoint URL",
      yamlPath: "daemon.url",
      envOverride: true
    },
    PROJECT_ROOT: {
      name: "PROJECT_ROOT",
      class: "structural",
      parse: (v) => v,
      required: true,
      description: "AgentHive project root directory",
      yamlPath: "project.project_root",
      envOverride: true
    },
    PG_CONNECTION_TIMEOUT_MS: {
      name: "PG_CONNECTION_TIMEOUT_MS",
      class: "structural",
      parse: (v) => {
        const parsed = Number(v);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(`Invalid connection timeout: ${v}`);
        }
        return parsed;
      },
      required: false,
      description: "PostgreSQL connection timeout in ms",
      envOverride: true,
      defaultValue: 5000
    },
    PG_QUERY_TIMEOUT_MS: {
      name: "PG_QUERY_TIMEOUT_MS",
      class: "structural",
      parse: (v) => {
        const parsed = Number(v);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(`Invalid query timeout: ${v}`);
        }
        return parsed;
      },
      required: false,
      description: "PostgreSQL query timeout in ms",
      envOverride: true,
      defaultValue: 30000
    },
    PG_STATEMENT_TIMEOUT_MS: {
      name: "PG_STATEMENT_TIMEOUT_MS",
      class: "structural",
      parse: (v) => {
        const parsed = Number(v);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(`Invalid statement timeout: ${v}`);
        }
        return parsed;
      },
      required: false,
      description: "PostgreSQL statement timeout in ms",
      envOverride: true,
      defaultValue: 30000
    },
    AGENTHIVE_WORKTREE_ROOT: {
      name: "AGENTHIVE_WORKTREE_ROOT",
      class: "structural",
      parse: (v) => v,
      required: false,
      description: "Root directory for git worktrees",
      yamlPath: "paths.worktree_root",
      envOverride: true
    },
    AGENTHIVE_HOST: {
      name: "AGENTHIVE_HOST",
      class: "structural",
      parse: (v) => v,
      required: false,
      description: "Logical host identifier (shared operator host name)",
      envOverride: true
    },
    AGENTHIVE_CONTROL_DSN: {
      name: "AGENTHIVE_CONTROL_DSN",
      class: "structural",
      parse: (v) => v,
      required: true,
      description: "Control database DSN (hiveControl connection)",
      yamlPath: "databases.control",
      envOverride: true
    },
    CONTROL_DB_HOST: {
      name: "CONTROL_DB_HOST",
      class: "structural",
      parse: (v) => v,
      required: false,
      description: "Control database hostname",
      yamlPath: "databases.control.host",
      defaultValue: "127.0.0.1"
    },
    CONTROL_DB_PORT: {
      name: "CONTROL_DB_PORT",
      class: "structural",
      parse: (v) => {
        const parsed = Number(v);
        if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
          throw new Error(`Invalid port number: ${v}`);
        }
        return parsed;
      },
      required: false,
      description: "Control database port (PgBouncer)",
      yamlPath: "databases.control.port",
      defaultValue: 6432
    },
    CONTROL_DB_NAME: {
      name: "CONTROL_DB_NAME",
      class: "structural",
      parse: (v) => v,
      required: false,
      description: "Control database name",
      yamlPath: "databases.control.name",
      defaultValue: "hiveControl"
    },
    CONTROL_DB_ROLE: {
      name: "CONTROL_DB_ROLE",
      class: "structural",
      parse: (v) => v,
      required: false,
      description: "Control database role",
      yamlPath: "databases.control.role",
      defaultValue: "agenthive_admin"
    },
    CONTROL_DB_PASSWORD_REF: {
      name: "CONTROL_DB_PASSWORD_REF",
      class: "structural",
      parse: (v) => v,
      required: false,
      description: "Vault path for control DB password (from P496)",
      yamlPath: "databases.control.password_ref",
      envOverride: true,
      defaultValue: "vault://file/control/db_password"
    },
    AGENTHIVE_VAULT_ROOT: {
      name: "AGENTHIVE_VAULT_ROOT",
      class: "structural",
      parse: (v) => v,
      required: false,
      description: "Vault file root directory (P496)",
      yamlPath: "vault.root",
      defaultValue: "/etc/agenthive/secrets"
    },
    AGENTHIVE_VAULT_KIND: {
      name: "AGENTHIVE_VAULT_KIND",
      class: "structural",
      parse: (v) => {
        if (!["file", "aws", "gcp"].includes(v)) {
          throw new Error(`Invalid vault kind: ${v}. Must be file, aws, or gcp`);
        }
        return v;
      },
      required: false,
      description: "Vault adapter kind (P496/P515)",
      yamlPath: "vault.kind",
      defaultValue: "file"
    },
    AGENTHIVE_TENANT_POOL_LRU_MAX: {
      name: "AGENTHIVE_TENANT_POOL_LRU_MAX",
      class: "structural",
      parse: (v) => {
        const parsed = Number(v);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(`Invalid LRU max: ${v}`);
        }
        return parsed;
      },
      required: false,
      description: "LRU cap for tenant pool registry (P497)",
      yamlPath: "pools.tenant_lru_max",
      defaultValue: 16
    },
    AGENTHIVE_TENANT_POOL_MAX: {
      name: "AGENTHIVE_TENANT_POOL_MAX",
      class: "structural",
      parse: (v) => {
        const parsed = Number(v);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(`Invalid pool max: ${v}`);
        }
        return parsed;
      },
      required: false,
      description: "Per-pool size for tenant pools (P497)",
      yamlPath: "pools.tenant_max",
      defaultValue: 8
    },
    AGENTHIVE_DRAIN_TIMEOUT_MS: {
      name: "AGENTHIVE_DRAIN_TIMEOUT_MS",
      class: "structural",
      parse: (v) => {
        const parsed = Number(v);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(`Invalid drain timeout: ${v}`);
        }
        return parsed;
      },
      required: false,
      description: "Pool drain grace period in ms (P497)",
      yamlPath: "pools.drain_timeout_ms",
      defaultValue: 30000
    },
    AGENTHIVE_PG_PORT: {
      name: "AGENTHIVE_PG_PORT",
      class: "structural",
      parse: (v) => {
        const parsed = Number(v);
        if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
          throw new Error(`Invalid port number: ${v}`);
        }
        return parsed;
      },
      required: false,
      description: "PostgreSQL direct port (P499)",
      yamlPath: "databases.pg_port",
      defaultValue: 6432
    },
    AGENTHIVE_LISTEN_PORT: {
      name: "AGENTHIVE_LISTEN_PORT",
      class: "structural",
      parse: (v) => {
        const parsed = Number(v);
        if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
          throw new Error(`Invalid port number: ${v}`);
        }
        return parsed;
      },
      required: false,
      description: "LISTEN bypass port (P499)",
      yamlPath: "databases.listen_port",
      defaultValue: 5432
    },
    PGSERVICE: {
      name: "PGSERVICE",
      class: "structural",
      parse: (v) => v,
      required: false,
      description: "PostgreSQL service name (.pgpass/.pg_service.conf) for connection",
      envOverride: true
    },
    PGPASSFILE: {
      name: "PGPASSFILE",
      class: "structural",
      parse: (v) => v,
      required: false,
      description: "Path to .pgpass file for implicit PostgreSQL auth",
      yamlPath: "database.pgpass_path",
      envOverride: true,
      defaultValue: "~/.pgpass"
    },
    PGPORT_DIRECT: {
      name: "PGPORT_DIRECT",
      class: "structural",
      parse: (v) => {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0 || n > 65535) {
          throw new Error(`Invalid PGPORT_DIRECT port number: ${v}`);
        }
        return n;
      },
      required: false,
      description: "Direct Postgres port, bypassing PgBouncer (used for LISTEN connections when P499 is deployed). Defaults to PGPORT when not set.",
      envOverride: true
    }
  };
  RegistryKeys = {
    AGENTHIVE_DEFAULT_PROVIDER: {
      name: "AGENTHIVE_DEFAULT_PROVIDER",
      class: "registry",
      parse: (v) => v,
      required: false,
      description: "Default model provider (Claude, Codex, etc)",
      dbTable: "control_model.model_route",
      dbColumn: "default_provider",
      envOverride: false
    },
    PROJECT_SCHEMA_NAME: {
      name: "PROJECT_SCHEMA_NAME",
      class: "registry",
      parse: (v) => {
        const trimmed = v.trim();
        if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(trimmed)) {
          throw new Error(`Invalid schema name: ${trimmed}`);
        }
        return trimmed;
      },
      required: false,
      description: "Project database schema name",
      dbTable: "control_project.project",
      dbColumn: "schema_name",
      envOverride: false
    },
    PROJECT_TOKEN_BUDGET: {
      name: "PROJECT_TOKEN_BUDGET",
      class: "registry",
      parse: (v) => {
        const parsed = Number(v);
        if (!Number.isFinite(parsed) || parsed < 0) {
          throw new Error(`Invalid token budget: ${v}`);
        }
        return parsed;
      },
      required: false,
      description: "Project token budget for API calls",
      dbTable: "core.runtime_flag",
      dbColumn: "value_jsonb",
      envOverride: false
    },
    PROJECT_MAX_CONCURRENT_LEASES: {
      name: "PROJECT_MAX_CONCURRENT_LEASES",
      class: "registry",
      parse: (v) => {
        const parsed = Number(v);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(`Invalid max concurrent leases: ${v}`);
        }
        return parsed;
      },
      required: false,
      description: "Maximum concurrent leases for a project",
      dbTable: "core.runtime_flag",
      dbColumn: "value_jsonb",
      envOverride: false
    },
    PROJECT_DEFAULT_WORKFLOW: {
      name: "PROJECT_DEFAULT_WORKFLOW",
      class: "registry",
      parse: (v) => v,
      required: false,
      description: "Default workflow type for project proposals",
      dbTable: "core.runtime_flag",
      dbColumn: "value_jsonb",
      envOverride: false
    },
    PROJECT_SPENDING_THRESHOLD_WARN: {
      name: "PROJECT_SPENDING_THRESHOLD_WARN",
      class: "registry",
      parse: (v) => {
        const parsed = parseFloat(v);
        if (!Number.isFinite(parsed) || parsed < 0) {
          throw new Error(`Invalid spending threshold: ${v}`);
        }
        return parsed;
      },
      required: false,
      description: "Project spending threshold for warnings (in currency units)",
      dbTable: "core.runtime_flag",
      dbColumn: "value_jsonb",
      envOverride: false
    },
    PROJECT_SPENDING_THRESHOLD_HARD: {
      name: "PROJECT_SPENDING_THRESHOLD_HARD",
      class: "registry",
      parse: (v) => {
        const parsed = parseFloat(v);
        if (!Number.isFinite(parsed) || parsed < 0) {
          throw new Error(`Invalid spending threshold: ${v}`);
        }
        return parsed;
      },
      required: false,
      description: "Project spending threshold for hard limits (in currency units)",
      dbTable: "core.runtime_flag",
      dbColumn: "value_jsonb",
      envOverride: false
    },
    PROJECT_KB_EMBEDDING_MODEL: {
      name: "PROJECT_KB_EMBEDDING_MODEL",
      class: "registry",
      parse: (v) => v,
      required: false,
      description: "Knowledge base embedding model",
      dbTable: "core.runtime_flag",
      dbColumn: "value_jsonb",
      envOverride: false,
      defaultValue: "text-embedding-3-small"
    },
    MODEL_CONTEXT_WINDOW: {
      name: "MODEL_CONTEXT_WINDOW",
      class: "registry",
      parse: (v) => {
        const parsed = Number(v);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(`Invalid context window: ${v}`);
        }
        return parsed;
      },
      required: false,
      description: "Model context window in tokens",
      dbTable: "control_model.model",
      dbColumn: "context_window_tokens",
      envOverride: false
    },
    MODEL_COST_PER_INPUT_TOKEN: {
      name: "MODEL_COST_PER_INPUT_TOKEN",
      class: "registry",
      parse: (v) => {
        const parsed = parseFloat(v);
        if (!Number.isFinite(parsed) || parsed < 0) {
          throw new Error(`Invalid cost: ${v}`);
        }
        return parsed;
      },
      required: false,
      description: "Cost per million input tokens",
      dbTable: "control_model.model",
      dbColumn: "cost_per_million_input",
      envOverride: false
    },
    MODEL_COST_PER_OUTPUT_TOKEN: {
      name: "MODEL_COST_PER_OUTPUT_TOKEN",
      class: "registry",
      parse: (v) => {
        const parsed = parseFloat(v);
        if (!Number.isFinite(parsed) || parsed < 0) {
          throw new Error(`Invalid cost: ${v}`);
        }
        return parsed;
      },
      required: false,
      description: "Cost per million output tokens",
      dbTable: "control_model.model",
      dbColumn: "cost_per_million_output",
      envOverride: false
    },
    MODEL_MAX_SPEND_PER_CALL: {
      name: "MODEL_MAX_SPEND_PER_CALL",
      class: "registry",
      parse: (v) => {
        const parsed = parseFloat(v);
        if (!Number.isFinite(parsed) || parsed < 0) {
          throw new Error(`Invalid max spend: ${v}`);
        }
        return parsed;
      },
      required: false,
      description: "Maximum spend per model API call",
      dbTable: "control_model.host_model_policy",
      dbColumn: "max_spend_per_call",
      envOverride: false
    },
    MODEL_PREFERRED_PROVIDER: {
      name: "MODEL_PREFERRED_PROVIDER",
      class: "registry",
      parse: (v) => v,
      required: false,
      description: "Preferred model provider for routing",
      dbTable: "control_model.model_route",
      dbColumn: "preferred_provider",
      envOverride: false
    },
    MODEL_FALLBACK_MODEL_ID: {
      name: "MODEL_FALLBACK_MODEL_ID",
      class: "registry",
      parse: (v) => v,
      required: false,
      description: "Fallback model ID for routing failures",
      dbTable: "control_model.model_route",
      dbColumn: "fallback_model_id",
      envOverride: false
    },
    MODEL_DEFAULT_TEMPERATURE: {
      name: "MODEL_DEFAULT_TEMPERATURE",
      class: "registry",
      parse: (v) => {
        const parsed = parseFloat(v);
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2) {
          throw new Error(`Invalid temperature: ${v}`);
        }
        return parsed;
      },
      required: false,
      description: "Default temperature for model requests",
      dbTable: "control_model.model_route",
      dbColumn: "default_temperature",
      envOverride: false
    },
    MODEL_ALLOWED_HOST_POLICY: {
      name: "MODEL_ALLOWED_HOST_POLICY",
      class: "registry",
      parse: (v) => v,
      required: false,
      description: "Allowed host policy for model routing",
      dbTable: "control_model.host_model_policy",
      dbColumn: "allowed_hosts",
      envOverride: false
    }
  };
  FlagKeys = {
    USE_OFFER_DISPATCH: {
      name: "USE_OFFER_DISPATCH",
      class: "flag",
      parse: (v) => {
        try {
          return JSON.parse(v) === true;
        } catch {
          return v.toLowerCase() === "true" || v === "1";
        }
      },
      required: false,
      description: "Enable offer-dispatch workflow",
      dbTable: "core.runtime_flag",
      dbColumn: "value_jsonb",
      envOverride: false
    },
    ENABLE_MULTI_TENANT: {
      name: "ENABLE_MULTI_TENANT",
      class: "flag",
      parse: (v) => {
        try {
          return JSON.parse(v) === true;
        } catch {
          return v.toLowerCase() === "true" || v === "1";
        }
      },
      required: false,
      description: "Enable multi-tenant mode",
      dbTable: "core.runtime_flag",
      dbColumn: "value_jsonb",
      envOverride: false
    },
    ENABLE_AUDIT_LOG: {
      name: "ENABLE_AUDIT_LOG",
      class: "flag",
      parse: (v) => {
        try {
          return JSON.parse(v) === true;
        } catch {
          return v.toLowerCase() === "true" || v === "1";
        }
      },
      required: false,
      description: "Enable audit logging",
      dbTable: "core.runtime_flag",
      dbColumn: "value_jsonb",
      envOverride: false
    },
    A2A_HOST_LISTEN_REFRESH_MS: {
      name: "A2A_HOST_LISTEN_REFRESH_MS",
      class: "flag",
      parse: (v) => {
        const parsed = Number(JSON.parse(v));
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(`Invalid A2A_HOST_LISTEN_REFRESH_MS: ${v}`);
        }
        return parsed;
      },
      required: true,
      description: "How often A2A re-reads agent_registry for newly-registered local agencies (ms)",
      dbTable: "core.runtime_flag",
      dbColumn: "value_jsonb",
      envOverride: false
    },
    A2A_HOST_PG_RECONNECT_MS: {
      name: "A2A_HOST_PG_RECONNECT_MS",
      class: "flag",
      parse: (v) => {
        const parsed = Number(JSON.parse(v));
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(`Invalid A2A_HOST_PG_RECONNECT_MS: ${v}`);
        }
        return parsed;
      },
      required: true,
      description: "Backoff on PG connection loss before exit(1) (ms)",
      dbTable: "core.runtime_flag",
      dbColumn: "value_jsonb",
      envOverride: false
    },
    A2A_HOST_SHUTDOWN_TIMEOUT_MS: {
      name: "A2A_HOST_SHUTDOWN_TIMEOUT_MS",
      class: "flag",
      parse: (v) => {
        const parsed = Number(JSON.parse(v));
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(`Invalid A2A_HOST_SHUTDOWN_TIMEOUT_MS: ${v}`);
        }
        return parsed;
      },
      required: true,
      description: "Bounded wait for fn_pulse(offline) calls during SIGTERM (ms)",
      dbTable: "core.runtime_flag",
      dbColumn: "value_jsonb",
      envOverride: false
    },
    A2A_HOST_PRESENCE_REFRESH_MS: {
      name: "A2A_HOST_PRESENCE_REFRESH_MS",
      class: "flag",
      parse: (v) => {
        const parsed = Number(JSON.parse(v));
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(`Invalid A2A_HOST_PRESENCE_REFRESH_MS: ${v}`);
        }
        return parsed;
      },
      required: true,
      description: "How often A2A calls fn_pulse('online') per child to keep last_heartbeat_at fresh for existing dispatchability/maintenance consumers (ms)",
      dbTable: "core.runtime_flag",
      dbColumn: "value_jsonb",
      envOverride: false
    },
    LIAISON_CONTEXT_REFRESH_MS: {
      name: "LIAISON_CONTEXT_REFRESH_MS",
      class: "flag",
      parse: (v) => {
        const parsed = Number(JSON.parse(v));
        if (!Number.isFinite(parsed) || parsed < 1000 || parsed > 600000) {
          throw new Error(`Invalid LIAISON_CONTEXT_REFRESH_MS: ${v}. Must be between 1000 and 600000 ms`);
        }
        return parsed;
      },
      required: false,
      defaultValue: 60000,
      description: "Liaison context re-hydration interval (ms). Valid range: 1000-600000 (1s-10m)",
      dbTable: "core.runtime_flag",
      dbColumn: "value_jsonb",
      envOverride: true
    },
    ORCHESTRATOR_SCAN_BATCH_LIMIT: {
      name: "ORCHESTRATOR_SCAN_BATCH_LIMIT",
      class: "flag",
      parse: (v) => {
        const n = Number(JSON.parse(v));
        if (!Number.isFinite(n))
          throw new Error("invalid number");
        return n;
      },
      required: false,
      defaultValue: 20,
      description: "scanQueues batch size per tick",
      dbTable: "core.runtime_flag",
      dbColumn: "value_jsonb",
      envOverride: false
    },
    ORCHESTRATOR_STALL_THRESHOLD_HOURS: {
      name: "ORCHESTRATOR_STALL_THRESHOLD_HOURS",
      class: "flag",
      parse: (v) => {
        const n = Number(JSON.parse(v));
        if (!Number.isFinite(n))
          throw new Error("invalid number");
        return n;
      },
      required: false,
      defaultValue: 4,
      description: "Hours before mature proposal escalated",
      dbTable: "core.runtime_flag",
      dbColumn: "value_jsonb",
      envOverride: false
    },
    ORCHESTRATOR_STALL_BATCH_LIMIT: {
      name: "ORCHESTRATOR_STALL_BATCH_LIMIT",
      class: "flag",
      parse: (v) => {
        const n = Number(JSON.parse(v));
        if (!Number.isFinite(n))
          throw new Error("invalid number");
        return n;
      },
      required: false,
      defaultValue: 5,
      description: "Max stalls processed per tick",
      dbTable: "core.runtime_flag",
      dbColumn: "value_jsonb",
      envOverride: false
    },
    ORCHESTRATOR_OFFER_REAP_MS: {
      name: "ORCHESTRATOR_OFFER_REAP_MS",
      class: "flag",
      parse: (v) => {
        const n = Number(JSON.parse(v));
        if (!Number.isFinite(n))
          throw new Error("invalid number");
        return n;
      },
      required: false,
      defaultValue: 60000,
      description: "Offer reap interval (ms)",
      dbTable: "core.runtime_flag",
      dbColumn: "value_jsonb",
      envOverride: false
    },
    ORCHESTRATOR_POKE_IDLE_MIN: {
      name: "ORCHESTRATOR_POKE_IDLE_MIN",
      class: "flag",
      parse: (v) => {
        const n = Number(JSON.parse(v));
        if (!Number.isFinite(n))
          throw new Error("invalid number");
        return n;
      },
      required: false,
      defaultValue: 5,
      description: "Minutes idle before poke",
      dbTable: "core.runtime_flag",
      dbColumn: "value_jsonb",
      envOverride: false
    },
    ORCHESTRATOR_POKE_STORM_CAP: {
      name: "ORCHESTRATOR_POKE_STORM_CAP",
      class: "flag",
      parse: (v) => {
        const n = Number(JSON.parse(v));
        if (!Number.isFinite(n))
          throw new Error("invalid number");
        return n;
      },
      required: false,
      defaultValue: 10,
      description: "Max pokes per cycle",
      dbTable: "core.runtime_flag",
      dbColumn: "value_jsonb",
      envOverride: false
    },
    ORCHESTRATOR_MAX_INFLIGHT_OFFERS: {
      name: "ORCHESTRATOR_MAX_INFLIGHT_OFFERS",
      class: "flag",
      parse: (v) => {
        const n = Number(JSON.parse(v));
        if (!Number.isFinite(n))
          throw new Error("invalid number");
        return n;
      },
      required: false,
      defaultValue: 20,
      description: "Max global in-flight work offers (backpressure cap); 0=disabled",
      dbTable: "core.runtime_flag",
      dbColumn: "value_jsonb",
      envOverride: false
    },
    ORCHESTRATOR_SHUTDOWN_DRAIN_MS: {
      name: "ORCHESTRATOR_SHUTDOWN_DRAIN_MS",
      class: "flag",
      parse: (v) => {
        const n = Number(JSON.parse(v));
        if (!Number.isFinite(n))
          throw new Error("invalid number");
        return n;
      },
      required: false,
      defaultValue: 240000,
      description: "Bounded wait for drain on SIGTERM (ms)",
      dbTable: "core.runtime_flag",
      dbColumn: "value_jsonb",
      envOverride: false
    },
    ORCHESTRATOR_IMPLICIT_GATE_POLL_MS: {
      name: "ORCHESTRATOR_IMPLICIT_GATE_POLL_MS",
      class: "flag",
      parse: (v) => {
        const n = Number(JSON.parse(v));
        if (!Number.isFinite(n))
          throw new Error("invalid number");
        return n;
      },
      required: false,
      defaultValue: 30000,
      description: "Implicit gate poll interval (ms)",
      dbTable: "core.runtime_flag",
      dbColumn: "value_jsonb",
      envOverride: false
    },
    ORCHESTRATOR_ENHANCER_REVISE_MS: {
      name: "ORCHESTRATOR_ENHANCER_REVISE_MS",
      class: "flag",
      parse: (v) => {
        const n = Number(JSON.parse(v));
        if (!Number.isFinite(n))
          throw new Error("invalid number");
        return n;
      },
      required: false,
      defaultValue: 90000,
      description: "Enhancer-revise loop interval (ms)",
      dbTable: "core.runtime_flag",
      dbColumn: "value_jsonb",
      envOverride: false
    },
    ORCHESTRATOR_RECONCILER_MS: {
      name: "ORCHESTRATOR_RECONCILER_MS",
      class: "flag",
      parse: (v) => {
        const n = Number(JSON.parse(v));
        if (!Number.isFinite(n))
          throw new Error("invalid number");
        return n;
      },
      required: false,
      defaultValue: 30000,
      description: "Reconciler loop interval (ms)",
      dbTable: "core.runtime_flag",
      dbColumn: "value_jsonb",
      envOverride: false
    },
    ORCHESTRATOR_STALE_ROW_REAPER_MS: {
      name: "ORCHESTRATOR_STALE_ROW_REAPER_MS",
      class: "flag",
      parse: (v) => {
        const n = Number(JSON.parse(v));
        if (!Number.isFinite(n))
          throw new Error("invalid number");
        return n;
      },
      required: false,
      defaultValue: 300000,
      description: "Stale-row reaper interval (ms)",
      dbTable: "core.runtime_flag",
      dbColumn: "value_jsonb",
      envOverride: false
    },
    ORCHESTRATOR_STUCK_WORKER_MS: {
      name: "ORCHESTRATOR_STUCK_WORKER_MS",
      class: "flag",
      parse: (v) => {
        const n = Number(JSON.parse(v));
        if (!Number.isFinite(n))
          throw new Error("invalid number");
        return n;
      },
      required: false,
      defaultValue: 60000,
      description: "Stuck-worker watchdog interval (ms)",
      dbTable: "core.runtime_flag",
      dbColumn: "value_jsonb",
      envOverride: false
    },
    PROPOSAL_STATE_MONITOR_GRACE_PERIOD_SEC: {
      name: "PROPOSAL_STATE_MONITOR_GRACE_PERIOD_SEC",
      class: "flag",
      parse: (v) => {
        const n = Number(JSON.parse(v));
        if (!Number.isFinite(n) || n < 0)
          throw new Error("invalid number");
        return n;
      },
      required: false,
      defaultValue: 300,
      description: "State-monitor grace period (sec) after a gate hold/reject before maturity auto-advance is allowed (P2709)",
      dbTable: "core.runtime_flag",
      dbColumn: "value_jsonb",
      envOverride: false
    },
    ORCHESTRATOR_HEARTBEAT_MS: {
      name: "ORCHESTRATOR_HEARTBEAT_MS",
      class: "flag",
      parse: (v) => {
        const n = Number(JSON.parse(v));
        if (!Number.isFinite(n))
          throw new Error("invalid number");
        return n;
      },
      required: false,
      defaultValue: 60000,
      description: "Orchestrator heartbeat interval (ms)",
      dbTable: "core.runtime_flag",
      dbColumn: "value_jsonb",
      envOverride: false
    },
    ORCHESTRATOR_OFFER_CLAIM_ENABLED: {
      name: "ORCHESTRATOR_OFFER_CLAIM_ENABLED",
      class: "flag",
      parse: (v) => {
        try {
          return JSON.parse(v) === true;
        } catch {
          return v.toLowerCase() === "true" || v === "1";
        }
      },
      required: false,
      defaultValue: false,
      description: "Kill switch: false (default) disables the orchestrator offer-claim loop",
      dbTable: "core.runtime_flag",
      dbColumn: "value_jsonb",
      envOverride: false
    },
    ORCHESTRATOR_LEGACY_PUSH_DISPATCH_ENABLED: {
      name: "ORCHESTRATOR_LEGACY_PUSH_DISPATCH_ENABLED",
      class: "flag",
      parse: (v) => {
        try {
          return JSON.parse(v) === true;
        } catch {
          return v.toLowerCase() === "true" || v === "1";
        }
      },
      required: false,
      defaultValue: false,
      description: "V3-C6 AC-14: when true, re-enables the legacy heartbeat-derived offer_dispatch downlink push (default false = pure open-pool dispatch)",
      dbTable: "core.runtime_flag",
      dbColumn: "value_jsonb",
      envOverride: false
    },
    AGENCY_OFFER_CLAIM_ENABLED: {
      name: "AGENCY_OFFER_CLAIM_ENABLED",
      class: "flag",
      parse: (v) => {
        try {
          return JSON.parse(v) === true;
        } catch {
          return v.toLowerCase() === "true" || v === "1";
        }
      },
      required: false,
      defaultValue: false,
      description: "V3-C6: true makes each agency liaison self-claim work offers",
      dbTable: "core.runtime_flag",
      dbColumn: "value_jsonb",
      envOverride: false
    },
    PAUSE_FAILURE_THRESHOLD: {
      name: "PAUSE_FAILURE_THRESHOLD",
      class: "flag",
      parse: (v) => {
        const parsed = Number(JSON.parse(v));
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(`Invalid PAUSE_FAILURE_THRESHOLD: ${v}`);
        }
        return parsed;
      },
      required: true,
      description: "Number of consecutive no-eligible-agency failures before first pause (P1291)",
      dbTable: "core.runtime_flag",
      dbColumn: "value_jsonb",
      envOverride: false
    },
    PAUSE_BASE_BACKOFF_MS: {
      name: "PAUSE_BASE_BACKOFF_MS",
      class: "flag",
      parse: (v) => {
        const parsed = Number(JSON.parse(v));
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(`Invalid PAUSE_BASE_BACKOFF_MS: ${v}`);
        }
        return parsed;
      },
      required: true,
      description: "Base backoff duration in milliseconds for first pause cycle (default 1800000 = 30min)",
      dbTable: "core.runtime_flag",
      dbColumn: "value_jsonb",
      envOverride: false
    },
    PAUSE_BACKOFF_MULTIPLIER: {
      name: "PAUSE_BACKOFF_MULTIPLIER",
      class: "flag",
      parse: (v) => {
        const parsed = Number(JSON.parse(v));
        if (!Number.isFinite(parsed) || parsed < 1) {
          throw new Error(`Invalid PAUSE_BACKOFF_MULTIPLIER: ${v}`);
        }
        return parsed;
      },
      required: true,
      description: "Exponential backoff multiplier for each pause cycle (default 2)",
      dbTable: "core.runtime_flag",
      dbColumn: "value_jsonb",
      envOverride: false
    },
    PAUSE_MAX_BACKOFF_MS: {
      name: "PAUSE_MAX_BACKOFF_MS",
      class: "flag",
      parse: (v) => {
        const parsed = Number(JSON.parse(v));
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(`Invalid PAUSE_MAX_BACKOFF_MS: ${v}`);
        }
        return parsed;
      },
      required: true,
      description: "Hard cap on pause duration in milliseconds (default 86400000 = 24h)",
      dbTable: "core.runtime_flag",
      dbColumn: "value_jsonb",
      envOverride: false
    },
    SPAWN_PROVIDER_MAX_ATTEMPTS: {
      name: "SPAWN_PROVIDER_MAX_ATTEMPTS",
      class: "flag",
      parse: (v) => {
        const n = Number(JSON.parse(v));
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error(`Invalid SPAWN_PROVIDER_MAX_ATTEMPTS: ${v}`);
        }
        return n;
      },
      required: false,
      defaultValue: 3,
      description: "Max retry attempts when spawn hits provider-specific quota (P1359)",
      dbTable: "core.runtime_flag",
      dbColumn: "value_jsonb",
      envOverride: false
    },
    ADAPTIVE_MATCHER_ENABLED: {
      name: "ADAPTIVE_MATCHER_ENABLED",
      class: "flag",
      parse: (v) => {
        try {
          return JSON.parse(v) === true;
        } catch {
          return v.toLowerCase() === "true" || v === "1";
        }
      },
      required: false,
      defaultValue: false,
      description: "P3312: when false (default), matchWorkToRoute runs in shadow mode only — logs matcher_choice vs legacy_choice without changing dispatch behavior. Flip true once P3310+P3311 are COMPLETE.",
      dbTable: "core.runtime_flag",
      dbColumn: "value_jsonb",
      envOverride: false
    },
    TUI_COCKPIT_LAYOUT: {
      name: "AGENTHIVE_COCKPIT_LAYOUT",
      class: "flag",
      parse: (v) => {
        let raw;
        try {
          const decoded = JSON.parse(v);
          raw = typeof decoded === "string" ? decoded : v;
        } catch {
          raw = v;
        }
        const trimmed = raw.trim().toLowerCase();
        if (trimmed !== "grid" && trimmed !== "stacked") {
          throw new Error(`Invalid cockpit layout: ${v}. Must be 'grid' or 'stacked'.`);
        }
        return trimmed;
      },
      required: false,
      defaultValue: "grid",
      description: "TUI cockpit panel layout: 'grid' (2x2) or 'stacked' (single column).",
      dbTable: "core.runtime_flag",
      dbColumn: "value_jsonb",
      envOverride: true
    }
  };
  DiagnosticKeys = {
    DEBUG: {
      name: "DEBUG",
      class: "secret",
      parse: (v) => v.toLowerCase() === "true" || v === "1",
      required: false,
      description: "Enable debug logging"
    },
    DEBUG_PG: {
      name: "DEBUG_PG",
      class: "secret",
      parse: (v) => v.toLowerCase() === "true" || v === "1",
      required: false,
      description: "Enable PostgreSQL debug logging"
    },
    DEBUG_STATE_NAMES: {
      name: "DEBUG_STATE_NAMES",
      class: "structural",
      parse: (v) => v.toLowerCase() === "true" || v === "1",
      required: false,
      description: "Enable state-names registry debug logging"
    }
  };
  AllConfigKeys = {
    ...SecretKeys,
    ...StructuralKeys,
    ...RegistryKeys,
    ...FlagKeys,
    ...DiagnosticKeys
  };
});

// node_modules/postgres-array/index.js
var require_postgres_array = __commonJS((exports) => {
  exports.parse = function(source, transform) {
    return new ArrayParser(source, transform).parse();
  };

  class ArrayParser {
    constructor(source, transform) {
      this.source = source;
      this.transform = transform || identity;
      this.position = 0;
      this.entries = [];
      this.recorded = [];
      this.dimension = 0;
    }
    isEof() {
      return this.position >= this.source.length;
    }
    nextCharacter() {
      var character = this.source[this.position++];
      if (character === "\\") {
        return {
          value: this.source[this.position++],
          escaped: true
        };
      }
      return {
        value: character,
        escaped: false
      };
    }
    record(character) {
      this.recorded.push(character);
    }
    newEntry(includeEmpty) {
      var entry;
      if (this.recorded.length > 0 || includeEmpty) {
        entry = this.recorded.join("");
        if (entry === "NULL" && !includeEmpty) {
          entry = null;
        }
        if (entry !== null)
          entry = this.transform(entry);
        this.entries.push(entry);
        this.recorded = [];
      }
    }
    consumeDimensions() {
      if (this.source[0] === "[") {
        while (!this.isEof()) {
          var char = this.nextCharacter();
          if (char.value === "=")
            break;
        }
      }
    }
    parse(nested) {
      var character, parser, quote;
      this.consumeDimensions();
      while (!this.isEof()) {
        character = this.nextCharacter();
        if (character.value === "{" && !quote) {
          this.dimension++;
          if (this.dimension > 1) {
            parser = new ArrayParser(this.source.substr(this.position - 1), this.transform);
            this.entries.push(parser.parse(true));
            this.position += parser.position - 2;
          }
        } else if (character.value === "}" && !quote) {
          this.dimension--;
          if (!this.dimension) {
            this.newEntry();
            if (nested)
              return this.entries;
          }
        } else if (character.value === '"' && !character.escaped) {
          if (quote)
            this.newEntry(true);
          quote = !quote;
        } else if (character.value === "," && !quote) {
          this.newEntry();
        } else {
          this.record(character.value);
        }
      }
      if (this.dimension !== 0) {
        throw new Error("array dimension not balanced");
      }
      return this.entries;
    }
  }
  function identity(value) {
    return value;
  }
});

// node_modules/pg-types/lib/arrayParser.js
var require_arrayParser = __commonJS((exports, module) => {
  var array = require_postgres_array();
  module.exports = {
    create: function(source, transform) {
      return {
        parse: function() {
          return array.parse(source, transform);
        }
      };
    }
  };
});

// node_modules/postgres-date/index.js
var require_postgres_date = __commonJS((exports, module) => {
  var DATE_TIME = /(\d{1,})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(\.\d{1,})?.*?( BC)?$/;
  var DATE = /^(\d{1,})-(\d{2})-(\d{2})( BC)?$/;
  var TIME_ZONE = /([Z+-])(\d{2})?:?(\d{2})?:?(\d{2})?/;
  var INFINITY = /^-?infinity$/;
  module.exports = function parseDate(isoDate) {
    if (INFINITY.test(isoDate)) {
      return Number(isoDate.replace("i", "I"));
    }
    var matches = DATE_TIME.exec(isoDate);
    if (!matches) {
      return getDate(isoDate) || null;
    }
    var isBC = !!matches[8];
    var year = parseInt(matches[1], 10);
    if (isBC) {
      year = bcYearToNegativeYear(year);
    }
    var month = parseInt(matches[2], 10) - 1;
    var day = matches[3];
    var hour = parseInt(matches[4], 10);
    var minute = parseInt(matches[5], 10);
    var second = parseInt(matches[6], 10);
    var ms = matches[7];
    ms = ms ? 1000 * parseFloat(ms) : 0;
    var date;
    var offset = timeZoneOffset(isoDate);
    if (offset != null) {
      date = new Date(Date.UTC(year, month, day, hour, minute, second, ms));
      if (is0To99(year)) {
        date.setUTCFullYear(year);
      }
      if (offset !== 0) {
        date.setTime(date.getTime() - offset);
      }
    } else {
      date = new Date(year, month, day, hour, minute, second, ms);
      if (is0To99(year)) {
        date.setFullYear(year);
      }
    }
    return date;
  };
  function getDate(isoDate) {
    var matches = DATE.exec(isoDate);
    if (!matches) {
      return;
    }
    var year = parseInt(matches[1], 10);
    var isBC = !!matches[4];
    if (isBC) {
      year = bcYearToNegativeYear(year);
    }
    var month = parseInt(matches[2], 10) - 1;
    var day = matches[3];
    var date = new Date(year, month, day);
    if (is0To99(year)) {
      date.setFullYear(year);
    }
    return date;
  }
  function timeZoneOffset(isoDate) {
    if (isoDate.endsWith("+00")) {
      return 0;
    }
    var zone = TIME_ZONE.exec(isoDate.split(" ")[1]);
    if (!zone)
      return;
    var type = zone[1];
    if (type === "Z") {
      return 0;
    }
    var sign = type === "-" ? -1 : 1;
    var offset = parseInt(zone[2], 10) * 3600 + parseInt(zone[3] || 0, 10) * 60 + parseInt(zone[4] || 0, 10);
    return offset * sign * 1000;
  }
  function bcYearToNegativeYear(year) {
    return -(year - 1);
  }
  function is0To99(num) {
    return num >= 0 && num < 100;
  }
});

// node_modules/xtend/mutable.js
var require_mutable = __commonJS((exports, module) => {
  module.exports = extend;
  var hasOwnProperty = Object.prototype.hasOwnProperty;
  function extend(target) {
    for (var i = 1;i < arguments.length; i++) {
      var source = arguments[i];
      for (var key in source) {
        if (hasOwnProperty.call(source, key)) {
          target[key] = source[key];
        }
      }
    }
    return target;
  }
});

// node_modules/postgres-interval/index.js
var require_postgres_interval = __commonJS((exports, module) => {
  var extend = require_mutable();
  module.exports = PostgresInterval;
  function PostgresInterval(raw) {
    if (!(this instanceof PostgresInterval)) {
      return new PostgresInterval(raw);
    }
    extend(this, parse(raw));
  }
  var properties = ["seconds", "minutes", "hours", "days", "months", "years"];
  PostgresInterval.prototype.toPostgres = function() {
    var filtered = properties.filter(this.hasOwnProperty, this);
    if (this.milliseconds && filtered.indexOf("seconds") < 0) {
      filtered.push("seconds");
    }
    if (filtered.length === 0)
      return "0";
    return filtered.map(function(property) {
      var value = this[property] || 0;
      if (property === "seconds" && this.milliseconds) {
        value = (value + this.milliseconds / 1000).toFixed(6).replace(/\.?0+$/, "");
      }
      return value + " " + property;
    }, this).join(" ");
  };
  var propertiesISOEquivalent = {
    years: "Y",
    months: "M",
    days: "D",
    hours: "H",
    minutes: "M",
    seconds: "S"
  };
  var dateProperties = ["years", "months", "days"];
  var timeProperties = ["hours", "minutes", "seconds"];
  PostgresInterval.prototype.toISOString = PostgresInterval.prototype.toISO = function() {
    var datePart = dateProperties.map(buildProperty, this).join("");
    var timePart = timeProperties.map(buildProperty, this).join("");
    return "P" + datePart + "T" + timePart;
    function buildProperty(property) {
      var value = this[property] || 0;
      if (property === "seconds" && this.milliseconds) {
        value = (value + this.milliseconds / 1000).toFixed(6).replace(/0+$/, "");
      }
      return value + propertiesISOEquivalent[property];
    }
  };
  var NUMBER = "([+-]?\\d+)";
  var YEAR = NUMBER + "\\s+years?";
  var MONTH = NUMBER + "\\s+mons?";
  var DAY = NUMBER + "\\s+days?";
  var TIME = "([+-])?([\\d]*):(\\d\\d):(\\d\\d)\\.?(\\d{1,6})?";
  var INTERVAL = new RegExp([YEAR, MONTH, DAY, TIME].map(function(regexString) {
    return "(" + regexString + ")?";
  }).join("\\s*"));
  var positions = {
    years: 2,
    months: 4,
    days: 6,
    hours: 9,
    minutes: 10,
    seconds: 11,
    milliseconds: 12
  };
  var negatives = ["hours", "minutes", "seconds", "milliseconds"];
  function parseMilliseconds(fraction) {
    var microseconds = fraction + "000000".slice(fraction.length);
    return parseInt(microseconds, 10) / 1000;
  }
  function parse(interval) {
    if (!interval)
      return {};
    var matches = INTERVAL.exec(interval);
    var isNegative = matches[8] === "-";
    return Object.keys(positions).reduce(function(parsed, property) {
      var position = positions[property];
      var value = matches[position];
      if (!value)
        return parsed;
      value = property === "milliseconds" ? parseMilliseconds(value) : parseInt(value, 10);
      if (!value)
        return parsed;
      if (isNegative && ~negatives.indexOf(property)) {
        value *= -1;
      }
      parsed[property] = value;
      return parsed;
    }, {});
  }
});

// node_modules/postgres-bytea/index.js
var require_postgres_bytea = __commonJS((exports, module) => {
  var bufferFrom = Buffer.from || Buffer;
  module.exports = function parseBytea(input) {
    if (/^\\x/.test(input)) {
      return bufferFrom(input.substr(2), "hex");
    }
    var output = "";
    var i = 0;
    while (i < input.length) {
      if (input[i] !== "\\") {
        output += input[i];
        ++i;
      } else {
        if (/[0-7]{3}/.test(input.substr(i + 1, 3))) {
          output += String.fromCharCode(parseInt(input.substr(i + 1, 3), 8));
          i += 4;
        } else {
          var backslashes = 1;
          while (i + backslashes < input.length && input[i + backslashes] === "\\") {
            backslashes++;
          }
          for (var k2 = 0;k2 < Math.floor(backslashes / 2); ++k2) {
            output += "\\";
          }
          i += Math.floor(backslashes / 2) * 2;
        }
      }
    }
    return bufferFrom(output, "binary");
  };
});

// node_modules/pg-types/lib/textParsers.js
var require_textParsers = __commonJS((exports, module) => {
  var array = require_postgres_array();
  var arrayParser = require_arrayParser();
  var parseDate = require_postgres_date();
  var parseInterval = require_postgres_interval();
  var parseByteA = require_postgres_bytea();
  function allowNull(fn) {
    return function nullAllowed(value) {
      if (value === null)
        return value;
      return fn(value);
    };
  }
  function parseBool(value) {
    if (value === null)
      return value;
    return value === "TRUE" || value === "t" || value === "true" || value === "y" || value === "yes" || value === "on" || value === "1";
  }
  function parseBoolArray(value) {
    if (!value)
      return null;
    return array.parse(value, parseBool);
  }
  function parseBaseTenInt(string) {
    return parseInt(string, 10);
  }
  function parseIntegerArray(value) {
    if (!value)
      return null;
    return array.parse(value, allowNull(parseBaseTenInt));
  }
  function parseBigIntegerArray(value) {
    if (!value)
      return null;
    return array.parse(value, allowNull(function(entry) {
      return parseBigInteger(entry).trim();
    }));
  }
  var parsePointArray = function(value) {
    if (!value) {
      return null;
    }
    var p = arrayParser.create(value, function(entry) {
      if (entry !== null) {
        entry = parsePoint(entry);
      }
      return entry;
    });
    return p.parse();
  };
  var parseFloatArray = function(value) {
    if (!value) {
      return null;
    }
    var p = arrayParser.create(value, function(entry) {
      if (entry !== null) {
        entry = parseFloat(entry);
      }
      return entry;
    });
    return p.parse();
  };
  var parseStringArray = function(value) {
    if (!value) {
      return null;
    }
    var p = arrayParser.create(value);
    return p.parse();
  };
  var parseDateArray = function(value) {
    if (!value) {
      return null;
    }
    var p = arrayParser.create(value, function(entry) {
      if (entry !== null) {
        entry = parseDate(entry);
      }
      return entry;
    });
    return p.parse();
  };
  var parseIntervalArray = function(value) {
    if (!value) {
      return null;
    }
    var p = arrayParser.create(value, function(entry) {
      if (entry !== null) {
        entry = parseInterval(entry);
      }
      return entry;
    });
    return p.parse();
  };
  var parseByteAArray = function(value) {
    if (!value) {
      return null;
    }
    return array.parse(value, allowNull(parseByteA));
  };
  var parseInteger = function(value) {
    return parseInt(value, 10);
  };
  var parseBigInteger = function(value) {
    var valStr = String(value);
    if (/^\d+$/.test(valStr)) {
      return valStr;
    }
    return value;
  };
  var parseJsonArray = function(value) {
    if (!value) {
      return null;
    }
    return array.parse(value, allowNull(JSON.parse));
  };
  var parsePoint = function(value) {
    if (value[0] !== "(") {
      return null;
    }
    value = value.substring(1, value.length - 1).split(",");
    return {
      x: parseFloat(value[0]),
      y: parseFloat(value[1])
    };
  };
  var parseCircle = function(value) {
    if (value[0] !== "<" && value[1] !== "(") {
      return null;
    }
    var point = "(";
    var radius = "";
    var pointParsed = false;
    for (var i = 2;i < value.length - 1; i++) {
      if (!pointParsed) {
        point += value[i];
      }
      if (value[i] === ")") {
        pointParsed = true;
        continue;
      } else if (!pointParsed) {
        continue;
      }
      if (value[i] === ",") {
        continue;
      }
      radius += value[i];
    }
    var result = parsePoint(point);
    result.radius = parseFloat(radius);
    return result;
  };
  var init = function(register) {
    register(20, parseBigInteger);
    register(21, parseInteger);
    register(23, parseInteger);
    register(26, parseInteger);
    register(700, parseFloat);
    register(701, parseFloat);
    register(16, parseBool);
    register(1082, parseDate);
    register(1114, parseDate);
    register(1184, parseDate);
    register(600, parsePoint);
    register(651, parseStringArray);
    register(718, parseCircle);
    register(1000, parseBoolArray);
    register(1001, parseByteAArray);
    register(1005, parseIntegerArray);
    register(1007, parseIntegerArray);
    register(1028, parseIntegerArray);
    register(1016, parseBigIntegerArray);
    register(1017, parsePointArray);
    register(1021, parseFloatArray);
    register(1022, parseFloatArray);
    register(1231, parseFloatArray);
    register(1014, parseStringArray);
    register(1015, parseStringArray);
    register(1008, parseStringArray);
    register(1009, parseStringArray);
    register(1040, parseStringArray);
    register(1041, parseStringArray);
    register(1115, parseDateArray);
    register(1182, parseDateArray);
    register(1185, parseDateArray);
    register(1186, parseInterval);
    register(1187, parseIntervalArray);
    register(17, parseByteA);
    register(114, JSON.parse.bind(JSON));
    register(3802, JSON.parse.bind(JSON));
    register(199, parseJsonArray);
    register(3807, parseJsonArray);
    register(3907, parseStringArray);
    register(2951, parseStringArray);
    register(791, parseStringArray);
    register(1183, parseStringArray);
    register(1270, parseStringArray);
  };
  module.exports = {
    init
  };
});

// node_modules/pg-int8/index.js
var require_pg_int8 = __commonJS((exports, module) => {
  var BASE = 1e6;
  function readInt8(buffer) {
    var high = buffer.readInt32BE(0);
    var low = buffer.readUInt32BE(4);
    var sign = "";
    if (high < 0) {
      high = ~high + (low === 0);
      low = ~low + 1 >>> 0;
      sign = "-";
    }
    var result = "";
    var carry;
    var t;
    var digits;
    var pad;
    var l;
    var i;
    {
      carry = high % BASE;
      high = high / BASE >>> 0;
      t = 4294967296 * carry + low;
      low = t / BASE >>> 0;
      digits = "" + (t - BASE * low);
      if (low === 0 && high === 0) {
        return sign + digits + result;
      }
      pad = "";
      l = 6 - digits.length;
      for (i = 0;i < l; i++) {
        pad += "0";
      }
      result = pad + digits + result;
    }
    {
      carry = high % BASE;
      high = high / BASE >>> 0;
      t = 4294967296 * carry + low;
      low = t / BASE >>> 0;
      digits = "" + (t - BASE * low);
      if (low === 0 && high === 0) {
        return sign + digits + result;
      }
      pad = "";
      l = 6 - digits.length;
      for (i = 0;i < l; i++) {
        pad += "0";
      }
      result = pad + digits + result;
    }
    {
      carry = high % BASE;
      high = high / BASE >>> 0;
      t = 4294967296 * carry + low;
      low = t / BASE >>> 0;
      digits = "" + (t - BASE * low);
      if (low === 0 && high === 0) {
        return sign + digits + result;
      }
      pad = "";
      l = 6 - digits.length;
      for (i = 0;i < l; i++) {
        pad += "0";
      }
      result = pad + digits + result;
    }
    {
      carry = high % BASE;
      t = 4294967296 * carry + low;
      digits = "" + t % BASE;
      return sign + digits + result;
    }
  }
  module.exports = readInt8;
});

// node_modules/pg-types/lib/binaryParsers.js
var require_binaryParsers = __commonJS((exports, module) => {
  var parseInt64 = require_pg_int8();
  var parseBits = function(data, bits, offset, invert, callback) {
    offset = offset || 0;
    invert = invert || false;
    callback = callback || function(lastValue, newValue, bits2) {
      return lastValue * Math.pow(2, bits2) + newValue;
    };
    var offsetBytes = offset >> 3;
    var inv = function(value) {
      if (invert) {
        return ~value & 255;
      }
      return value;
    };
    var mask = 255;
    var firstBits = 8 - offset % 8;
    if (bits < firstBits) {
      mask = 255 << 8 - bits & 255;
      firstBits = bits;
    }
    if (offset) {
      mask = mask >> offset % 8;
    }
    var result = 0;
    if (offset % 8 + bits >= 8) {
      result = callback(0, inv(data[offsetBytes]) & mask, firstBits);
    }
    var bytes = bits + offset >> 3;
    for (var i = offsetBytes + 1;i < bytes; i++) {
      result = callback(result, inv(data[i]), 8);
    }
    var lastBits = (bits + offset) % 8;
    if (lastBits > 0) {
      result = callback(result, inv(data[bytes]) >> 8 - lastBits, lastBits);
    }
    return result;
  };
  var parseFloatFromBits = function(data, precisionBits, exponentBits) {
    var bias = Math.pow(2, exponentBits - 1) - 1;
    var sign = parseBits(data, 1);
    var exponent = parseBits(data, exponentBits, 1);
    if (exponent === 0) {
      return 0;
    }
    var precisionBitsCounter = 1;
    var parsePrecisionBits = function(lastValue, newValue, bits) {
      if (lastValue === 0) {
        lastValue = 1;
      }
      for (var i = 1;i <= bits; i++) {
        precisionBitsCounter /= 2;
        if ((newValue & 1 << bits - i) > 0) {
          lastValue += precisionBitsCounter;
        }
      }
      return lastValue;
    };
    var mantissa = parseBits(data, precisionBits, exponentBits + 1, false, parsePrecisionBits);
    if (exponent == Math.pow(2, exponentBits + 1) - 1) {
      if (mantissa === 0) {
        return sign === 0 ? Infinity : -Infinity;
      }
      return NaN;
    }
    return (sign === 0 ? 1 : -1) * Math.pow(2, exponent - bias) * mantissa;
  };
  var parseInt16 = function(value) {
    if (parseBits(value, 1) == 1) {
      return -1 * (parseBits(value, 15, 1, true) + 1);
    }
    return parseBits(value, 15, 1);
  };
  var parseInt32 = function(value) {
    if (parseBits(value, 1) == 1) {
      return -1 * (parseBits(value, 31, 1, true) + 1);
    }
    return parseBits(value, 31, 1);
  };
  var parseFloat32 = function(value) {
    return parseFloatFromBits(value, 23, 8);
  };
  var parseFloat64 = function(value) {
    return parseFloatFromBits(value, 52, 11);
  };
  var parseNumeric = function(value) {
    var sign = parseBits(value, 16, 32);
    if (sign == 49152) {
      return NaN;
    }
    var weight = Math.pow(1e4, parseBits(value, 16, 16));
    var result = 0;
    var digits = [];
    var ndigits = parseBits(value, 16);
    for (var i = 0;i < ndigits; i++) {
      result += parseBits(value, 16, 64 + 16 * i) * weight;
      weight /= 1e4;
    }
    var scale = Math.pow(10, parseBits(value, 16, 48));
    return (sign === 0 ? 1 : -1) * Math.round(result * scale) / scale;
  };
  var parseDate = function(isUTC, value) {
    var sign = parseBits(value, 1);
    var rawValue = parseBits(value, 63, 1);
    var result = new Date((sign === 0 ? 1 : -1) * rawValue / 1000 + 946684800000);
    if (!isUTC) {
      result.setTime(result.getTime() + result.getTimezoneOffset() * 60000);
    }
    result.usec = rawValue % 1000;
    result.getMicroSeconds = function() {
      return this.usec;
    };
    result.setMicroSeconds = function(value2) {
      this.usec = value2;
    };
    result.getUTCMicroSeconds = function() {
      return this.usec;
    };
    return result;
  };
  var parseArray = function(value) {
    var dim = parseBits(value, 32);
    var flags = parseBits(value, 32, 32);
    var elementType = parseBits(value, 32, 64);
    var offset = 96;
    var dims = [];
    for (var i = 0;i < dim; i++) {
      dims[i] = parseBits(value, 32, offset);
      offset += 32;
      offset += 32;
    }
    var parseElement = function(elementType2) {
      var length = parseBits(value, 32, offset);
      offset += 32;
      if (length == 4294967295) {
        return null;
      }
      var result;
      if (elementType2 == 23 || elementType2 == 20) {
        result = parseBits(value, length * 8, offset);
        offset += length * 8;
        return result;
      } else if (elementType2 == 25) {
        result = value.toString(this.encoding, offset >> 3, (offset += length << 3) >> 3);
        return result;
      } else {
        console.log("ERROR: ElementType not implemented: " + elementType2);
      }
    };
    var parse = function(dimension, elementType2) {
      var array = [];
      var i2;
      if (dimension.length > 1) {
        var count = dimension.shift();
        for (i2 = 0;i2 < count; i2++) {
          array[i2] = parse(dimension, elementType2);
        }
        dimension.unshift(count);
      } else {
        for (i2 = 0;i2 < dimension[0]; i2++) {
          array[i2] = parseElement(elementType2);
        }
      }
      return array;
    };
    return parse(dims, elementType);
  };
  var parseText = function(value) {
    return value.toString("utf8");
  };
  var parseBool = function(value) {
    if (value === null)
      return null;
    return parseBits(value, 8) > 0;
  };
  var init = function(register) {
    register(20, parseInt64);
    register(21, parseInt16);
    register(23, parseInt32);
    register(26, parseInt32);
    register(1700, parseNumeric);
    register(700, parseFloat32);
    register(701, parseFloat64);
    register(16, parseBool);
    register(1114, parseDate.bind(null, false));
    register(1184, parseDate.bind(null, true));
    register(1000, parseArray);
    register(1007, parseArray);
    register(1016, parseArray);
    register(1008, parseArray);
    register(1009, parseArray);
    register(25, parseText);
  };
  module.exports = {
    init
  };
});

// node_modules/pg-types/lib/builtins.js
var require_builtins = __commonJS((exports, module) => {
  module.exports = {
    BOOL: 16,
    BYTEA: 17,
    CHAR: 18,
    INT8: 20,
    INT2: 21,
    INT4: 23,
    REGPROC: 24,
    TEXT: 25,
    OID: 26,
    TID: 27,
    XID: 28,
    CID: 29,
    JSON: 114,
    XML: 142,
    PG_NODE_TREE: 194,
    SMGR: 210,
    PATH: 602,
    POLYGON: 604,
    CIDR: 650,
    FLOAT4: 700,
    FLOAT8: 701,
    ABSTIME: 702,
    RELTIME: 703,
    TINTERVAL: 704,
    CIRCLE: 718,
    MACADDR8: 774,
    MONEY: 790,
    MACADDR: 829,
    INET: 869,
    ACLITEM: 1033,
    BPCHAR: 1042,
    VARCHAR: 1043,
    DATE: 1082,
    TIME: 1083,
    TIMESTAMP: 1114,
    TIMESTAMPTZ: 1184,
    INTERVAL: 1186,
    TIMETZ: 1266,
    BIT: 1560,
    VARBIT: 1562,
    NUMERIC: 1700,
    REFCURSOR: 1790,
    REGPROCEDURE: 2202,
    REGOPER: 2203,
    REGOPERATOR: 2204,
    REGCLASS: 2205,
    REGTYPE: 2206,
    UUID: 2950,
    TXID_SNAPSHOT: 2970,
    PG_LSN: 3220,
    PG_NDISTINCT: 3361,
    PG_DEPENDENCIES: 3402,
    TSVECTOR: 3614,
    TSQUERY: 3615,
    GTSVECTOR: 3642,
    REGCONFIG: 3734,
    REGDICTIONARY: 3769,
    JSONB: 3802,
    REGNAMESPACE: 4089,
    REGROLE: 4096
  };
});

// node_modules/pg-types/index.js
var require_pg_types = __commonJS((exports) => {
  var textParsers = require_textParsers();
  var binaryParsers = require_binaryParsers();
  var arrayParser = require_arrayParser();
  var builtinTypes = require_builtins();
  exports.getTypeParser = getTypeParser;
  exports.setTypeParser = setTypeParser;
  exports.arrayParser = arrayParser;
  exports.builtins = builtinTypes;
  var typeParsers = {
    text: {},
    binary: {}
  };
  function noParse(val) {
    return String(val);
  }
  function getTypeParser(oid, format) {
    format = format || "text";
    if (!typeParsers[format]) {
      return noParse;
    }
    return typeParsers[format][oid] || noParse;
  }
  function setTypeParser(oid, format, parseFn) {
    if (typeof format == "function") {
      parseFn = format;
      format = "text";
    }
    typeParsers[format][oid] = parseFn;
  }
  textParsers.init(function(oid, converter) {
    typeParsers.text[oid] = converter;
  });
  binaryParsers.init(function(oid, converter) {
    typeParsers.binary[oid] = converter;
  });
});

// node_modules/pg/lib/defaults.js
var require_defaults = __commonJS((exports, module) => {
  var user;
  try {
    user = process.platform === "win32" ? process.env.USERNAME : process.env.USER;
  } catch {}
  module.exports = {
    host: "localhost",
    user,
    database: undefined,
    password: null,
    connectionString: undefined,
    port: 5432,
    rows: 0,
    binary: false,
    max: 10,
    idleTimeoutMillis: 30000,
    client_encoding: "",
    ssl: false,
    application_name: undefined,
    fallback_application_name: undefined,
    options: undefined,
    parseInputDatesAsUTC: false,
    statement_timeout: false,
    lock_timeout: false,
    idle_in_transaction_session_timeout: false,
    query_timeout: false,
    connect_timeout: 0,
    keepalives: 1,
    keepalives_idle: 0
  };
  var pgTypes = require_pg_types();
  var parseBigInteger = pgTypes.getTypeParser(20, "text");
  var parseBigIntegerArray = pgTypes.getTypeParser(1016, "text");
  module.exports.__defineSetter__("parseInt8", function(val) {
    pgTypes.setTypeParser(20, "text", val ? pgTypes.getTypeParser(23, "text") : parseBigInteger);
    pgTypes.setTypeParser(1016, "text", val ? pgTypes.getTypeParser(1007, "text") : parseBigIntegerArray);
  });
});

// node_modules/pg/lib/utils.js
var require_utils = __commonJS((exports, module) => {
  var defaults = require_defaults();
  var util = __require("util");
  var { isDate } = util.types || util;
  function escapeElement(elementRepresentation) {
    const escaped = elementRepresentation.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
    return '"' + escaped + '"';
  }
  function arrayString(val) {
    let result = "{";
    for (let i = 0;i < val.length; i++) {
      if (i > 0) {
        result = result + ",";
      }
      if (val[i] === null || typeof val[i] === "undefined") {
        result = result + "NULL";
      } else if (Array.isArray(val[i])) {
        result = result + arrayString(val[i]);
      } else if (ArrayBuffer.isView(val[i])) {
        let item = val[i];
        if (!(item instanceof Buffer)) {
          const buf = Buffer.from(item.buffer, item.byteOffset, item.byteLength);
          if (buf.length === item.byteLength) {
            item = buf;
          } else {
            item = buf.slice(item.byteOffset, item.byteOffset + item.byteLength);
          }
        }
        result += "\\\\x" + item.toString("hex");
      } else {
        result += escapeElement(prepareValue(val[i]));
      }
    }
    result = result + "}";
    return result;
  }
  var prepareValue = function(val, seen) {
    if (val == null) {
      return null;
    }
    if (typeof val === "object") {
      if (val instanceof Buffer) {
        return val;
      }
      if (ArrayBuffer.isView(val)) {
        const buf = Buffer.from(val.buffer, val.byteOffset, val.byteLength);
        if (buf.length === val.byteLength) {
          return buf;
        }
        return buf.slice(val.byteOffset, val.byteOffset + val.byteLength);
      }
      if (isDate(val)) {
        if (defaults.parseInputDatesAsUTC) {
          return dateToStringUTC(val);
        } else {
          return dateToString(val);
        }
      }
      if (Array.isArray(val)) {
        return arrayString(val);
      }
      return prepareObject(val, seen);
    }
    return val.toString();
  };
  function prepareObject(val, seen) {
    if (val && typeof val.toPostgres === "function") {
      seen = seen || [];
      if (seen.indexOf(val) !== -1) {
        throw new Error('circular reference detected while preparing "' + val + '" for query');
      }
      seen.push(val);
      return prepareValue(val.toPostgres(prepareValue), seen);
    }
    return JSON.stringify(val);
  }
  function dateToString(date) {
    let offset = -date.getTimezoneOffset();
    let year = date.getFullYear();
    const isBCYear = year < 1;
    if (isBCYear)
      year = Math.abs(year) + 1;
    let ret = String(year).padStart(4, "0") + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0") + "T" + String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0") + ":" + String(date.getSeconds()).padStart(2, "0") + "." + String(date.getMilliseconds()).padStart(3, "0");
    if (offset < 0) {
      ret += "-";
      offset *= -1;
    } else {
      ret += "+";
    }
    ret += String(Math.floor(offset / 60)).padStart(2, "0") + ":" + String(offset % 60).padStart(2, "0");
    if (isBCYear)
      ret += " BC";
    return ret;
  }
  function dateToStringUTC(date) {
    let year = date.getUTCFullYear();
    const isBCYear = year < 1;
    if (isBCYear)
      year = Math.abs(year) + 1;
    let ret = String(year).padStart(4, "0") + "-" + String(date.getUTCMonth() + 1).padStart(2, "0") + "-" + String(date.getUTCDate()).padStart(2, "0") + "T" + String(date.getUTCHours()).padStart(2, "0") + ":" + String(date.getUTCMinutes()).padStart(2, "0") + ":" + String(date.getUTCSeconds()).padStart(2, "0") + "." + String(date.getUTCMilliseconds()).padStart(3, "0");
    ret += "+00:00";
    if (isBCYear)
      ret += " BC";
    return ret;
  }
  function normalizeQueryConfig(config, values, callback) {
    config = typeof config === "string" ? { text: config } : config;
    if (values) {
      if (typeof values === "function") {
        config.callback = values;
      } else {
        config.values = values;
      }
    }
    if (callback) {
      config.callback = callback;
    }
    return config;
  }
  var escapeIdentifier = function(str) {
    return '"' + str.replace(/"/g, '""') + '"';
  };
  var escapeLiteral = function(str) {
    let hasBackslash = false;
    let escaped = "'";
    if (str == null) {
      return "''";
    }
    if (typeof str !== "string") {
      return "''";
    }
    for (let i = 0;i < str.length; i++) {
      const c = str[i];
      if (c === "'") {
        escaped += c + c;
      } else if (c === "\\") {
        escaped += c + c;
        hasBackslash = true;
      } else {
        escaped += c;
      }
    }
    escaped += "'";
    if (hasBackslash === true) {
      escaped = " E" + escaped;
    }
    return escaped;
  };
  module.exports = {
    prepareValue: function prepareValueWrapper(value) {
      return prepareValue(value);
    },
    normalizeQueryConfig,
    escapeIdentifier,
    escapeLiteral
  };
});

// node_modules/pg/lib/crypto/utils-legacy.js
var require_utils_legacy = __commonJS((exports, module) => {
  var nodeCrypto = __require("crypto");
  function md5(string) {
    return nodeCrypto.createHash("md5").update(string, "utf-8").digest("hex");
  }
  function postgresMd5PasswordHash(user, password, salt) {
    const inner = md5(password + user);
    const outer = md5(Buffer.concat([Buffer.from(inner), salt]));
    return "md5" + outer;
  }
  function sha256(text) {
    return nodeCrypto.createHash("sha256").update(text).digest();
  }
  function hashByName(hashName, text) {
    hashName = hashName.replace(/(\D)-/, "$1");
    return nodeCrypto.createHash(hashName).update(text).digest();
  }
  function hmacSha256(key, msg) {
    return nodeCrypto.createHmac("sha256", key).update(msg).digest();
  }
  async function deriveKey(password, salt, iterations) {
    return nodeCrypto.pbkdf2Sync(password, salt, iterations, 32, "sha256");
  }
  module.exports = {
    postgresMd5PasswordHash,
    randomBytes: nodeCrypto.randomBytes,
    deriveKey,
    sha256,
    hashByName,
    hmacSha256,
    md5
  };
});

// node_modules/pg/lib/crypto/utils-webcrypto.js
var require_utils_webcrypto = __commonJS((exports, module) => {
  var nodeCrypto = __require("crypto");
  module.exports = {
    postgresMd5PasswordHash,
    randomBytes,
    deriveKey,
    sha256,
    hashByName,
    hmacSha256,
    md5
  };
  var webCrypto = nodeCrypto.webcrypto || globalThis.crypto;
  var subtleCrypto = webCrypto.subtle;
  var textEncoder = new TextEncoder;
  function randomBytes(length) {
    return webCrypto.getRandomValues(Buffer.alloc(length));
  }
  async function md5(string) {
    try {
      return nodeCrypto.createHash("md5").update(string, "utf-8").digest("hex");
    } catch (e2) {
      const data = typeof string === "string" ? textEncoder.encode(string) : string;
      const hash = await subtleCrypto.digest("MD5", data);
      return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
    }
  }
  async function postgresMd5PasswordHash(user, password, salt) {
    const inner = await md5(password + user);
    const outer = await md5(Buffer.concat([Buffer.from(inner), salt]));
    return "md5" + outer;
  }
  async function sha256(text) {
    return await subtleCrypto.digest("SHA-256", text);
  }
  async function hashByName(hashName, text) {
    return await subtleCrypto.digest(hashName, text);
  }
  async function hmacSha256(keyBuffer, msg) {
    const key = await subtleCrypto.importKey("raw", keyBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return await subtleCrypto.sign("HMAC", key, textEncoder.encode(msg));
  }
  async function deriveKey(password, salt, iterations) {
    const key = await subtleCrypto.importKey("raw", textEncoder.encode(password), "PBKDF2", false, ["deriveBits"]);
    const params = { name: "PBKDF2", hash: "SHA-256", salt, iterations };
    return await subtleCrypto.deriveBits(params, key, 32 * 8, ["deriveBits"]);
  }
});

// node_modules/pg/lib/crypto/utils.js
var require_utils2 = __commonJS((exports, module) => {
  var useLegacyCrypto = parseInt(process.versions && process.versions.node && process.versions.node.split(".")[0]) < 15;
  if (useLegacyCrypto) {
    module.exports = require_utils_legacy();
  } else {
    module.exports = require_utils_webcrypto();
  }
});

// node_modules/pg/lib/crypto/cert-signatures.js
var require_cert_signatures = __commonJS((exports, module) => {
  function x509Error(msg, cert) {
    return new Error("SASL channel binding: " + msg + " when parsing public certificate " + cert.toString("base64"));
  }
  function readASN1Length(data, index) {
    let length = data[index++];
    if (length < 128)
      return { length, index };
    const lengthBytes = length & 127;
    if (lengthBytes > 4)
      throw x509Error("bad length", data);
    length = 0;
    for (let i = 0;i < lengthBytes; i++) {
      length = length << 8 | data[index++];
    }
    return { length, index };
  }
  function readASN1OID(data, index) {
    if (data[index++] !== 6)
      throw x509Error("non-OID data", data);
    const { length: OIDLength, index: indexAfterOIDLength } = readASN1Length(data, index);
    index = indexAfterOIDLength;
    const lastIndex = index + OIDLength;
    const byte1 = data[index++];
    let oid = (byte1 / 40 >> 0) + "." + byte1 % 40;
    while (index < lastIndex) {
      let value = 0;
      while (index < lastIndex) {
        const nextByte = data[index++];
        value = value << 7 | nextByte & 127;
        if (nextByte < 128)
          break;
      }
      oid += "." + value;
    }
    return { oid, index };
  }
  function expectASN1Seq(data, index) {
    if (data[index++] !== 48)
      throw x509Error("non-sequence data", data);
    return readASN1Length(data, index);
  }
  function signatureAlgorithmHashFromCertificate(data, index) {
    if (index === undefined)
      index = 0;
    index = expectASN1Seq(data, index).index;
    const { length: certInfoLength, index: indexAfterCertInfoLength } = expectASN1Seq(data, index);
    index = indexAfterCertInfoLength + certInfoLength;
    index = expectASN1Seq(data, index).index;
    const { oid, index: indexAfterOID } = readASN1OID(data, index);
    switch (oid) {
      case "1.2.840.113549.1.1.4":
        return "MD5";
      case "1.2.840.113549.1.1.5":
        return "SHA-1";
      case "1.2.840.113549.1.1.11":
        return "SHA-256";
      case "1.2.840.113549.1.1.12":
        return "SHA-384";
      case "1.2.840.113549.1.1.13":
        return "SHA-512";
      case "1.2.840.113549.1.1.14":
        return "SHA-224";
      case "1.2.840.113549.1.1.15":
        return "SHA512-224";
      case "1.2.840.113549.1.1.16":
        return "SHA512-256";
      case "1.2.840.10045.4.1":
        return "SHA-1";
      case "1.2.840.10045.4.3.1":
        return "SHA-224";
      case "1.2.840.10045.4.3.2":
        return "SHA-256";
      case "1.2.840.10045.4.3.3":
        return "SHA-384";
      case "1.2.840.10045.4.3.4":
        return "SHA-512";
      case "1.2.840.113549.1.1.10": {
        index = indexAfterOID;
        index = expectASN1Seq(data, index).index;
        if (data[index++] !== 160)
          throw x509Error("non-tag data", data);
        index = readASN1Length(data, index).index;
        index = expectASN1Seq(data, index).index;
        const { oid: hashOID } = readASN1OID(data, index);
        switch (hashOID) {
          case "1.2.840.113549.2.5":
            return "MD5";
          case "1.3.14.3.2.26":
            return "SHA-1";
          case "2.16.840.1.101.3.4.2.1":
            return "SHA-256";
          case "2.16.840.1.101.3.4.2.2":
            return "SHA-384";
          case "2.16.840.1.101.3.4.2.3":
            return "SHA-512";
        }
        throw x509Error("unknown hash OID " + hashOID, data);
      }
      case "1.3.101.110":
      case "1.3.101.112":
        return "SHA-512";
      case "1.3.101.111":
      case "1.3.101.113":
        throw x509Error("Ed448 certificate channel binding is not currently supported by Postgres");
    }
    throw x509Error("unknown OID " + oid, data);
  }
  module.exports = { signatureAlgorithmHashFromCertificate };
});

// node_modules/pg/lib/crypto/sasl.js
var require_sasl = __commonJS((exports, module) => {
  var crypto = require_utils2();
  var { signatureAlgorithmHashFromCertificate } = require_cert_signatures();
  function startSession(mechanisms, stream) {
    const candidates = ["SCRAM-SHA-256"];
    if (stream)
      candidates.unshift("SCRAM-SHA-256-PLUS");
    const mechanism = candidates.find((candidate) => mechanisms.includes(candidate));
    if (!mechanism) {
      throw new Error("SASL: Only mechanism(s) " + candidates.join(" and ") + " are supported");
    }
    if (mechanism === "SCRAM-SHA-256-PLUS" && typeof stream.getPeerCertificate !== "function") {
      throw new Error("SASL: Mechanism SCRAM-SHA-256-PLUS requires a certificate");
    }
    const clientNonce = crypto.randomBytes(18).toString("base64");
    const gs2Header = mechanism === "SCRAM-SHA-256-PLUS" ? "p=tls-server-end-point" : stream ? "y" : "n";
    return {
      mechanism,
      clientNonce,
      response: gs2Header + ",,n=*,r=" + clientNonce,
      message: "SASLInitialResponse"
    };
  }
  async function continueSession(session, password, serverData, stream) {
    if (session.message !== "SASLInitialResponse") {
      throw new Error("SASL: Last message was not SASLInitialResponse");
    }
    if (typeof password !== "string") {
      throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string");
    }
    if (password === "") {
      throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a non-empty string");
    }
    if (typeof serverData !== "string") {
      throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: serverData must be a string");
    }
    const sv = parseServerFirstMessage(serverData);
    if (!sv.nonce.startsWith(session.clientNonce)) {
      throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: server nonce does not start with client nonce");
    } else if (sv.nonce.length === session.clientNonce.length) {
      throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: server nonce is too short");
    }
    const clientFirstMessageBare = "n=*,r=" + session.clientNonce;
    const serverFirstMessage = "r=" + sv.nonce + ",s=" + sv.salt + ",i=" + sv.iteration;
    let channelBinding = stream ? "eSws" : "biws";
    if (session.mechanism === "SCRAM-SHA-256-PLUS") {
      const peerCert = stream.getPeerCertificate().raw;
      let hashName = signatureAlgorithmHashFromCertificate(peerCert);
      if (hashName === "MD5" || hashName === "SHA-1")
        hashName = "SHA-256";
      const certHash = await crypto.hashByName(hashName, peerCert);
      const bindingData = Buffer.concat([Buffer.from("p=tls-server-end-point,,"), Buffer.from(certHash)]);
      channelBinding = bindingData.toString("base64");
    }
    const clientFinalMessageWithoutProof = "c=" + channelBinding + ",r=" + sv.nonce;
    const authMessage = clientFirstMessageBare + "," + serverFirstMessage + "," + clientFinalMessageWithoutProof;
    const saltBytes = Buffer.from(sv.salt, "base64");
    const saltedPassword = await crypto.deriveKey(password, saltBytes, sv.iteration);
    const clientKey = await crypto.hmacSha256(saltedPassword, "Client Key");
    const storedKey = await crypto.sha256(clientKey);
    const clientSignature = await crypto.hmacSha256(storedKey, authMessage);
    const clientProof = xorBuffers(Buffer.from(clientKey), Buffer.from(clientSignature)).toString("base64");
    const serverKey = await crypto.hmacSha256(saltedPassword, "Server Key");
    const serverSignatureBytes = await crypto.hmacSha256(serverKey, authMessage);
    session.message = "SASLResponse";
    session.serverSignature = Buffer.from(serverSignatureBytes).toString("base64");
    session.response = clientFinalMessageWithoutProof + ",p=" + clientProof;
  }
  function finalizeSession(session, serverData) {
    if (session.message !== "SASLResponse") {
      throw new Error("SASL: Last message was not SASLResponse");
    }
    if (typeof serverData !== "string") {
      throw new Error("SASL: SCRAM-SERVER-FINAL-MESSAGE: serverData must be a string");
    }
    const { serverSignature } = parseServerFinalMessage(serverData);
    if (serverSignature !== session.serverSignature) {
      throw new Error("SASL: SCRAM-SERVER-FINAL-MESSAGE: server signature does not match");
    }
  }
  function isPrintableChars(text) {
    if (typeof text !== "string") {
      throw new TypeError("SASL: text must be a string");
    }
    return text.split("").map((_2, i) => text.charCodeAt(i)).every((c) => c >= 33 && c <= 43 || c >= 45 && c <= 126);
  }
  function isBase64(text) {
    return /^(?:[a-zA-Z0-9+/]{4})*(?:[a-zA-Z0-9+/]{2}==|[a-zA-Z0-9+/]{3}=)?$/.test(text);
  }
  function parseAttributePairs(text) {
    if (typeof text !== "string") {
      throw new TypeError("SASL: attribute pairs text must be a string");
    }
    return new Map(text.split(",").map((attrValue) => {
      if (!/^.=/.test(attrValue)) {
        throw new Error("SASL: Invalid attribute pair entry");
      }
      const name = attrValue[0];
      const value = attrValue.substring(2);
      return [name, value];
    }));
  }
  function parseServerFirstMessage(data) {
    const attrPairs = parseAttributePairs(data);
    const nonce = attrPairs.get("r");
    if (!nonce) {
      throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: nonce missing");
    } else if (!isPrintableChars(nonce)) {
      throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: nonce must only contain printable characters");
    }
    const salt = attrPairs.get("s");
    if (!salt) {
      throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: salt missing");
    } else if (!isBase64(salt)) {
      throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: salt must be base64");
    }
    const iterationText = attrPairs.get("i");
    if (!iterationText) {
      throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: iteration missing");
    } else if (!/^[1-9][0-9]*$/.test(iterationText)) {
      throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: invalid iteration count");
    }
    const iteration = parseInt(iterationText, 10);
    return {
      nonce,
      salt,
      iteration
    };
  }
  function parseServerFinalMessage(serverData) {
    const attrPairs = parseAttributePairs(serverData);
    const serverSignature = attrPairs.get("v");
    if (!serverSignature) {
      throw new Error("SASL: SCRAM-SERVER-FINAL-MESSAGE: server signature is missing");
    } else if (!isBase64(serverSignature)) {
      throw new Error("SASL: SCRAM-SERVER-FINAL-MESSAGE: server signature must be base64");
    }
    return {
      serverSignature
    };
  }
  function xorBuffers(a, b) {
    if (!Buffer.isBuffer(a)) {
      throw new TypeError("first argument must be a Buffer");
    }
    if (!Buffer.isBuffer(b)) {
      throw new TypeError("second argument must be a Buffer");
    }
    if (a.length !== b.length) {
      throw new Error("Buffer lengths must match");
    }
    if (a.length === 0) {
      throw new Error("Buffers cannot be empty");
    }
    return Buffer.from(a.map((_2, i) => a[i] ^ b[i]));
  }
  module.exports = {
    startSession,
    continueSession,
    finalizeSession
  };
});

// node_modules/pg/lib/type-overrides.js
var require_type_overrides = __commonJS((exports, module) => {
  var types = require_pg_types();
  function TypeOverrides(userTypes) {
    this._types = userTypes || types;
    this.text = {};
    this.binary = {};
  }
  TypeOverrides.prototype.getOverrides = function(format) {
    switch (format) {
      case "text":
        return this.text;
      case "binary":
        return this.binary;
      default:
        return {};
    }
  };
  TypeOverrides.prototype.setTypeParser = function(oid, format, parseFn) {
    if (typeof format === "function") {
      parseFn = format;
      format = "text";
    }
    this.getOverrides(format)[oid] = parseFn;
  };
  TypeOverrides.prototype.getTypeParser = function(oid, format) {
    format = format || "text";
    return this.getOverrides(format)[oid] || this._types.getTypeParser(oid, format);
  };
  module.exports = TypeOverrides;
});

// node_modules/pg-connection-string/index.js
var require_pg_connection_string = __commonJS((exports, module) => {
  function parse(str, options = {}) {
    if (str.charAt(0) === "/") {
      const config2 = str.split(" ");
      return { host: config2[0], database: config2[1] };
    }
    const config = {};
    let result;
    let dummyHost = false;
    if (/ |%[^a-f0-9]|%[a-f0-9][^a-f0-9]/i.test(str)) {
      str = encodeURI(str).replace(/%25(\d\d)/g, "%$1");
    }
    try {
      try {
        result = new URL(str, "postgres://base");
      } catch (e2) {
        result = new URL(str.replace("@/", "@___DUMMY___/"), "postgres://base");
        dummyHost = true;
      }
    } catch (err) {
      err.input && (err.input = "*****REDACTED*****");
      throw err;
    }
    for (const entry of result.searchParams.entries()) {
      config[entry[0]] = entry[1];
    }
    config.user = config.user || decodeURIComponent(result.username);
    config.password = config.password || decodeURIComponent(result.password);
    if (result.protocol == "socket:") {
      config.host = decodeURI(result.pathname);
      config.database = result.searchParams.get("db");
      config.client_encoding = result.searchParams.get("encoding");
      return config;
    }
    const hostname = dummyHost ? "" : result.hostname;
    if (!config.host) {
      config.host = decodeURIComponent(hostname);
    } else if (hostname && /^%2f/i.test(hostname)) {
      result.pathname = hostname + result.pathname;
    }
    if (!config.port) {
      config.port = result.port;
    }
    const pathname = result.pathname.slice(1) || null;
    config.database = pathname ? decodeURI(pathname) : null;
    if (config.ssl === "true" || config.ssl === "1") {
      config.ssl = true;
    }
    if (config.ssl === "0") {
      config.ssl = false;
    }
    if (config.sslcert || config.sslkey || config.sslrootcert || config.sslmode) {
      config.ssl = {};
    }
    const fs = config.sslcert || config.sslkey || config.sslrootcert ? __require("fs") : null;
    if (config.sslcert) {
      config.ssl.cert = fs.readFileSync(config.sslcert).toString();
    }
    if (config.sslkey) {
      config.ssl.key = fs.readFileSync(config.sslkey).toString();
    }
    if (config.sslrootcert) {
      config.ssl.ca = fs.readFileSync(config.sslrootcert).toString();
    }
    if (options.useLibpqCompat && config.uselibpqcompat) {
      throw new Error("Both useLibpqCompat and uselibpqcompat are set. Please use only one of them.");
    }
    if (config.uselibpqcompat === "true" || options.useLibpqCompat) {
      switch (config.sslmode) {
        case "disable": {
          config.ssl = false;
          break;
        }
        case "prefer": {
          config.ssl.rejectUnauthorized = false;
          break;
        }
        case "require": {
          if (config.sslrootcert) {
            config.ssl.checkServerIdentity = function() {};
          } else {
            config.ssl.rejectUnauthorized = false;
          }
          break;
        }
        case "verify-ca": {
          if (!config.ssl.ca) {
            throw new Error("SECURITY WARNING: Using sslmode=verify-ca requires specifying a CA with sslrootcert. If a public CA is used, verify-ca allows connections to a server that somebody else may have registered with the CA, making you vulnerable to Man-in-the-Middle attacks. Either specify a custom CA certificate with sslrootcert parameter or use sslmode=verify-full for proper security.");
          }
          config.ssl.checkServerIdentity = function() {};
          break;
        }
        case "verify-full": {
          break;
        }
      }
    } else {
      switch (config.sslmode) {
        case "disable": {
          config.ssl = false;
          break;
        }
        case "prefer":
        case "require":
        case "verify-ca":
        case "verify-full": {
          if (config.sslmode !== "verify-full") {
            deprecatedSslModeWarning(config.sslmode);
          }
          break;
        }
        case "no-verify": {
          config.ssl.rejectUnauthorized = false;
          break;
        }
      }
    }
    return config;
  }
  function toConnectionOptions(sslConfig) {
    const connectionOptions = Object.entries(sslConfig).reduce((c, [key, value]) => {
      if (value !== undefined && value !== null) {
        c[key] = value;
      }
      return c;
    }, {});
    return connectionOptions;
  }
  function toClientConfig(config) {
    const poolConfig = Object.entries(config).reduce((c, [key, value]) => {
      if (key === "ssl") {
        const sslConfig = value;
        if (typeof sslConfig === "boolean") {
          c[key] = sslConfig;
        }
        if (typeof sslConfig === "object") {
          c[key] = toConnectionOptions(sslConfig);
        }
      } else if (value !== undefined && value !== null) {
        if (key === "port") {
          if (value !== "") {
            const v = parseInt(value, 10);
            if (isNaN(v)) {
              throw new Error(`Invalid ${key}: ${value}`);
            }
            c[key] = v;
          }
        } else {
          c[key] = value;
        }
      }
      return c;
    }, {});
    return poolConfig;
  }
  function parseIntoClientConfig(str) {
    return toClientConfig(parse(str));
  }
  function deprecatedSslModeWarning(sslmode) {
    if (!deprecatedSslModeWarning.warned && typeof process !== "undefined" && process.emitWarning) {
      deprecatedSslModeWarning.warned = true;
      process.emitWarning(`SECURITY WARNING: The SSL modes 'prefer', 'require', and 'verify-ca' are treated as aliases for 'verify-full'.
In the next major version (pg-connection-string v3.0.0 and pg v9.0.0), these modes will adopt standard libpq semantics, which have weaker security guarantees.

To prepare for this change:
- If you want the current behavior, explicitly use 'sslmode=verify-full'
- If you want libpq compatibility now, use 'uselibpqcompat=true&sslmode=${sslmode}'

See https://www.postgresql.org/docs/current/libpq-ssl.html for libpq SSL mode definitions.`);
    }
  }
  module.exports = parse;
  parse.parse = parse;
  parse.toClientConfig = toClientConfig;
  parse.parseIntoClientConfig = parseIntoClientConfig;
});

// node_modules/pg/lib/connection-parameters.js
var require_connection_parameters = __commonJS((exports, module) => {
  var dns = __require("dns");
  var defaults = require_defaults();
  var parse = require_pg_connection_string().parse;
  var val = function(key, config, envVar) {
    if (config[key]) {
      return config[key];
    }
    if (envVar === undefined) {
      envVar = process.env["PG" + key.toUpperCase()];
    } else if (envVar === false) {} else {
      envVar = process.env[envVar];
    }
    return envVar || defaults[key];
  };
  var readSSLConfigFromEnvironment = function() {
    switch (process.env.PGSSLMODE) {
      case "disable":
        return false;
      case "prefer":
      case "require":
      case "verify-ca":
      case "verify-full":
        return true;
      case "no-verify":
        return { rejectUnauthorized: false };
    }
    return defaults.ssl;
  };
  var quoteParamValue = function(value) {
    return "'" + ("" + value).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
  };
  var add = function(params, config, paramName) {
    const value = config[paramName];
    if (value !== undefined && value !== null) {
      params.push(paramName + "=" + quoteParamValue(value));
    }
  };

  class ConnectionParameters {
    constructor(config) {
      config = typeof config === "string" ? parse(config) : config || {};
      if (config.connectionString) {
        config = Object.assign({}, config, parse(config.connectionString));
      }
      this.user = val("user", config);
      this.database = val("database", config);
      if (this.database === undefined) {
        this.database = this.user;
      }
      this.port = parseInt(val("port", config), 10);
      this.host = val("host", config);
      Object.defineProperty(this, "password", {
        configurable: true,
        enumerable: false,
        writable: true,
        value: val("password", config)
      });
      this.binary = val("binary", config);
      this.options = val("options", config);
      this.ssl = typeof config.ssl === "undefined" ? readSSLConfigFromEnvironment() : config.ssl;
      if (typeof this.ssl === "string") {
        if (this.ssl === "true") {
          this.ssl = true;
        }
      }
      if (this.ssl === "no-verify") {
        this.ssl = { rejectUnauthorized: false };
      }
      if (this.ssl && this.ssl.key) {
        Object.defineProperty(this.ssl, "key", {
          enumerable: false
        });
      }
      this.client_encoding = val("client_encoding", config);
      this.replication = val("replication", config);
      this.isDomainSocket = !(this.host || "").indexOf("/");
      this.application_name = val("application_name", config, "PGAPPNAME");
      this.fallback_application_name = val("fallback_application_name", config, false);
      this.statement_timeout = val("statement_timeout", config, false);
      this.lock_timeout = val("lock_timeout", config, false);
      this.idle_in_transaction_session_timeout = val("idle_in_transaction_session_timeout", config, false);
      this.query_timeout = val("query_timeout", config, false);
      if (config.connectionTimeoutMillis === undefined) {
        this.connect_timeout = process.env.PGCONNECT_TIMEOUT || 0;
      } else {
        this.connect_timeout = Math.floor(config.connectionTimeoutMillis / 1000);
      }
      if (config.keepAlive === false) {
        this.keepalives = 0;
      } else if (config.keepAlive === true) {
        this.keepalives = 1;
      }
      if (typeof config.keepAliveInitialDelayMillis === "number") {
        this.keepalives_idle = Math.floor(config.keepAliveInitialDelayMillis / 1000);
      }
    }
    getLibpqConnectionString(cb) {
      const params = [];
      add(params, this, "user");
      add(params, this, "password");
      add(params, this, "port");
      add(params, this, "application_name");
      add(params, this, "fallback_application_name");
      add(params, this, "connect_timeout");
      add(params, this, "options");
      const ssl = typeof this.ssl === "object" ? this.ssl : this.ssl ? { sslmode: this.ssl } : {};
      add(params, ssl, "sslmode");
      add(params, ssl, "sslca");
      add(params, ssl, "sslkey");
      add(params, ssl, "sslcert");
      add(params, ssl, "sslrootcert");
      if (this.database) {
        params.push("dbname=" + quoteParamValue(this.database));
      }
      if (this.replication) {
        params.push("replication=" + quoteParamValue(this.replication));
      }
      if (this.host) {
        params.push("host=" + quoteParamValue(this.host));
      }
      if (this.isDomainSocket) {
        return cb(null, params.join(" "));
      }
      if (this.client_encoding) {
        params.push("client_encoding=" + quoteParamValue(this.client_encoding));
      }
      dns.lookup(this.host, function(err, address) {
        if (err)
          return cb(err, null);
        params.push("hostaddr=" + quoteParamValue(address));
        return cb(null, params.join(" "));
      });
    }
  }
  module.exports = ConnectionParameters;
});

// node_modules/pg/lib/result.js
var require_result = __commonJS((exports, module) => {
  var types = require_pg_types();
  var matchRegexp = /^([A-Za-z]+)(?: (\d+))?(?: (\d+))?/;

  class Result {
    constructor(rowMode, types2) {
      this.command = null;
      this.rowCount = null;
      this.oid = null;
      this.rows = [];
      this.fields = [];
      this._parsers = undefined;
      this._types = types2;
      this.RowCtor = null;
      this.rowAsArray = rowMode === "array";
      if (this.rowAsArray) {
        this.parseRow = this._parseRowAsArray;
      }
      this._prebuiltEmptyResultObject = null;
    }
    addCommandComplete(msg) {
      let match;
      if (msg.text) {
        match = matchRegexp.exec(msg.text);
      } else {
        match = matchRegexp.exec(msg.command);
      }
      if (match) {
        this.command = match[1];
        if (match[3]) {
          this.oid = parseInt(match[2], 10);
          this.rowCount = parseInt(match[3], 10);
        } else if (match[2]) {
          this.rowCount = parseInt(match[2], 10);
        }
      }
    }
    _parseRowAsArray(rowData) {
      const row = new Array(rowData.length);
      for (let i = 0, len = rowData.length;i < len; i++) {
        const rawValue = rowData[i];
        if (rawValue !== null) {
          row[i] = this._parsers[i](rawValue);
        } else {
          row[i] = null;
        }
      }
      return row;
    }
    parseRow(rowData) {
      const row = { ...this._prebuiltEmptyResultObject };
      for (let i = 0, len = rowData.length;i < len; i++) {
        const rawValue = rowData[i];
        const field = this.fields[i].name;
        if (rawValue !== null) {
          const v = this.fields[i].format === "binary" ? Buffer.from(rawValue) : rawValue;
          row[field] = this._parsers[i](v);
        } else {
          row[field] = null;
        }
      }
      return row;
    }
    addRow(row) {
      this.rows.push(row);
    }
    addFields(fieldDescriptions) {
      this.fields = fieldDescriptions;
      if (this.fields.length) {
        this._parsers = new Array(fieldDescriptions.length);
      }
      const row = {};
      for (let i = 0;i < fieldDescriptions.length; i++) {
        const desc = fieldDescriptions[i];
        row[desc.name] = null;
        if (this._types) {
          this._parsers[i] = this._types.getTypeParser(desc.dataTypeID, desc.format || "text");
        } else {
          this._parsers[i] = types.getTypeParser(desc.dataTypeID, desc.format || "text");
        }
      }
      this._prebuiltEmptyResultObject = { ...row };
    }
  }
  module.exports = Result;
});

// node_modules/pg/lib/query.js
var require_query = __commonJS((exports, module) => {
  var { EventEmitter } = __require("events");
  var Result = require_result();
  var utils = require_utils();

  class Query extends EventEmitter {
    constructor(config, values, callback) {
      super();
      config = utils.normalizeQueryConfig(config, values, callback);
      this.text = config.text;
      this.values = config.values;
      this.rows = config.rows;
      this.types = config.types;
      this.name = config.name;
      this.queryMode = config.queryMode;
      this.binary = config.binary;
      this.portal = config.portal || "";
      this.callback = config.callback;
      this._rowMode = config.rowMode;
      if (process.domain && config.callback) {
        this.callback = process.domain.bind(config.callback);
      }
      this._result = new Result(this._rowMode, this.types);
      this._results = this._result;
      this._canceledDueToError = false;
    }
    requiresPreparation() {
      if (this.queryMode === "extended") {
        return true;
      }
      if (this.name) {
        return true;
      }
      if (this.rows) {
        return true;
      }
      if (!this.text) {
        return false;
      }
      if (!this.values) {
        return false;
      }
      return this.values.length > 0;
    }
    _checkForMultirow() {
      if (this._result.command) {
        if (!Array.isArray(this._results)) {
          this._results = [this._result];
        }
        this._result = new Result(this._rowMode, this._result._types);
        this._results.push(this._result);
      }
    }
    handleRowDescription(msg) {
      this._checkForMultirow();
      this._result.addFields(msg.fields);
      this._accumulateRows = this.callback || !this.listeners("row").length;
    }
    handleDataRow(msg) {
      let row;
      if (this._canceledDueToError) {
        return;
      }
      try {
        row = this._result.parseRow(msg.fields);
      } catch (err) {
        this._canceledDueToError = err;
        return;
      }
      this.emit("row", row, this._result);
      if (this._accumulateRows) {
        this._result.addRow(row);
      }
    }
    handleCommandComplete(msg, connection) {
      this._checkForMultirow();
      this._result.addCommandComplete(msg);
      if (this.rows) {
        connection.sync();
      }
    }
    handleEmptyQuery(connection) {
      if (this.rows) {
        connection.sync();
      }
    }
    handleError(err, connection) {
      if (this._canceledDueToError) {
        err = this._canceledDueToError;
        this._canceledDueToError = false;
      }
      if (this.callback) {
        return this.callback(err);
      }
      this.emit("error", err);
    }
    handleReadyForQuery(con) {
      if (this._canceledDueToError) {
        return this.handleError(this._canceledDueToError, con);
      }
      if (this.callback) {
        try {
          this.callback(null, this._results);
        } catch (err) {
          process.nextTick(() => {
            throw err;
          });
        }
      }
      this.emit("end", this._results);
    }
    submit(connection) {
      if (typeof this.text !== "string" && typeof this.name !== "string") {
        return new Error("A query must have either text or a name. Supplying neither is unsupported.");
      }
      const previous = connection.parsedStatements[this.name];
      if (this.text && previous && this.text !== previous) {
        return new Error(`Prepared statements must be unique - '${this.name}' was used for a different statement`);
      }
      if (this.values && !Array.isArray(this.values)) {
        return new Error("Query values must be an array");
      }
      if (this.requiresPreparation()) {
        connection.stream.cork && connection.stream.cork();
        try {
          this.prepare(connection);
        } finally {
          connection.stream.uncork && connection.stream.uncork();
        }
      } else {
        connection.query(this.text);
      }
      return null;
    }
    hasBeenParsed(connection) {
      return this.name && connection.parsedStatements[this.name];
    }
    handlePortalSuspended(connection) {
      this._getRows(connection, this.rows);
    }
    _getRows(connection, rows) {
      connection.execute({
        portal: this.portal,
        rows
      });
      if (!rows) {
        connection.sync();
      } else {
        connection.flush();
      }
    }
    prepare(connection) {
      if (!this.hasBeenParsed(connection)) {
        connection.parse({
          text: this.text,
          name: this.name,
          types: this.types
        });
      }
      try {
        connection.bind({
          portal: this.portal,
          statement: this.name,
          values: this.values,
          binary: this.binary,
          valueMapper: utils.prepareValue
        });
      } catch (err) {
        this.handleError(err, connection);
        return;
      }
      connection.describe({
        type: "P",
        name: this.portal || ""
      });
      this._getRows(connection, this.rows);
    }
    handleCopyInResponse(connection) {
      connection.sendCopyFail("No source stream defined");
    }
    handleCopyData(msg, connection) {}
  }
  module.exports = Query;
});

// node_modules/pg-protocol/dist/messages.js
var require_messages = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.NoticeMessage = exports.DataRowMessage = exports.CommandCompleteMessage = exports.ReadyForQueryMessage = exports.NotificationResponseMessage = exports.BackendKeyDataMessage = exports.AuthenticationMD5Password = exports.ParameterStatusMessage = exports.ParameterDescriptionMessage = exports.RowDescriptionMessage = exports.Field = exports.CopyResponse = exports.CopyDataMessage = exports.DatabaseError = exports.copyDone = exports.emptyQuery = exports.replicationStart = exports.portalSuspended = exports.noData = exports.closeComplete = exports.bindComplete = exports.parseComplete = undefined;
  exports.parseComplete = {
    name: "parseComplete",
    length: 5
  };
  exports.bindComplete = {
    name: "bindComplete",
    length: 5
  };
  exports.closeComplete = {
    name: "closeComplete",
    length: 5
  };
  exports.noData = {
    name: "noData",
    length: 5
  };
  exports.portalSuspended = {
    name: "portalSuspended",
    length: 5
  };
  exports.replicationStart = {
    name: "replicationStart",
    length: 4
  };
  exports.emptyQuery = {
    name: "emptyQuery",
    length: 4
  };
  exports.copyDone = {
    name: "copyDone",
    length: 4
  };

  class DatabaseError extends Error {
    constructor(message, length, name) {
      super(message);
      this.length = length;
      this.name = name;
    }
  }
  exports.DatabaseError = DatabaseError;

  class CopyDataMessage {
    constructor(length, chunk) {
      this.length = length;
      this.chunk = chunk;
      this.name = "copyData";
    }
  }
  exports.CopyDataMessage = CopyDataMessage;

  class CopyResponse {
    constructor(length, name, binary, columnCount) {
      this.length = length;
      this.name = name;
      this.binary = binary;
      this.columnTypes = new Array(columnCount);
    }
  }
  exports.CopyResponse = CopyResponse;

  class Field {
    constructor(name, tableID, columnID, dataTypeID, dataTypeSize, dataTypeModifier, format) {
      this.name = name;
      this.tableID = tableID;
      this.columnID = columnID;
      this.dataTypeID = dataTypeID;
      this.dataTypeSize = dataTypeSize;
      this.dataTypeModifier = dataTypeModifier;
      this.format = format;
    }
  }
  exports.Field = Field;

  class RowDescriptionMessage {
    constructor(length, fieldCount) {
      this.length = length;
      this.fieldCount = fieldCount;
      this.name = "rowDescription";
      this.fields = new Array(this.fieldCount);
    }
  }
  exports.RowDescriptionMessage = RowDescriptionMessage;

  class ParameterDescriptionMessage {
    constructor(length, parameterCount) {
      this.length = length;
      this.parameterCount = parameterCount;
      this.name = "parameterDescription";
      this.dataTypeIDs = new Array(this.parameterCount);
    }
  }
  exports.ParameterDescriptionMessage = ParameterDescriptionMessage;

  class ParameterStatusMessage {
    constructor(length, parameterName, parameterValue) {
      this.length = length;
      this.parameterName = parameterName;
      this.parameterValue = parameterValue;
      this.name = "parameterStatus";
    }
  }
  exports.ParameterStatusMessage = ParameterStatusMessage;

  class AuthenticationMD5Password {
    constructor(length, salt) {
      this.length = length;
      this.salt = salt;
      this.name = "authenticationMD5Password";
    }
  }
  exports.AuthenticationMD5Password = AuthenticationMD5Password;

  class BackendKeyDataMessage {
    constructor(length, processID, secretKey) {
      this.length = length;
      this.processID = processID;
      this.secretKey = secretKey;
      this.name = "backendKeyData";
    }
  }
  exports.BackendKeyDataMessage = BackendKeyDataMessage;

  class NotificationResponseMessage {
    constructor(length, processId, channel, payload) {
      this.length = length;
      this.processId = processId;
      this.channel = channel;
      this.payload = payload;
      this.name = "notification";
    }
  }
  exports.NotificationResponseMessage = NotificationResponseMessage;

  class ReadyForQueryMessage {
    constructor(length, status) {
      this.length = length;
      this.status = status;
      this.name = "readyForQuery";
    }
  }
  exports.ReadyForQueryMessage = ReadyForQueryMessage;

  class CommandCompleteMessage {
    constructor(length, text) {
      this.length = length;
      this.text = text;
      this.name = "commandComplete";
    }
  }
  exports.CommandCompleteMessage = CommandCompleteMessage;

  class DataRowMessage {
    constructor(length, fields) {
      this.length = length;
      this.fields = fields;
      this.name = "dataRow";
      this.fieldCount = fields.length;
    }
  }
  exports.DataRowMessage = DataRowMessage;

  class NoticeMessage {
    constructor(length, message) {
      this.length = length;
      this.message = message;
      this.name = "notice";
    }
  }
  exports.NoticeMessage = NoticeMessage;
});

// node_modules/pg-protocol/dist/buffer-writer.js
var require_buffer_writer = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.Writer = undefined;

  class Writer {
    constructor(size = 256) {
      this.size = size;
      this.offset = 5;
      this.headerPosition = 0;
      this.buffer = Buffer.allocUnsafe(size);
    }
    ensure(size) {
      const remaining = this.buffer.length - this.offset;
      if (remaining < size) {
        const oldBuffer = this.buffer;
        const newSize = oldBuffer.length + (oldBuffer.length >> 1) + size;
        this.buffer = Buffer.allocUnsafe(newSize);
        oldBuffer.copy(this.buffer);
      }
    }
    addInt32(num) {
      this.ensure(4);
      this.buffer[this.offset++] = num >>> 24 & 255;
      this.buffer[this.offset++] = num >>> 16 & 255;
      this.buffer[this.offset++] = num >>> 8 & 255;
      this.buffer[this.offset++] = num >>> 0 & 255;
      return this;
    }
    addInt16(num) {
      this.ensure(2);
      this.buffer[this.offset++] = num >>> 8 & 255;
      this.buffer[this.offset++] = num >>> 0 & 255;
      return this;
    }
    addCString(string) {
      if (!string) {
        this.ensure(1);
      } else {
        const len = Buffer.byteLength(string);
        this.ensure(len + 1);
        this.buffer.write(string, this.offset, "utf-8");
        this.offset += len;
      }
      this.buffer[this.offset++] = 0;
      return this;
    }
    addString(string = "") {
      const len = Buffer.byteLength(string);
      this.ensure(len);
      this.buffer.write(string, this.offset);
      this.offset += len;
      return this;
    }
    add(otherBuffer) {
      this.ensure(otherBuffer.length);
      otherBuffer.copy(this.buffer, this.offset);
      this.offset += otherBuffer.length;
      return this;
    }
    join(code) {
      if (code) {
        this.buffer[this.headerPosition] = code;
        const length = this.offset - (this.headerPosition + 1);
        this.buffer.writeInt32BE(length, this.headerPosition + 1);
      }
      return this.buffer.slice(code ? 0 : 5, this.offset);
    }
    flush(code) {
      const result = this.join(code);
      this.offset = 5;
      this.headerPosition = 0;
      this.buffer = Buffer.allocUnsafe(this.size);
      return result;
    }
  }
  exports.Writer = Writer;
});

// node_modules/pg-protocol/dist/serializer.js
var require_serializer = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.serialize = undefined;
  var buffer_writer_1 = require_buffer_writer();
  var writer = new buffer_writer_1.Writer;
  var startup = (opts) => {
    writer.addInt16(3).addInt16(0);
    for (const key of Object.keys(opts)) {
      writer.addCString(key).addCString(opts[key]);
    }
    writer.addCString("client_encoding").addCString("UTF8");
    const bodyBuffer = writer.addCString("").flush();
    const length = bodyBuffer.length + 4;
    return new buffer_writer_1.Writer().addInt32(length).add(bodyBuffer).flush();
  };
  var requestSsl = () => {
    const response = Buffer.allocUnsafe(8);
    response.writeInt32BE(8, 0);
    response.writeInt32BE(80877103, 4);
    return response;
  };
  var password = (password2) => {
    return writer.addCString(password2).flush(112);
  };
  var sendSASLInitialResponseMessage = function(mechanism, initialResponse) {
    writer.addCString(mechanism).addInt32(Buffer.byteLength(initialResponse)).addString(initialResponse);
    return writer.flush(112);
  };
  var sendSCRAMClientFinalMessage = function(additionalData) {
    return writer.addString(additionalData).flush(112);
  };
  var query = (text) => {
    return writer.addCString(text).flush(81);
  };
  var emptyArray = [];
  var parse = (query2) => {
    const name = query2.name || "";
    if (name.length > 63) {
      console.error("Warning! Postgres only supports 63 characters for query names.");
      console.error("You supplied %s (%s)", name, name.length);
      console.error("This can cause conflicts and silent errors executing queries");
    }
    const types = query2.types || emptyArray;
    const len = types.length;
    const buffer = writer.addCString(name).addCString(query2.text).addInt16(len);
    for (let i = 0;i < len; i++) {
      buffer.addInt32(types[i]);
    }
    return writer.flush(80);
  };
  var paramWriter = new buffer_writer_1.Writer;
  var writeValues = function(values, valueMapper) {
    for (let i = 0;i < values.length; i++) {
      const mappedVal = valueMapper ? valueMapper(values[i], i) : values[i];
      if (mappedVal == null) {
        writer.addInt16(0);
        paramWriter.addInt32(-1);
      } else if (mappedVal instanceof Buffer) {
        writer.addInt16(1);
        paramWriter.addInt32(mappedVal.length);
        paramWriter.add(mappedVal);
      } else {
        writer.addInt16(0);
        paramWriter.addInt32(Buffer.byteLength(mappedVal));
        paramWriter.addString(mappedVal);
      }
    }
  };
  var bind = (config = {}) => {
    const portal = config.portal || "";
    const statement = config.statement || "";
    const binary = config.binary || false;
    const values = config.values || emptyArray;
    const len = values.length;
    writer.addCString(portal).addCString(statement);
    writer.addInt16(len);
    writeValues(values, config.valueMapper);
    writer.addInt16(len);
    writer.add(paramWriter.flush());
    writer.addInt16(1);
    writer.addInt16(binary ? 1 : 0);
    return writer.flush(66);
  };
  var emptyExecute = Buffer.from([69, 0, 0, 0, 9, 0, 0, 0, 0, 0]);
  var execute = (config) => {
    if (!config || !config.portal && !config.rows) {
      return emptyExecute;
    }
    const portal = config.portal || "";
    const rows = config.rows || 0;
    const portalLength = Buffer.byteLength(portal);
    const len = 4 + portalLength + 1 + 4;
    const buff = Buffer.allocUnsafe(1 + len);
    buff[0] = 69;
    buff.writeInt32BE(len, 1);
    buff.write(portal, 5, "utf-8");
    buff[portalLength + 5] = 0;
    buff.writeUInt32BE(rows, buff.length - 4);
    return buff;
  };
  var cancel = (processID, secretKey) => {
    const buffer = Buffer.allocUnsafe(16);
    buffer.writeInt32BE(16, 0);
    buffer.writeInt16BE(1234, 4);
    buffer.writeInt16BE(5678, 6);
    buffer.writeInt32BE(processID, 8);
    buffer.writeInt32BE(secretKey, 12);
    return buffer;
  };
  var cstringMessage = (code, string) => {
    const stringLen = Buffer.byteLength(string);
    const len = 4 + stringLen + 1;
    const buffer = Buffer.allocUnsafe(1 + len);
    buffer[0] = code;
    buffer.writeInt32BE(len, 1);
    buffer.write(string, 5, "utf-8");
    buffer[len] = 0;
    return buffer;
  };
  var emptyDescribePortal = writer.addCString("P").flush(68);
  var emptyDescribeStatement = writer.addCString("S").flush(68);
  var describe = (msg) => {
    return msg.name ? cstringMessage(68, `${msg.type}${msg.name || ""}`) : msg.type === "P" ? emptyDescribePortal : emptyDescribeStatement;
  };
  var close = (msg) => {
    const text = `${msg.type}${msg.name || ""}`;
    return cstringMessage(67, text);
  };
  var copyData = (chunk) => {
    return writer.add(chunk).flush(100);
  };
  var copyFail = (message) => {
    return cstringMessage(102, message);
  };
  var codeOnlyBuffer = (code) => Buffer.from([code, 0, 0, 0, 4]);
  var flushBuffer = codeOnlyBuffer(72);
  var syncBuffer = codeOnlyBuffer(83);
  var endBuffer = codeOnlyBuffer(88);
  var copyDoneBuffer = codeOnlyBuffer(99);
  var serialize = {
    startup,
    password,
    requestSsl,
    sendSASLInitialResponseMessage,
    sendSCRAMClientFinalMessage,
    query,
    parse,
    bind,
    execute,
    describe,
    close,
    flush: () => flushBuffer,
    sync: () => syncBuffer,
    end: () => endBuffer,
    copyData,
    copyDone: () => copyDoneBuffer,
    copyFail,
    cancel
  };
  exports.serialize = serialize;
});

// node_modules/pg-protocol/dist/buffer-reader.js
var require_buffer_reader = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.BufferReader = undefined;

  class BufferReader {
    constructor(offset = 0) {
      this.offset = offset;
      this.buffer = Buffer.allocUnsafe(0);
      this.encoding = "utf-8";
    }
    setBuffer(offset, buffer) {
      this.offset = offset;
      this.buffer = buffer;
    }
    int16() {
      const result = this.buffer.readInt16BE(this.offset);
      this.offset += 2;
      return result;
    }
    byte() {
      const result = this.buffer[this.offset];
      this.offset++;
      return result;
    }
    int32() {
      const result = this.buffer.readInt32BE(this.offset);
      this.offset += 4;
      return result;
    }
    uint32() {
      const result = this.buffer.readUInt32BE(this.offset);
      this.offset += 4;
      return result;
    }
    string(length) {
      const result = this.buffer.toString(this.encoding, this.offset, this.offset + length);
      this.offset += length;
      return result;
    }
    cstring() {
      const start = this.offset;
      let end = start;
      while (this.buffer[end++] !== 0) {}
      this.offset = end;
      return this.buffer.toString(this.encoding, start, end - 1);
    }
    bytes(length) {
      const result = this.buffer.slice(this.offset, this.offset + length);
      this.offset += length;
      return result;
    }
  }
  exports.BufferReader = BufferReader;
});

// node_modules/pg-protocol/dist/parser.js
var require_parser = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.Parser = undefined;
  var messages_1 = require_messages();
  var buffer_reader_1 = require_buffer_reader();
  var CODE_LENGTH = 1;
  var LEN_LENGTH = 4;
  var HEADER_LENGTH = CODE_LENGTH + LEN_LENGTH;
  var LATEINIT_LENGTH = -1;
  var emptyBuffer = Buffer.allocUnsafe(0);

  class Parser {
    constructor(opts) {
      this.buffer = emptyBuffer;
      this.bufferLength = 0;
      this.bufferOffset = 0;
      this.reader = new buffer_reader_1.BufferReader;
      if ((opts === null || opts === undefined ? undefined : opts.mode) === "binary") {
        throw new Error("Binary mode not supported yet");
      }
      this.mode = (opts === null || opts === undefined ? undefined : opts.mode) || "text";
    }
    parse(buffer, callback) {
      this.mergeBuffer(buffer);
      const bufferFullLength = this.bufferOffset + this.bufferLength;
      let offset = this.bufferOffset;
      while (offset + HEADER_LENGTH <= bufferFullLength) {
        const code = this.buffer[offset];
        const length = this.buffer.readUInt32BE(offset + CODE_LENGTH);
        const fullMessageLength = CODE_LENGTH + length;
        if (fullMessageLength + offset <= bufferFullLength) {
          const message = this.handlePacket(offset + HEADER_LENGTH, code, length, this.buffer);
          callback(message);
          offset += fullMessageLength;
        } else {
          break;
        }
      }
      if (offset === bufferFullLength) {
        this.buffer = emptyBuffer;
        this.bufferLength = 0;
        this.bufferOffset = 0;
      } else {
        this.bufferLength = bufferFullLength - offset;
        this.bufferOffset = offset;
      }
    }
    mergeBuffer(buffer) {
      if (this.bufferLength > 0) {
        const newLength = this.bufferLength + buffer.byteLength;
        const newFullLength = newLength + this.bufferOffset;
        if (newFullLength > this.buffer.byteLength) {
          let newBuffer;
          if (newLength <= this.buffer.byteLength && this.bufferOffset >= this.bufferLength) {
            newBuffer = this.buffer;
          } else {
            let newBufferLength = this.buffer.byteLength * 2;
            while (newLength >= newBufferLength) {
              newBufferLength *= 2;
            }
            newBuffer = Buffer.allocUnsafe(newBufferLength);
          }
          this.buffer.copy(newBuffer, 0, this.bufferOffset, this.bufferOffset + this.bufferLength);
          this.buffer = newBuffer;
          this.bufferOffset = 0;
        }
        buffer.copy(this.buffer, this.bufferOffset + this.bufferLength);
        this.bufferLength = newLength;
      } else {
        this.buffer = buffer;
        this.bufferOffset = 0;
        this.bufferLength = buffer.byteLength;
      }
    }
    handlePacket(offset, code, length, bytes) {
      const { reader } = this;
      reader.setBuffer(offset, bytes);
      let message;
      switch (code) {
        case 50:
          message = messages_1.bindComplete;
          break;
        case 49:
          message = messages_1.parseComplete;
          break;
        case 51:
          message = messages_1.closeComplete;
          break;
        case 110:
          message = messages_1.noData;
          break;
        case 115:
          message = messages_1.portalSuspended;
          break;
        case 99:
          message = messages_1.copyDone;
          break;
        case 87:
          message = messages_1.replicationStart;
          break;
        case 73:
          message = messages_1.emptyQuery;
          break;
        case 68:
          message = parseDataRowMessage(reader);
          break;
        case 67:
          message = parseCommandCompleteMessage(reader);
          break;
        case 90:
          message = parseReadyForQueryMessage(reader);
          break;
        case 65:
          message = parseNotificationMessage(reader);
          break;
        case 82:
          message = parseAuthenticationResponse(reader, length);
          break;
        case 83:
          message = parseParameterStatusMessage(reader);
          break;
        case 75:
          message = parseBackendKeyData(reader);
          break;
        case 69:
          message = parseErrorMessage(reader, "error");
          break;
        case 78:
          message = parseErrorMessage(reader, "notice");
          break;
        case 84:
          message = parseRowDescriptionMessage(reader);
          break;
        case 116:
          message = parseParameterDescriptionMessage(reader);
          break;
        case 71:
          message = parseCopyInMessage(reader);
          break;
        case 72:
          message = parseCopyOutMessage(reader);
          break;
        case 100:
          message = parseCopyData(reader, length);
          break;
        default:
          return new messages_1.DatabaseError("received invalid response: " + code.toString(16), length, "error");
      }
      reader.setBuffer(0, emptyBuffer);
      message.length = length;
      return message;
    }
  }
  exports.Parser = Parser;
  var parseReadyForQueryMessage = (reader) => {
    const status = reader.string(1);
    return new messages_1.ReadyForQueryMessage(LATEINIT_LENGTH, status);
  };
  var parseCommandCompleteMessage = (reader) => {
    const text = reader.cstring();
    return new messages_1.CommandCompleteMessage(LATEINIT_LENGTH, text);
  };
  var parseCopyData = (reader, length) => {
    const chunk = reader.bytes(length - 4);
    return new messages_1.CopyDataMessage(LATEINIT_LENGTH, chunk);
  };
  var parseCopyInMessage = (reader) => parseCopyMessage(reader, "copyInResponse");
  var parseCopyOutMessage = (reader) => parseCopyMessage(reader, "copyOutResponse");
  var parseCopyMessage = (reader, messageName) => {
    const isBinary = reader.byte() !== 0;
    const columnCount = reader.int16();
    const message = new messages_1.CopyResponse(LATEINIT_LENGTH, messageName, isBinary, columnCount);
    for (let i = 0;i < columnCount; i++) {
      message.columnTypes[i] = reader.int16();
    }
    return message;
  };
  var parseNotificationMessage = (reader) => {
    const processId = reader.int32();
    const channel = reader.cstring();
    const payload = reader.cstring();
    return new messages_1.NotificationResponseMessage(LATEINIT_LENGTH, processId, channel, payload);
  };
  var parseRowDescriptionMessage = (reader) => {
    const fieldCount = reader.int16();
    const message = new messages_1.RowDescriptionMessage(LATEINIT_LENGTH, fieldCount);
    for (let i = 0;i < fieldCount; i++) {
      message.fields[i] = parseField(reader);
    }
    return message;
  };
  var parseField = (reader) => {
    const name = reader.cstring();
    const tableID = reader.uint32();
    const columnID = reader.int16();
    const dataTypeID = reader.uint32();
    const dataTypeSize = reader.int16();
    const dataTypeModifier = reader.int32();
    const mode = reader.int16() === 0 ? "text" : "binary";
    return new messages_1.Field(name, tableID, columnID, dataTypeID, dataTypeSize, dataTypeModifier, mode);
  };
  var parseParameterDescriptionMessage = (reader) => {
    const parameterCount = reader.int16();
    const message = new messages_1.ParameterDescriptionMessage(LATEINIT_LENGTH, parameterCount);
    for (let i = 0;i < parameterCount; i++) {
      message.dataTypeIDs[i] = reader.int32();
    }
    return message;
  };
  var parseDataRowMessage = (reader) => {
    const fieldCount = reader.int16();
    const fields = new Array(fieldCount);
    for (let i = 0;i < fieldCount; i++) {
      const len = reader.int32();
      fields[i] = len === -1 ? null : reader.string(len);
    }
    return new messages_1.DataRowMessage(LATEINIT_LENGTH, fields);
  };
  var parseParameterStatusMessage = (reader) => {
    const name = reader.cstring();
    const value = reader.cstring();
    return new messages_1.ParameterStatusMessage(LATEINIT_LENGTH, name, value);
  };
  var parseBackendKeyData = (reader) => {
    const processID = reader.int32();
    const secretKey = reader.int32();
    return new messages_1.BackendKeyDataMessage(LATEINIT_LENGTH, processID, secretKey);
  };
  var parseAuthenticationResponse = (reader, length) => {
    const code = reader.int32();
    const message = {
      name: "authenticationOk",
      length
    };
    switch (code) {
      case 0:
        break;
      case 3:
        if (message.length === 8) {
          message.name = "authenticationCleartextPassword";
        }
        break;
      case 5:
        if (message.length === 12) {
          message.name = "authenticationMD5Password";
          const salt = reader.bytes(4);
          return new messages_1.AuthenticationMD5Password(LATEINIT_LENGTH, salt);
        }
        break;
      case 10:
        {
          message.name = "authenticationSASL";
          message.mechanisms = [];
          let mechanism;
          do {
            mechanism = reader.cstring();
            if (mechanism) {
              message.mechanisms.push(mechanism);
            }
          } while (mechanism);
        }
        break;
      case 11:
        message.name = "authenticationSASLContinue";
        message.data = reader.string(length - 8);
        break;
      case 12:
        message.name = "authenticationSASLFinal";
        message.data = reader.string(length - 8);
        break;
      default:
        throw new Error("Unknown authenticationOk message type " + code);
    }
    return message;
  };
  var parseErrorMessage = (reader, name) => {
    const fields = {};
    let fieldType = reader.string(1);
    while (fieldType !== "\x00") {
      fields[fieldType] = reader.cstring();
      fieldType = reader.string(1);
    }
    const messageValue = fields.M;
    const message = name === "notice" ? new messages_1.NoticeMessage(LATEINIT_LENGTH, messageValue) : new messages_1.DatabaseError(messageValue, LATEINIT_LENGTH, name);
    message.severity = fields.S;
    message.code = fields.C;
    message.detail = fields.D;
    message.hint = fields.H;
    message.position = fields.P;
    message.internalPosition = fields.p;
    message.internalQuery = fields.q;
    message.where = fields.W;
    message.schema = fields.s;
    message.table = fields.t;
    message.column = fields.c;
    message.dataType = fields.d;
    message.constraint = fields.n;
    message.file = fields.F;
    message.line = fields.L;
    message.routine = fields.R;
    return message;
  };
});

// node_modules/pg-protocol/dist/index.js
var require_dist = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.DatabaseError = exports.serialize = exports.parse = undefined;
  var messages_1 = require_messages();
  Object.defineProperty(exports, "DatabaseError", { enumerable: true, get: function() {
    return messages_1.DatabaseError;
  } });
  var serializer_1 = require_serializer();
  Object.defineProperty(exports, "serialize", { enumerable: true, get: function() {
    return serializer_1.serialize;
  } });
  var parser_1 = require_parser();
  function parse(stream, callback) {
    const parser = new parser_1.Parser;
    stream.on("data", (buffer) => parser.parse(buffer, callback));
    return new Promise((resolve) => stream.on("end", () => resolve()));
  }
  exports.parse = parse;
});

// node_modules/pg-cloudflare/dist/empty.js
var require_empty = __commonJS((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.default = {};
});

// node_modules/pg/lib/stream.js
var require_stream = __commonJS((exports, module) => {
  var { getStream, getSecureStream } = getStreamFuncs();
  module.exports = {
    getStream,
    getSecureStream
  };
  function getNodejsStreamFuncs() {
    function getStream2(ssl) {
      const net = __require("net");
      return new net.Socket;
    }
    function getSecureStream2(options) {
      const tls = __require("tls");
      return tls.connect(options);
    }
    return {
      getStream: getStream2,
      getSecureStream: getSecureStream2
    };
  }
  function getCloudflareStreamFuncs() {
    function getStream2(ssl) {
      const { CloudflareSocket } = require_empty();
      return new CloudflareSocket(ssl);
    }
    function getSecureStream2(options) {
      options.socket.startTls(options);
      return options.socket;
    }
    return {
      getStream: getStream2,
      getSecureStream: getSecureStream2
    };
  }
  function isCloudflareRuntime() {
    if (typeof navigator === "object" && navigator !== null && typeof navigator.userAgent === "string") {
      return navigator.userAgent === "Cloudflare-Workers";
    }
    if (typeof Response === "function") {
      const resp = new Response(null, { cf: { thing: true } });
      if (typeof resp.cf === "object" && resp.cf !== null && resp.cf.thing) {
        return true;
      }
    }
    return false;
  }
  function getStreamFuncs() {
    if (isCloudflareRuntime()) {
      return getCloudflareStreamFuncs();
    }
    return getNodejsStreamFuncs();
  }
});

// node_modules/pg/lib/connection.js
var require_connection = __commonJS((exports, module) => {
  var EventEmitter = __require("events").EventEmitter;
  var { parse, serialize } = require_dist();
  var { getStream, getSecureStream } = require_stream();
  var flushBuffer = serialize.flush();
  var syncBuffer = serialize.sync();
  var endBuffer = serialize.end();

  class Connection extends EventEmitter {
    constructor(config) {
      super();
      config = config || {};
      this.stream = config.stream || getStream(config.ssl);
      if (typeof this.stream === "function") {
        this.stream = this.stream(config);
      }
      this._keepAlive = config.keepAlive;
      this._keepAliveInitialDelayMillis = config.keepAliveInitialDelayMillis;
      this.parsedStatements = {};
      this.ssl = config.ssl || false;
      this._ending = false;
      this._emitMessage = false;
      const self = this;
      this.on("newListener", function(eventName) {
        if (eventName === "message") {
          self._emitMessage = true;
        }
      });
    }
    connect(port, host) {
      const self = this;
      this._connecting = true;
      this.stream.setNoDelay(true);
      this.stream.connect(port, host);
      this.stream.once("connect", function() {
        if (self._keepAlive) {
          self.stream.setKeepAlive(true, self._keepAliveInitialDelayMillis);
        }
        self.emit("connect");
      });
      const reportStreamError = function(error) {
        if (self._ending && (error.code === "ECONNRESET" || error.code === "EPIPE")) {
          return;
        }
        self.emit("error", error);
      };
      this.stream.on("error", reportStreamError);
      this.stream.on("close", function() {
        self.emit("end");
      });
      if (!this.ssl) {
        return this.attachListeners(this.stream);
      }
      this.stream.once("data", function(buffer) {
        const responseCode = buffer.toString("utf8");
        switch (responseCode) {
          case "S":
            break;
          case "N":
            self.stream.end();
            return self.emit("error", new Error("The server does not support SSL connections"));
          default:
            self.stream.end();
            return self.emit("error", new Error("There was an error establishing an SSL connection"));
        }
        const options = {
          socket: self.stream
        };
        if (self.ssl !== true) {
          Object.assign(options, self.ssl);
          if ("key" in self.ssl) {
            options.key = self.ssl.key;
          }
        }
        const net = __require("net");
        if (net.isIP && net.isIP(host) === 0) {
          options.servername = host;
        }
        try {
          self.stream = getSecureStream(options);
        } catch (err) {
          return self.emit("error", err);
        }
        self.attachListeners(self.stream);
        self.stream.on("error", reportStreamError);
        self.emit("sslconnect");
      });
    }
    attachListeners(stream) {
      parse(stream, (msg) => {
        const eventName = msg.name === "error" ? "errorMessage" : msg.name;
        if (this._emitMessage) {
          this.emit("message", msg);
        }
        this.emit(eventName, msg);
      });
    }
    requestSsl() {
      this.stream.write(serialize.requestSsl());
    }
    startup(config) {
      this.stream.write(serialize.startup(config));
    }
    cancel(processID, secretKey) {
      this._send(serialize.cancel(processID, secretKey));
    }
    password(password) {
      this._send(serialize.password(password));
    }
    sendSASLInitialResponseMessage(mechanism, initialResponse) {
      this._send(serialize.sendSASLInitialResponseMessage(mechanism, initialResponse));
    }
    sendSCRAMClientFinalMessage(additionalData) {
      this._send(serialize.sendSCRAMClientFinalMessage(additionalData));
    }
    _send(buffer) {
      if (!this.stream.writable) {
        return false;
      }
      return this.stream.write(buffer);
    }
    query(text) {
      this._send(serialize.query(text));
    }
    parse(query) {
      this._send(serialize.parse(query));
    }
    bind(config) {
      this._send(serialize.bind(config));
    }
    execute(config) {
      this._send(serialize.execute(config));
    }
    flush() {
      if (this.stream.writable) {
        this.stream.write(flushBuffer);
      }
    }
    sync() {
      this._ending = true;
      this._send(syncBuffer);
    }
    ref() {
      this.stream.ref();
    }
    unref() {
      this.stream.unref();
    }
    end() {
      this._ending = true;
      if (!this._connecting || !this.stream.writable) {
        this.stream.end();
        return;
      }
      return this.stream.write(endBuffer, () => {
        this.stream.end();
      });
    }
    close(msg) {
      this._send(serialize.close(msg));
    }
    describe(msg) {
      this._send(serialize.describe(msg));
    }
    sendCopyFromChunk(chunk) {
      this._send(serialize.copyData(chunk));
    }
    endCopyFrom() {
      this._send(serialize.copyDone());
    }
    sendCopyFail(msg) {
      this._send(serialize.copyFail(msg));
    }
  }
  module.exports = Connection;
});

// node_modules/split2/index.js
var require_split2 = __commonJS((exports, module) => {
  var { Transform } = __require("stream");
  var { StringDecoder } = __require("string_decoder");
  var kLast = Symbol("last");
  var kDecoder = Symbol("decoder");
  function transform(chunk, enc, cb) {
    let list;
    if (this.overflow) {
      const buf = this[kDecoder].write(chunk);
      list = buf.split(this.matcher);
      if (list.length === 1)
        return cb();
      list.shift();
      this.overflow = false;
    } else {
      this[kLast] += this[kDecoder].write(chunk);
      list = this[kLast].split(this.matcher);
    }
    this[kLast] = list.pop();
    for (let i = 0;i < list.length; i++) {
      try {
        push(this, this.mapper(list[i]));
      } catch (error) {
        return cb(error);
      }
    }
    this.overflow = this[kLast].length > this.maxLength;
    if (this.overflow && !this.skipOverflow) {
      cb(new Error("maximum buffer reached"));
      return;
    }
    cb();
  }
  function flush(cb) {
    this[kLast] += this[kDecoder].end();
    if (this[kLast]) {
      try {
        push(this, this.mapper(this[kLast]));
      } catch (error) {
        return cb(error);
      }
    }
    cb();
  }
  function push(self, val) {
    if (val !== undefined) {
      self.push(val);
    }
  }
  function noop(incoming) {
    return incoming;
  }
  function split(matcher, mapper, options) {
    matcher = matcher || /\r?\n/;
    mapper = mapper || noop;
    options = options || {};
    switch (arguments.length) {
      case 1:
        if (typeof matcher === "function") {
          mapper = matcher;
          matcher = /\r?\n/;
        } else if (typeof matcher === "object" && !(matcher instanceof RegExp) && !matcher[Symbol.split]) {
          options = matcher;
          matcher = /\r?\n/;
        }
        break;
      case 2:
        if (typeof matcher === "function") {
          options = mapper;
          mapper = matcher;
          matcher = /\r?\n/;
        } else if (typeof mapper === "object") {
          options = mapper;
          mapper = noop;
        }
    }
    options = Object.assign({}, options);
    options.autoDestroy = true;
    options.transform = transform;
    options.flush = flush;
    options.readableObjectMode = true;
    const stream = new Transform(options);
    stream[kLast] = "";
    stream[kDecoder] = new StringDecoder("utf8");
    stream.matcher = matcher;
    stream.mapper = mapper;
    stream.maxLength = options.maxLength;
    stream.skipOverflow = options.skipOverflow || false;
    stream.overflow = false;
    stream._destroy = function(err, cb) {
      this._writableState.errorEmitted = false;
      cb(err);
    };
    return stream;
  }
  module.exports = split;
});

// node_modules/pgpass/lib/helper.js
var require_helper = __commonJS((exports, module) => {
  var path = __require("path");
  var Stream = __require("stream").Stream;
  var split = require_split2();
  var util = __require("util");
  var defaultPort = 5432;
  var isWin = process.platform === "win32";
  var warnStream = process.stderr;
  var S_IRWXG = 56;
  var S_IRWXO = 7;
  var S_IFMT = 61440;
  var S_IFREG = 32768;
  function isRegFile(mode) {
    return (mode & S_IFMT) == S_IFREG;
  }
  var fieldNames = ["host", "port", "database", "user", "password"];
  var nrOfFields = fieldNames.length;
  var passKey = fieldNames[nrOfFields - 1];
  function warn() {
    var isWritable = warnStream instanceof Stream && warnStream.writable === true;
    if (isWritable) {
      var args = Array.prototype.slice.call(arguments).concat(`
`);
      warnStream.write(util.format.apply(util, args));
    }
  }
  Object.defineProperty(exports, "isWin", {
    get: function() {
      return isWin;
    },
    set: function(val) {
      isWin = val;
    }
  });
  exports.warnTo = function(stream) {
    var old = warnStream;
    warnStream = stream;
    return old;
  };
  exports.getFileName = function(rawEnv) {
    var env = rawEnv || process.env;
    var file = env.PGPASSFILE || (isWin ? path.join(env.APPDATA || "./", "postgresql", "pgpass.conf") : path.join(env.HOME || "./", ".pgpass"));
    return file;
  };
  exports.usePgPass = function(stats, fname) {
    if (Object.prototype.hasOwnProperty.call(process.env, "PGPASSWORD")) {
      return false;
    }
    if (isWin) {
      return true;
    }
    fname = fname || "<unkn>";
    if (!isRegFile(stats.mode)) {
      warn('WARNING: password file "%s" is not a plain file', fname);
      return false;
    }
    if (stats.mode & (S_IRWXG | S_IRWXO)) {
      warn('WARNING: password file "%s" has group or world access; permissions should be u=rw (0600) or less', fname);
      return false;
    }
    return true;
  };
  var matcher = exports.match = function(connInfo, entry) {
    return fieldNames.slice(0, -1).reduce(function(prev, field, idx) {
      if (idx == 1) {
        if (Number(connInfo[field] || defaultPort) === Number(entry[field])) {
          return prev && true;
        }
      }
      return prev && (entry[field] === "*" || entry[field] === connInfo[field]);
    }, true);
  };
  exports.getPassword = function(connInfo, stream, cb) {
    var pass;
    var lineStream = stream.pipe(split());
    function onLine(line) {
      var entry = parseLine(line);
      if (entry && isValidEntry(entry) && matcher(connInfo, entry)) {
        pass = entry[passKey];
        lineStream.end();
      }
    }
    var onEnd = function() {
      stream.destroy();
      cb(pass);
    };
    var onErr = function(err) {
      stream.destroy();
      warn("WARNING: error on reading file: %s", err);
      cb(undefined);
    };
    stream.on("error", onErr);
    lineStream.on("data", onLine).on("end", onEnd).on("error", onErr);
  };
  var parseLine = exports.parseLine = function(line) {
    if (line.length < 11 || line.match(/^\s+#/)) {
      return null;
    }
    var curChar = "";
    var prevChar = "";
    var fieldIdx = 0;
    var startIdx = 0;
    var endIdx = 0;
    var obj = {};
    var isLastField = false;
    var addToObj = function(idx, i0, i1) {
      var field = line.substring(i0, i1);
      if (!Object.hasOwnProperty.call(process.env, "PGPASS_NO_DEESCAPE")) {
        field = field.replace(/\\([:\\])/g, "$1");
      }
      obj[fieldNames[idx]] = field;
    };
    for (var i = 0;i < line.length - 1; i += 1) {
      curChar = line.charAt(i + 1);
      prevChar = line.charAt(i);
      isLastField = fieldIdx == nrOfFields - 1;
      if (isLastField) {
        addToObj(fieldIdx, startIdx);
        break;
      }
      if (i >= 0 && curChar == ":" && prevChar !== "\\") {
        addToObj(fieldIdx, startIdx, i + 1);
        startIdx = i + 2;
        fieldIdx += 1;
      }
    }
    obj = Object.keys(obj).length === nrOfFields ? obj : null;
    return obj;
  };
  var isValidEntry = exports.isValidEntry = function(entry) {
    var rules = {
      0: function(x3) {
        return x3.length > 0;
      },
      1: function(x3) {
        if (x3 === "*") {
          return true;
        }
        x3 = Number(x3);
        return isFinite(x3) && x3 > 0 && x3 < 9007199254740992 && Math.floor(x3) === x3;
      },
      2: function(x3) {
        return x3.length > 0;
      },
      3: function(x3) {
        return x3.length > 0;
      },
      4: function(x3) {
        return x3.length > 0;
      }
    };
    for (var idx = 0;idx < fieldNames.length; idx += 1) {
      var rule = rules[idx];
      var value = entry[fieldNames[idx]] || "";
      var res = rule(value);
      if (!res) {
        return false;
      }
    }
    return true;
  };
});

// node_modules/pgpass/lib/index.js
var require_lib = __commonJS((exports, module) => {
  var path = __require("path");
  var fs = __require("fs");
  var helper = require_helper();
  module.exports = function(connInfo, cb) {
    var file = helper.getFileName();
    fs.stat(file, function(err, stat) {
      if (err || !helper.usePgPass(stat, file)) {
        return cb(undefined);
      }
      var st3 = fs.createReadStream(file);
      helper.getPassword(connInfo, st3, cb);
    });
  };
  module.exports.warnTo = helper.warnTo;
});

// node_modules/pg/lib/client.js
var require_client = __commonJS((exports, module) => {
  var EventEmitter = __require("events").EventEmitter;
  var utils = require_utils();
  var nodeUtils = __require("util");
  var sasl = require_sasl();
  var TypeOverrides = require_type_overrides();
  var ConnectionParameters = require_connection_parameters();
  var Query = require_query();
  var defaults = require_defaults();
  var Connection = require_connection();
  var crypto = require_utils2();
  var activeQueryDeprecationNotice = nodeUtils.deprecate(() => {}, "Client.activeQuery is deprecated and will be removed in pg@9.0");
  var queryQueueDeprecationNotice = nodeUtils.deprecate(() => {}, "Client.queryQueue is deprecated and will be removed in pg@9.0.");
  var pgPassDeprecationNotice = nodeUtils.deprecate(() => {}, "pgpass support is deprecated and will be removed in pg@9.0. " + "You can provide an async function as the password property to the Client/Pool constructor that returns a password instead. Within this function you can call the pgpass module in your own code.");
  var byoPromiseDeprecationNotice = nodeUtils.deprecate(() => {}, "Passing a custom Promise implementation to the Client/Pool constructor is deprecated and will be removed in pg@9.0.");
  var queryQueueLengthDeprecationNotice = nodeUtils.deprecate(() => {}, "Calling client.query() when the client is already executing a query is deprecated and will be removed in pg@9.0. Use async/await or an external async flow control mechanism instead.");

  class Client extends EventEmitter {
    constructor(config) {
      super();
      this.connectionParameters = new ConnectionParameters(config);
      this.user = this.connectionParameters.user;
      this.database = this.connectionParameters.database;
      this.port = this.connectionParameters.port;
      this.host = this.connectionParameters.host;
      Object.defineProperty(this, "password", {
        configurable: true,
        enumerable: false,
        writable: true,
        value: this.connectionParameters.password
      });
      this.replication = this.connectionParameters.replication;
      const c = config || {};
      if (c.Promise) {
        byoPromiseDeprecationNotice();
      }
      this._Promise = c.Promise || global.Promise;
      this._types = new TypeOverrides(c.types);
      this._ending = false;
      this._ended = false;
      this._connecting = false;
      this._connected = false;
      this._connectionError = false;
      this._queryable = true;
      this._activeQuery = null;
      this.enableChannelBinding = Boolean(c.enableChannelBinding);
      this.connection = c.connection || new Connection({
        stream: c.stream,
        ssl: this.connectionParameters.ssl,
        keepAlive: c.keepAlive || false,
        keepAliveInitialDelayMillis: c.keepAliveInitialDelayMillis || 0,
        encoding: this.connectionParameters.client_encoding || "utf8"
      });
      this._queryQueue = [];
      this.binary = c.binary || defaults.binary;
      this.processID = null;
      this.secretKey = null;
      this.ssl = this.connectionParameters.ssl || false;
      if (this.ssl && this.ssl.key) {
        Object.defineProperty(this.ssl, "key", {
          enumerable: false
        });
      }
      this._connectionTimeoutMillis = c.connectionTimeoutMillis || 0;
    }
    get activeQuery() {
      activeQueryDeprecationNotice();
      return this._activeQuery;
    }
    set activeQuery(val) {
      activeQueryDeprecationNotice();
      this._activeQuery = val;
    }
    _getActiveQuery() {
      return this._activeQuery;
    }
    _errorAllQueries(err) {
      const enqueueError = (query) => {
        process.nextTick(() => {
          query.handleError(err, this.connection);
        });
      };
      const activeQuery = this._getActiveQuery();
      if (activeQuery) {
        enqueueError(activeQuery);
        this._activeQuery = null;
      }
      this._queryQueue.forEach(enqueueError);
      this._queryQueue.length = 0;
    }
    _connect(callback) {
      const self = this;
      const con = this.connection;
      this._connectionCallback = callback;
      if (this._connecting || this._connected) {
        const err = new Error("Client has already been connected. You cannot reuse a client.");
        process.nextTick(() => {
          callback(err);
        });
        return;
      }
      this._connecting = true;
      if (this._connectionTimeoutMillis > 0) {
        this.connectionTimeoutHandle = setTimeout(() => {
          con._ending = true;
          con.stream.destroy(new Error("timeout expired"));
        }, this._connectionTimeoutMillis);
        if (this.connectionTimeoutHandle.unref) {
          this.connectionTimeoutHandle.unref();
        }
      }
      if (this.host && this.host.indexOf("/") === 0) {
        con.connect(this.host + "/.s.PGSQL." + this.port);
      } else {
        con.connect(this.port, this.host);
      }
      con.on("connect", function() {
        if (self.ssl) {
          con.requestSsl();
        } else {
          con.startup(self.getStartupConf());
        }
      });
      con.on("sslconnect", function() {
        con.startup(self.getStartupConf());
      });
      this._attachListeners(con);
      con.once("end", () => {
        const error = this._ending ? new Error("Connection terminated") : new Error("Connection terminated unexpectedly");
        clearTimeout(this.connectionTimeoutHandle);
        this._errorAllQueries(error);
        this._ended = true;
        if (!this._ending) {
          if (this._connecting && !this._connectionError) {
            if (this._connectionCallback) {
              this._connectionCallback(error);
            } else {
              this._handleErrorEvent(error);
            }
          } else if (!this._connectionError) {
            this._handleErrorEvent(error);
          }
        }
        process.nextTick(() => {
          this.emit("end");
        });
      });
    }
    connect(callback) {
      if (callback) {
        this._connect(callback);
        return;
      }
      return new this._Promise((resolve, reject) => {
        this._connect((error) => {
          if (error) {
            reject(error);
          } else {
            resolve(this);
          }
        });
      });
    }
    _attachListeners(con) {
      con.on("authenticationCleartextPassword", this._handleAuthCleartextPassword.bind(this));
      con.on("authenticationMD5Password", this._handleAuthMD5Password.bind(this));
      con.on("authenticationSASL", this._handleAuthSASL.bind(this));
      con.on("authenticationSASLContinue", this._handleAuthSASLContinue.bind(this));
      con.on("authenticationSASLFinal", this._handleAuthSASLFinal.bind(this));
      con.on("backendKeyData", this._handleBackendKeyData.bind(this));
      con.on("error", this._handleErrorEvent.bind(this));
      con.on("errorMessage", this._handleErrorMessage.bind(this));
      con.on("readyForQuery", this._handleReadyForQuery.bind(this));
      con.on("notice", this._handleNotice.bind(this));
      con.on("rowDescription", this._handleRowDescription.bind(this));
      con.on("dataRow", this._handleDataRow.bind(this));
      con.on("portalSuspended", this._handlePortalSuspended.bind(this));
      con.on("emptyQuery", this._handleEmptyQuery.bind(this));
      con.on("commandComplete", this._handleCommandComplete.bind(this));
      con.on("parseComplete", this._handleParseComplete.bind(this));
      con.on("copyInResponse", this._handleCopyInResponse.bind(this));
      con.on("copyData", this._handleCopyData.bind(this));
      con.on("notification", this._handleNotification.bind(this));
    }
    _getPassword(cb) {
      const con = this.connection;
      if (typeof this.password === "function") {
        this._Promise.resolve().then(() => this.password(this.connectionParameters)).then((pass) => {
          if (pass !== undefined) {
            if (typeof pass !== "string") {
              con.emit("error", new TypeError("Password must be a string"));
              return;
            }
            this.connectionParameters.password = this.password = pass;
          } else {
            this.connectionParameters.password = this.password = null;
          }
          cb();
        }).catch((err) => {
          con.emit("error", err);
        });
      } else if (this.password !== null) {
        cb();
      } else {
        try {
          const pgPass = require_lib();
          pgPass(this.connectionParameters, (pass) => {
            if (pass !== undefined) {
              pgPassDeprecationNotice();
              this.connectionParameters.password = this.password = pass;
            }
            cb();
          });
        } catch (e2) {
          this.emit("error", e2);
        }
      }
    }
    _handleAuthCleartextPassword(msg) {
      this._getPassword(() => {
        this.connection.password(this.password);
      });
    }
    _handleAuthMD5Password(msg) {
      this._getPassword(async () => {
        try {
          const hashedPassword = await crypto.postgresMd5PasswordHash(this.user, this.password, msg.salt);
          this.connection.password(hashedPassword);
        } catch (e2) {
          this.emit("error", e2);
        }
      });
    }
    _handleAuthSASL(msg) {
      this._getPassword(() => {
        try {
          this.saslSession = sasl.startSession(msg.mechanisms, this.enableChannelBinding && this.connection.stream);
          this.connection.sendSASLInitialResponseMessage(this.saslSession.mechanism, this.saslSession.response);
        } catch (err) {
          this.connection.emit("error", err);
        }
      });
    }
    async _handleAuthSASLContinue(msg) {
      try {
        await sasl.continueSession(this.saslSession, this.password, msg.data, this.enableChannelBinding && this.connection.stream);
        this.connection.sendSCRAMClientFinalMessage(this.saslSession.response);
      } catch (err) {
        this.connection.emit("error", err);
      }
    }
    _handleAuthSASLFinal(msg) {
      try {
        sasl.finalizeSession(this.saslSession, msg.data);
        this.saslSession = null;
      } catch (err) {
        this.connection.emit("error", err);
      }
    }
    _handleBackendKeyData(msg) {
      this.processID = msg.processID;
      this.secretKey = msg.secretKey;
    }
    _handleReadyForQuery(msg) {
      if (this._connecting) {
        this._connecting = false;
        this._connected = true;
        clearTimeout(this.connectionTimeoutHandle);
        if (this._connectionCallback) {
          this._connectionCallback(null, this);
          this._connectionCallback = null;
        }
        this.emit("connect");
      }
      const activeQuery = this._getActiveQuery();
      this._activeQuery = null;
      this.readyForQuery = true;
      if (activeQuery) {
        activeQuery.handleReadyForQuery(this.connection);
      }
      this._pulseQueryQueue();
    }
    _handleErrorWhileConnecting(err) {
      if (this._connectionError) {
        return;
      }
      this._connectionError = true;
      clearTimeout(this.connectionTimeoutHandle);
      if (this._connectionCallback) {
        return this._connectionCallback(err);
      }
      this.emit("error", err);
    }
    _handleErrorEvent(err) {
      if (this._connecting) {
        return this._handleErrorWhileConnecting(err);
      }
      this._queryable = false;
      this._errorAllQueries(err);
      this.emit("error", err);
    }
    _handleErrorMessage(msg) {
      if (this._connecting) {
        return this._handleErrorWhileConnecting(msg);
      }
      const activeQuery = this._getActiveQuery();
      if (!activeQuery) {
        this._handleErrorEvent(msg);
        return;
      }
      this._activeQuery = null;
      activeQuery.handleError(msg, this.connection);
    }
    _handleRowDescription(msg) {
      const activeQuery = this._getActiveQuery();
      if (activeQuery == null) {
        const error = new Error("Received unexpected rowDescription message from backend.");
        this._handleErrorEvent(error);
        return;
      }
      activeQuery.handleRowDescription(msg);
    }
    _handleDataRow(msg) {
      const activeQuery = this._getActiveQuery();
      if (activeQuery == null) {
        const error = new Error("Received unexpected dataRow message from backend.");
        this._handleErrorEvent(error);
        return;
      }
      activeQuery.handleDataRow(msg);
    }
    _handlePortalSuspended(msg) {
      const activeQuery = this._getActiveQuery();
      if (activeQuery == null) {
        const error = new Error("Received unexpected portalSuspended message from backend.");
        this._handleErrorEvent(error);
        return;
      }
      activeQuery.handlePortalSuspended(this.connection);
    }
    _handleEmptyQuery(msg) {
      const activeQuery = this._getActiveQuery();
      if (activeQuery == null) {
        const error = new Error("Received unexpected emptyQuery message from backend.");
        this._handleErrorEvent(error);
        return;
      }
      activeQuery.handleEmptyQuery(this.connection);
    }
    _handleCommandComplete(msg) {
      const activeQuery = this._getActiveQuery();
      if (activeQuery == null) {
        const error = new Error("Received unexpected commandComplete message from backend.");
        this._handleErrorEvent(error);
        return;
      }
      activeQuery.handleCommandComplete(msg, this.connection);
    }
    _handleParseComplete() {
      const activeQuery = this._getActiveQuery();
      if (activeQuery == null) {
        const error = new Error("Received unexpected parseComplete message from backend.");
        this._handleErrorEvent(error);
        return;
      }
      if (activeQuery.name) {
        this.connection.parsedStatements[activeQuery.name] = activeQuery.text;
      }
    }
    _handleCopyInResponse(msg) {
      const activeQuery = this._getActiveQuery();
      if (activeQuery == null) {
        const error = new Error("Received unexpected copyInResponse message from backend.");
        this._handleErrorEvent(error);
        return;
      }
      activeQuery.handleCopyInResponse(this.connection);
    }
    _handleCopyData(msg) {
      const activeQuery = this._getActiveQuery();
      if (activeQuery == null) {
        const error = new Error("Received unexpected copyData message from backend.");
        this._handleErrorEvent(error);
        return;
      }
      activeQuery.handleCopyData(msg, this.connection);
    }
    _handleNotification(msg) {
      this.emit("notification", msg);
    }
    _handleNotice(msg) {
      this.emit("notice", msg);
    }
    getStartupConf() {
      const params = this.connectionParameters;
      const data = {
        user: params.user,
        database: params.database
      };
      const appName = params.application_name || params.fallback_application_name;
      if (appName) {
        data.application_name = appName;
      }
      if (params.replication) {
        data.replication = "" + params.replication;
      }
      if (params.statement_timeout) {
        data.statement_timeout = String(parseInt(params.statement_timeout, 10));
      }
      if (params.lock_timeout) {
        data.lock_timeout = String(parseInt(params.lock_timeout, 10));
      }
      if (params.idle_in_transaction_session_timeout) {
        data.idle_in_transaction_session_timeout = String(parseInt(params.idle_in_transaction_session_timeout, 10));
      }
      if (params.options) {
        data.options = params.options;
      }
      return data;
    }
    cancel(client, query) {
      if (client.activeQuery === query) {
        const con = this.connection;
        if (this.host && this.host.indexOf("/") === 0) {
          con.connect(this.host + "/.s.PGSQL." + this.port);
        } else {
          con.connect(this.port, this.host);
        }
        con.on("connect", function() {
          con.cancel(client.processID, client.secretKey);
        });
      } else if (client._queryQueue.indexOf(query) !== -1) {
        client._queryQueue.splice(client._queryQueue.indexOf(query), 1);
      }
    }
    setTypeParser(oid, format, parseFn) {
      return this._types.setTypeParser(oid, format, parseFn);
    }
    getTypeParser(oid, format) {
      return this._types.getTypeParser(oid, format);
    }
    escapeIdentifier(str) {
      return utils.escapeIdentifier(str);
    }
    escapeLiteral(str) {
      return utils.escapeLiteral(str);
    }
    _pulseQueryQueue() {
      if (this.readyForQuery === true) {
        this._activeQuery = this._queryQueue.shift();
        const activeQuery = this._getActiveQuery();
        if (activeQuery) {
          this.readyForQuery = false;
          this.hasExecuted = true;
          const queryError = activeQuery.submit(this.connection);
          if (queryError) {
            process.nextTick(() => {
              activeQuery.handleError(queryError, this.connection);
              this.readyForQuery = true;
              this._pulseQueryQueue();
            });
          }
        } else if (this.hasExecuted) {
          this._activeQuery = null;
          this.emit("drain");
        }
      }
    }
    query(config, values, callback) {
      let query;
      let result;
      let readTimeout;
      let readTimeoutTimer;
      let queryCallback;
      if (config === null || config === undefined) {
        throw new TypeError("Client was passed a null or undefined query");
      } else if (typeof config.submit === "function") {
        readTimeout = config.query_timeout || this.connectionParameters.query_timeout;
        result = query = config;
        if (!query.callback) {
          if (typeof values === "function") {
            query.callback = values;
          } else if (callback) {
            query.callback = callback;
          }
        }
      } else {
        readTimeout = config.query_timeout || this.connectionParameters.query_timeout;
        query = new Query(config, values, callback);
        if (!query.callback) {
          result = new this._Promise((resolve, reject) => {
            query.callback = (err, res) => err ? reject(err) : resolve(res);
          }).catch((err) => {
            Error.captureStackTrace(err);
            throw err;
          });
        }
      }
      if (readTimeout) {
        queryCallback = query.callback || (() => {});
        readTimeoutTimer = setTimeout(() => {
          const error = new Error("Query read timeout");
          process.nextTick(() => {
            query.handleError(error, this.connection);
          });
          queryCallback(error);
          query.callback = () => {};
          const index = this._queryQueue.indexOf(query);
          if (index > -1) {
            this._queryQueue.splice(index, 1);
          }
          this._pulseQueryQueue();
        }, readTimeout);
        query.callback = (err, res) => {
          clearTimeout(readTimeoutTimer);
          queryCallback(err, res);
        };
      }
      if (this.binary && !query.binary) {
        query.binary = true;
      }
      if (query._result && !query._result._types) {
        query._result._types = this._types;
      }
      if (!this._queryable) {
        process.nextTick(() => {
          query.handleError(new Error("Client has encountered a connection error and is not queryable"), this.connection);
        });
        return result;
      }
      if (this._ending) {
        process.nextTick(() => {
          query.handleError(new Error("Client was closed and is not queryable"), this.connection);
        });
        return result;
      }
      if (this._queryQueue.length > 0) {
        queryQueueLengthDeprecationNotice();
      }
      this._queryQueue.push(query);
      this._pulseQueryQueue();
      return result;
    }
    ref() {
      this.connection.ref();
    }
    unref() {
      this.connection.unref();
    }
    end(cb) {
      this._ending = true;
      if (!this.connection._connecting || this._ended) {
        if (cb) {
          cb();
        } else {
          return this._Promise.resolve();
        }
      }
      if (this._getActiveQuery() || !this._queryable) {
        this.connection.stream.destroy();
      } else {
        this.connection.end();
      }
      if (cb) {
        this.connection.once("end", cb);
      } else {
        return new this._Promise((resolve) => {
          this.connection.once("end", resolve);
        });
      }
    }
    get queryQueue() {
      queryQueueDeprecationNotice();
      return this._queryQueue;
    }
  }
  Client.Query = Query;
  module.exports = Client;
});

// node_modules/pg-pool/index.js
var require_pg_pool = __commonJS((exports, module) => {
  var EventEmitter = __require("events").EventEmitter;
  var NOOP = function() {};
  var removeWhere = (list, predicate) => {
    const i = list.findIndex(predicate);
    return i === -1 ? undefined : list.splice(i, 1)[0];
  };

  class IdleItem {
    constructor(client, idleListener, timeoutId) {
      this.client = client;
      this.idleListener = idleListener;
      this.timeoutId = timeoutId;
    }
  }

  class PendingItem {
    constructor(callback) {
      this.callback = callback;
    }
  }
  function throwOnDoubleRelease() {
    throw new Error("Release called on client which has already been released to the pool.");
  }
  function promisify(Promise2, callback) {
    if (callback) {
      return { callback, result: undefined };
    }
    let rej;
    let res;
    const cb = function(err, client) {
      err ? rej(err) : res(client);
    };
    const result = new Promise2(function(resolve, reject) {
      res = resolve;
      rej = reject;
    }).catch((err) => {
      Error.captureStackTrace(err);
      throw err;
    });
    return { callback: cb, result };
  }
  function makeIdleListener(pool, client) {
    return function idleListener(err) {
      err.client = client;
      client.removeListener("error", idleListener);
      client.on("error", () => {
        pool.log("additional client error after disconnection due to error", err);
      });
      pool._remove(client);
      pool.emit("error", err, client);
    };
  }

  class Pool extends EventEmitter {
    constructor(options, Client) {
      super();
      this.options = Object.assign({}, options);
      if (options != null && "password" in options) {
        Object.defineProperty(this.options, "password", {
          configurable: true,
          enumerable: false,
          writable: true,
          value: options.password
        });
      }
      if (options != null && options.ssl && options.ssl.key) {
        Object.defineProperty(this.options.ssl, "key", {
          enumerable: false
        });
      }
      this.options.max = this.options.max || this.options.poolSize || 10;
      this.options.min = this.options.min || 0;
      this.options.maxUses = this.options.maxUses || Infinity;
      this.options.allowExitOnIdle = this.options.allowExitOnIdle || false;
      this.options.maxLifetimeSeconds = this.options.maxLifetimeSeconds || 0;
      this.log = this.options.log || function() {};
      this.Client = this.options.Client || Client || require_lib2().Client;
      this.Promise = this.options.Promise || global.Promise;
      if (typeof this.options.idleTimeoutMillis === "undefined") {
        this.options.idleTimeoutMillis = 1e4;
      }
      this._clients = [];
      this._idle = [];
      this._expired = new WeakSet;
      this._pendingQueue = [];
      this._endCallback = undefined;
      this.ending = false;
      this.ended = false;
    }
    _promiseTry(f) {
      const Promise2 = this.Promise;
      if (typeof Promise2.try === "function") {
        return Promise2.try(f);
      }
      return new Promise2((resolve) => resolve(f()));
    }
    _isFull() {
      return this._clients.length >= this.options.max;
    }
    _isAboveMin() {
      return this._clients.length > this.options.min;
    }
    _pulseQueue() {
      this.log("pulse queue");
      if (this.ended) {
        this.log("pulse queue ended");
        return;
      }
      if (this.ending) {
        this.log("pulse queue on ending");
        if (this._idle.length) {
          this._idle.slice().map((item) => {
            this._remove(item.client);
          });
        }
        if (!this._clients.length) {
          this.ended = true;
          this._endCallback();
        }
        return;
      }
      if (!this._pendingQueue.length) {
        this.log("no queued requests");
        return;
      }
      if (!this._idle.length && this._isFull()) {
        return;
      }
      const pendingItem = this._pendingQueue.shift();
      if (this._idle.length) {
        const idleItem = this._idle.pop();
        clearTimeout(idleItem.timeoutId);
        const client = idleItem.client;
        client.ref && client.ref();
        const idleListener = idleItem.idleListener;
        return this._acquireClient(client, pendingItem, idleListener, false);
      }
      if (!this._isFull()) {
        return this.newClient(pendingItem);
      }
      throw new Error("unexpected condition");
    }
    _remove(client, callback) {
      const removed = removeWhere(this._idle, (item) => item.client === client);
      if (removed !== undefined) {
        clearTimeout(removed.timeoutId);
      }
      this._clients = this._clients.filter((c) => c !== client);
      const context = this;
      client.end(() => {
        context.emit("remove", client);
        if (typeof callback === "function") {
          callback();
        }
      });
    }
    connect(cb) {
      if (this.ending) {
        const err = new Error("Cannot use a pool after calling end on the pool");
        return cb ? cb(err) : this.Promise.reject(err);
      }
      const response = promisify(this.Promise, cb);
      const result = response.result;
      if (this._isFull() || this._idle.length) {
        if (this._idle.length) {
          process.nextTick(() => this._pulseQueue());
        }
        if (!this.options.connectionTimeoutMillis) {
          this._pendingQueue.push(new PendingItem(response.callback));
          return result;
        }
        const queueCallback = (err, res, done) => {
          clearTimeout(tid);
          response.callback(err, res, done);
        };
        const pendingItem = new PendingItem(queueCallback);
        const tid = setTimeout(() => {
          removeWhere(this._pendingQueue, (i) => i.callback === queueCallback);
          pendingItem.timedOut = true;
          response.callback(new Error("timeout exceeded when trying to connect"));
        }, this.options.connectionTimeoutMillis);
        if (tid.unref) {
          tid.unref();
        }
        this._pendingQueue.push(pendingItem);
        return result;
      }
      this.newClient(new PendingItem(response.callback));
      return result;
    }
    newClient(pendingItem) {
      const client = new this.Client(this.options);
      this._clients.push(client);
      const idleListener = makeIdleListener(this, client);
      this.log("checking client timeout");
      let tid;
      let timeoutHit = false;
      if (this.options.connectionTimeoutMillis) {
        tid = setTimeout(() => {
          if (client.connection) {
            this.log("ending client due to timeout");
            timeoutHit = true;
            client.connection.stream.destroy();
          } else if (!client.isConnected()) {
            this.log("ending client due to timeout");
            timeoutHit = true;
            client.end();
          }
        }, this.options.connectionTimeoutMillis);
      }
      this.log("connecting new client");
      client.connect((err) => {
        if (tid) {
          clearTimeout(tid);
        }
        client.on("error", idleListener);
        if (err) {
          this.log("client failed to connect", err);
          this._clients = this._clients.filter((c) => c !== client);
          if (timeoutHit) {
            err = new Error("Connection terminated due to connection timeout", { cause: err });
          }
          this._pulseQueue();
          if (!pendingItem.timedOut) {
            pendingItem.callback(err, undefined, NOOP);
          }
        } else {
          this.log("new client connected");
          if (this.options.onConnect) {
            this._promiseTry(() => this.options.onConnect(client)).then(() => {
              this._afterConnect(client, pendingItem, idleListener);
            }, (hookErr) => {
              this._clients = this._clients.filter((c) => c !== client);
              client.end(() => {
                this._pulseQueue();
                if (!pendingItem.timedOut) {
                  pendingItem.callback(hookErr, undefined, NOOP);
                }
              });
            });
            return;
          }
          return this._afterConnect(client, pendingItem, idleListener);
        }
      });
    }
    _afterConnect(client, pendingItem, idleListener) {
      if (this.options.maxLifetimeSeconds !== 0) {
        const maxLifetimeTimeout = setTimeout(() => {
          this.log("ending client due to expired lifetime");
          this._expired.add(client);
          const idleIndex = this._idle.findIndex((idleItem) => idleItem.client === client);
          if (idleIndex !== -1) {
            this._acquireClient(client, new PendingItem((err, client2, clientRelease) => clientRelease()), idleListener, false);
          }
        }, this.options.maxLifetimeSeconds * 1000);
        maxLifetimeTimeout.unref();
        client.once("end", () => clearTimeout(maxLifetimeTimeout));
      }
      return this._acquireClient(client, pendingItem, idleListener, true);
    }
    _acquireClient(client, pendingItem, idleListener, isNew) {
      if (isNew) {
        this.emit("connect", client);
      }
      this.emit("acquire", client);
      client.release = this._releaseOnce(client, idleListener);
      client.removeListener("error", idleListener);
      if (!pendingItem.timedOut) {
        if (isNew && this.options.verify) {
          this.options.verify(client, (err) => {
            if (err) {
              client.release(err);
              return pendingItem.callback(err, undefined, NOOP);
            }
            pendingItem.callback(undefined, client, client.release);
          });
        } else {
          pendingItem.callback(undefined, client, client.release);
        }
      } else {
        if (isNew && this.options.verify) {
          this.options.verify(client, client.release);
        } else {
          client.release();
        }
      }
    }
    _releaseOnce(client, idleListener) {
      let released = false;
      return (err) => {
        if (released) {
          throwOnDoubleRelease();
        }
        released = true;
        this._release(client, idleListener, err);
      };
    }
    _release(client, idleListener, err) {
      client.on("error", idleListener);
      client._poolUseCount = (client._poolUseCount || 0) + 1;
      this.emit("release", err, client);
      if (err || this.ending || !client._queryable || client._ending || client._poolUseCount >= this.options.maxUses) {
        if (client._poolUseCount >= this.options.maxUses) {
          this.log("remove expended client");
        }
        return this._remove(client, this._pulseQueue.bind(this));
      }
      const isExpired = this._expired.has(client);
      if (isExpired) {
        this.log("remove expired client");
        this._expired.delete(client);
        return this._remove(client, this._pulseQueue.bind(this));
      }
      let tid;
      if (this.options.idleTimeoutMillis && this._isAboveMin()) {
        tid = setTimeout(() => {
          if (this._isAboveMin()) {
            this.log("remove idle client");
            this._remove(client, this._pulseQueue.bind(this));
          }
        }, this.options.idleTimeoutMillis);
        if (this.options.allowExitOnIdle) {
          tid.unref();
        }
      }
      if (this.options.allowExitOnIdle) {
        client.unref();
      }
      this._idle.push(new IdleItem(client, idleListener, tid));
      this._pulseQueue();
    }
    query(text, values, cb) {
      if (typeof text === "function") {
        const response2 = promisify(this.Promise, text);
        setImmediate(function() {
          return response2.callback(new Error("Passing a function as the first parameter to pool.query is not supported"));
        });
        return response2.result;
      }
      if (typeof values === "function") {
        cb = values;
        values = undefined;
      }
      const response = promisify(this.Promise, cb);
      cb = response.callback;
      this.connect((err, client) => {
        if (err) {
          return cb(err);
        }
        let clientReleased = false;
        const onError = (err2) => {
          if (clientReleased) {
            return;
          }
          clientReleased = true;
          client.release(err2);
          cb(err2);
        };
        client.once("error", onError);
        this.log("dispatching query");
        try {
          client.query(text, values, (err2, res) => {
            this.log("query dispatched");
            client.removeListener("error", onError);
            if (clientReleased) {
              return;
            }
            clientReleased = true;
            client.release(err2);
            if (err2) {
              return cb(err2);
            }
            return cb(undefined, res);
          });
        } catch (err2) {
          client.release(err2);
          return cb(err2);
        }
      });
      return response.result;
    }
    end(cb) {
      this.log("ending");
      if (this.ending) {
        const err = new Error("Called end on pool more than once");
        return cb ? cb(err) : this.Promise.reject(err);
      }
      this.ending = true;
      const promised = promisify(this.Promise, cb);
      this._endCallback = promised.callback;
      this._pulseQueue();
      return promised.result;
    }
    get waitingCount() {
      return this._pendingQueue.length;
    }
    get idleCount() {
      return this._idle.length;
    }
    get expiredCount() {
      return this._clients.reduce((acc, client) => acc + (this._expired.has(client) ? 1 : 0), 0);
    }
    get totalCount() {
      return this._clients.length;
    }
  }
  module.exports = Pool;
});

// node_modules/pg/lib/native/query.js
var require_query2 = __commonJS((exports, module) => {
  var EventEmitter = __require("events").EventEmitter;
  var util = __require("util");
  var utils = require_utils();
  var NativeQuery = module.exports = function(config, values, callback) {
    EventEmitter.call(this);
    config = utils.normalizeQueryConfig(config, values, callback);
    this.text = config.text;
    this.values = config.values;
    this.name = config.name;
    this.queryMode = config.queryMode;
    this.callback = config.callback;
    this.state = "new";
    this._arrayMode = config.rowMode === "array";
    this._emitRowEvents = false;
    this.on("newListener", function(event) {
      if (event === "row")
        this._emitRowEvents = true;
    }.bind(this));
  };
  util.inherits(NativeQuery, EventEmitter);
  var errorFieldMap = {
    sqlState: "code",
    statementPosition: "position",
    messagePrimary: "message",
    context: "where",
    schemaName: "schema",
    tableName: "table",
    columnName: "column",
    dataTypeName: "dataType",
    constraintName: "constraint",
    sourceFile: "file",
    sourceLine: "line",
    sourceFunction: "routine"
  };
  NativeQuery.prototype.handleError = function(err) {
    const fields = this.native.pq.resultErrorFields();
    if (fields) {
      for (const key in fields) {
        const normalizedFieldName = errorFieldMap[key] || key;
        err[normalizedFieldName] = fields[key];
      }
    }
    if (this.callback) {
      this.callback(err);
    } else {
      this.emit("error", err);
    }
    this.state = "error";
  };
  NativeQuery.prototype.then = function(onSuccess, onFailure) {
    return this._getPromise().then(onSuccess, onFailure);
  };
  NativeQuery.prototype.catch = function(callback) {
    return this._getPromise().catch(callback);
  };
  NativeQuery.prototype._getPromise = function() {
    if (this._promise)
      return this._promise;
    this._promise = new Promise(function(resolve, reject) {
      this._once("end", resolve);
      this._once("error", reject);
    }.bind(this));
    return this._promise;
  };
  NativeQuery.prototype.submit = function(client) {
    this.state = "running";
    const self = this;
    this.native = client.native;
    client.native.arrayMode = this._arrayMode;
    let after = function(err, rows, results) {
      client.native.arrayMode = false;
      setImmediate(function() {
        self.emit("_done");
      });
      if (err) {
        return self.handleError(err);
      }
      if (self._emitRowEvents) {
        if (results.length > 1) {
          rows.forEach((rowOfRows, i) => {
            rowOfRows.forEach((row) => {
              self.emit("row", row, results[i]);
            });
          });
        } else {
          rows.forEach(function(row) {
            self.emit("row", row, results);
          });
        }
      }
      self.state = "end";
      self.emit("end", results);
      if (self.callback) {
        self.callback(null, results);
      }
    };
    if (process.domain) {
      after = process.domain.bind(after);
    }
    if (this.name) {
      if (this.name.length > 63) {
        console.error("Warning! Postgres only supports 63 characters for query names.");
        console.error("You supplied %s (%s)", this.name, this.name.length);
        console.error("This can cause conflicts and silent errors executing queries");
      }
      const values = (this.values || []).map(utils.prepareValue);
      if (client.namedQueries[this.name]) {
        if (this.text && client.namedQueries[this.name] !== this.text) {
          const err = new Error(`Prepared statements must be unique - '${this.name}' was used for a different statement`);
          return after(err);
        }
        return client.native.execute(this.name, values, after);
      }
      return client.native.prepare(this.name, this.text, values.length, function(err) {
        if (err)
          return after(err);
        client.namedQueries[self.name] = self.text;
        return self.native.execute(self.name, values, after);
      });
    } else if (this.values) {
      if (!Array.isArray(this.values)) {
        const err = new Error("Query values must be an array");
        return after(err);
      }
      const vals = this.values.map(utils.prepareValue);
      client.native.query(this.text, vals, after);
    } else if (this.queryMode === "extended") {
      client.native.query(this.text, [], after);
    } else {
      client.native.query(this.text, after);
    }
  };
});

// node_modules/pg/lib/native/client.js
var require_client2 = __commonJS((exports, module) => {
  var nodeUtils = __require("util");
  var Native;
  try {
    Native = (()=>{throw new Error("Cannot require module "+"pg-native");})();
  } catch (e2) {
    throw e2;
  }
  var TypeOverrides = require_type_overrides();
  var EventEmitter = __require("events").EventEmitter;
  var util = __require("util");
  var ConnectionParameters = require_connection_parameters();
  var NativeQuery = require_query2();
  var queryQueueLengthDeprecationNotice = nodeUtils.deprecate(() => {}, "Calling client.query() when the client is already executing a query is deprecated and will be removed in pg@9.0. Use async/await or an external async flow control mechanism instead.");
  var Client = module.exports = function(config) {
    EventEmitter.call(this);
    config = config || {};
    this._Promise = config.Promise || global.Promise;
    this._types = new TypeOverrides(config.types);
    this.native = new Native({
      types: this._types
    });
    this._queryQueue = [];
    this._ending = false;
    this._connecting = false;
    this._connected = false;
    this._queryable = true;
    const cp = this.connectionParameters = new ConnectionParameters(config);
    if (config.nativeConnectionString)
      cp.nativeConnectionString = config.nativeConnectionString;
    this.user = cp.user;
    Object.defineProperty(this, "password", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: cp.password
    });
    this.database = cp.database;
    this.host = cp.host;
    this.port = cp.port;
    this.namedQueries = {};
  };
  Client.Query = NativeQuery;
  util.inherits(Client, EventEmitter);
  Client.prototype._errorAllQueries = function(err) {
    const enqueueError = (query) => {
      process.nextTick(() => {
        query.native = this.native;
        query.handleError(err);
      });
    };
    if (this._hasActiveQuery()) {
      enqueueError(this._activeQuery);
      this._activeQuery = null;
    }
    this._queryQueue.forEach(enqueueError);
    this._queryQueue.length = 0;
  };
  Client.prototype._connect = function(cb) {
    const self = this;
    if (this._connecting) {
      process.nextTick(() => cb(new Error("Client has already been connected. You cannot reuse a client.")));
      return;
    }
    this._connecting = true;
    this.connectionParameters.getLibpqConnectionString(function(err, conString) {
      if (self.connectionParameters.nativeConnectionString)
        conString = self.connectionParameters.nativeConnectionString;
      if (err)
        return cb(err);
      self.native.connect(conString, function(err2) {
        if (err2) {
          self.native.end();
          return cb(err2);
        }
        self._connected = true;
        self.native.on("error", function(err3) {
          self._queryable = false;
          self._errorAllQueries(err3);
          self.emit("error", err3);
        });
        self.native.on("notification", function(msg) {
          self.emit("notification", {
            channel: msg.relname,
            payload: msg.extra
          });
        });
        self.emit("connect");
        self._pulseQueryQueue(true);
        cb(null, this);
      });
    });
  };
  Client.prototype.connect = function(callback) {
    if (callback) {
      this._connect(callback);
      return;
    }
    return new this._Promise((resolve, reject) => {
      this._connect((error) => {
        if (error) {
          reject(error);
        } else {
          resolve(this);
        }
      });
    });
  };
  Client.prototype.query = function(config, values, callback) {
    let query;
    let result;
    let readTimeout;
    let readTimeoutTimer;
    let queryCallback;
    if (config === null || config === undefined) {
      throw new TypeError("Client was passed a null or undefined query");
    } else if (typeof config.submit === "function") {
      readTimeout = config.query_timeout || this.connectionParameters.query_timeout;
      result = query = config;
      if (typeof values === "function") {
        config.callback = values;
      }
    } else {
      readTimeout = config.query_timeout || this.connectionParameters.query_timeout;
      query = new NativeQuery(config, values, callback);
      if (!query.callback) {
        let resolveOut, rejectOut;
        result = new this._Promise((resolve, reject) => {
          resolveOut = resolve;
          rejectOut = reject;
        }).catch((err) => {
          Error.captureStackTrace(err);
          throw err;
        });
        query.callback = (err, res) => err ? rejectOut(err) : resolveOut(res);
      }
    }
    if (readTimeout) {
      queryCallback = query.callback || (() => {});
      readTimeoutTimer = setTimeout(() => {
        const error = new Error("Query read timeout");
        process.nextTick(() => {
          query.handleError(error, this.connection);
        });
        queryCallback(error);
        query.callback = () => {};
        const index = this._queryQueue.indexOf(query);
        if (index > -1) {
          this._queryQueue.splice(index, 1);
        }
        this._pulseQueryQueue();
      }, readTimeout);
      query.callback = (err, res) => {
        clearTimeout(readTimeoutTimer);
        queryCallback(err, res);
      };
    }
    if (!this._queryable) {
      query.native = this.native;
      process.nextTick(() => {
        query.handleError(new Error("Client has encountered a connection error and is not queryable"));
      });
      return result;
    }
    if (this._ending) {
      query.native = this.native;
      process.nextTick(() => {
        query.handleError(new Error("Client was closed and is not queryable"));
      });
      return result;
    }
    if (this._queryQueue.length > 0) {
      queryQueueLengthDeprecationNotice();
    }
    this._queryQueue.push(query);
    this._pulseQueryQueue();
    return result;
  };
  Client.prototype.end = function(cb) {
    const self = this;
    this._ending = true;
    if (!this._connected) {
      this.once("connect", this.end.bind(this, cb));
    }
    let result;
    if (!cb) {
      result = new this._Promise(function(resolve, reject) {
        cb = (err) => err ? reject(err) : resolve();
      });
    }
    this.native.end(function() {
      self._connected = false;
      self._errorAllQueries(new Error("Connection terminated"));
      process.nextTick(() => {
        self.emit("end");
        if (cb)
          cb();
      });
    });
    return result;
  };
  Client.prototype._hasActiveQuery = function() {
    return this._activeQuery && this._activeQuery.state !== "error" && this._activeQuery.state !== "end";
  };
  Client.prototype._pulseQueryQueue = function(initialConnection) {
    if (!this._connected) {
      return;
    }
    if (this._hasActiveQuery()) {
      return;
    }
    const query = this._queryQueue.shift();
    if (!query) {
      if (!initialConnection) {
        this.emit("drain");
      }
      return;
    }
    this._activeQuery = query;
    query.submit(this);
    const self = this;
    query.once("_done", function() {
      self._pulseQueryQueue();
    });
  };
  Client.prototype.cancel = function(query) {
    if (this._activeQuery === query) {
      this.native.cancel(function() {});
    } else if (this._queryQueue.indexOf(query) !== -1) {
      this._queryQueue.splice(this._queryQueue.indexOf(query), 1);
    }
  };
  Client.prototype.ref = function() {};
  Client.prototype.unref = function() {};
  Client.prototype.setTypeParser = function(oid, format, parseFn) {
    return this._types.setTypeParser(oid, format, parseFn);
  };
  Client.prototype.getTypeParser = function(oid, format) {
    return this._types.getTypeParser(oid, format);
  };
  Client.prototype.isConnected = function() {
    return this._connected;
  };
});

// node_modules/pg/lib/index.js
var require_lib2 = __commonJS((exports, module) => {
  var Client = require_client();
  var defaults = require_defaults();
  var Connection = require_connection();
  var Result = require_result();
  var utils = require_utils();
  var Pool = require_pg_pool();
  var TypeOverrides = require_type_overrides();
  var { DatabaseError } = require_dist();
  var { escapeIdentifier, escapeLiteral } = require_utils();
  var poolFactory = (Client2) => {
    return class BoundPool extends Pool {
      constructor(options) {
        super(options, Client2);
      }
    };
  };
  var PG = function(clientConstructor2) {
    this.defaults = defaults;
    this.Client = clientConstructor2;
    this.Query = this.Client.Query;
    this.Pool = poolFactory(this.Client);
    this._pools = [];
    this.Connection = Connection;
    this.types = require_pg_types();
    this.DatabaseError = DatabaseError;
    this.TypeOverrides = TypeOverrides;
    this.escapeIdentifier = escapeIdentifier;
    this.escapeLiteral = escapeLiteral;
    this.Result = Result;
    this.utils = utils;
  };
  var clientConstructor = Client;
  var forceNative = false;
  try {
    forceNative = !!process.env.NODE_PG_FORCE_NATIVE;
  } catch {}
  if (forceNative) {
    clientConstructor = require_client2();
  }
  module.exports = new PG(clientConstructor);
  Object.defineProperty(module.exports, "native", {
    configurable: true,
    enumerable: false,
    get() {
      let native = null;
      try {
        native = new PG(require_client2());
      } catch (err) {
        if (err.code !== "MODULE_NOT_FOUND") {
          throw err;
        }
      }
      Object.defineProperty(module.exports, "native", {
        value: native
      });
      return native;
    }
  });
});

// node_modules/pg/esm/index.mjs
var exports_esm = {};
__export(exports_esm, {
  types: () => types,
  escapeLiteral: () => escapeLiteral,
  escapeIdentifier: () => escapeIdentifier,
  defaults: () => defaults,
  default: () => esm_default,
  TypeOverrides: () => TypeOverrides,
  Result: () => Result,
  Query: () => Query,
  Pool: () => Pool,
  DatabaseError: () => DatabaseError,
  Connection: () => Connection,
  Client: () => Client
});
var import_lib, Client, Pool, Connection, types, Query, DatabaseError, escapeIdentifier, escapeLiteral, Result, TypeOverrides, defaults, esm_default;
var init_esm = __esm(() => {
  import_lib = __toESM(require_lib2(), 1);
  Client = import_lib.default.Client;
  Pool = import_lib.default.Pool;
  Connection = import_lib.default.Connection;
  types = import_lib.default.types;
  Query = import_lib.default.Query;
  DatabaseError = import_lib.default.DatabaseError;
  escapeIdentifier = import_lib.default.escapeIdentifier;
  escapeLiteral = import_lib.default.escapeLiteral;
  Result = import_lib.default.Result;
  TypeOverrides = import_lib.default.TypeOverrides;
  defaults = import_lib.default.defaults;
  esm_default = import_lib.default;
});

// src/shared/runtime/endpoints.ts
var AgentHiveConfigError;
var init_endpoints = __esm(() => {
  init_pool();
  AgentHiveConfigError = class AgentHiveConfigError extends Error {
    constructor(message) {
      super(message);
      this.name = "AgentHiveConfigError";
      Object.setPrototypeOf(this, AgentHiveConfigError.prototype);
    }
  };
});

// src/infra/postgres/pool.ts
function isLongRunningPoolMode() {
  return poolLifecycleMode === "long-running";
}
function installPoolEndGuard(target) {
  const guarded = target;
  if (guarded[originalPoolEnd])
    return;
  const end = target.end.bind(target);
  guarded[originalPoolEnd] = end;
  target.end = async () => {
    if (isLongRunningPoolMode() && allowPoolEndDepth === 0) {
      const stack = new Error().stack ?? "stack unavailable";
      console.error("[PG] Ignored pool.end() in long-running pool lifecycle mode. " + `Use closePool() during process shutdown.
` + stack);
      return;
    }
    return end();
  };
}
async function endPoolBypassingGuard(target) {
  const guarded = target;
  const end = guarded[originalPoolEnd]?.bind(target) ?? target.end.bind(target);
  allowPoolEndDepth++;
  try {
    await end();
  } finally {
    allowPoolEndDepth--;
  }
}
function getDefaultSearchPath() {
  return [
    "roadmap_proposal",
    "roadmap_workforce",
    "roadmap_efficiency",
    "roadmap",
    "public"
  ];
}
function normalizeSchemaName(schema) {
  if (!schema)
    return null;
  const trimmed = schema.trim();
  if (!trimmed)
    return null;
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(trimmed)) {
    throw new Error(`[PG] Invalid schema name "${schema}".`);
  }
  return trimmed;
}
function buildSearchPathOptions(options, schema) {
  const parts = [options?.trim()].filter(Boolean);
  const searchPath = schema ? [schema, ...DEFAULT_SEARCH_PATH.filter((entry) => entry !== schema)] : DEFAULT_SEARCH_PATH;
  parts.push(`-c search_path=${searchPath.join(",")}`);
  return parts.length > 0 ? parts.join(" ") : undefined;
}
function parseDatabaseUrl(value) {
  if (!value)
    return {};
  try {
    const url = new URL(value);
    return {
      host: url.hostname || undefined,
      port: url.port ? Number(url.port) : undefined,
      user: url.username || undefined,
      password: url.password || undefined,
      database: url.pathname.replace(/^\/+/, "") || undefined
    };
  } catch {
    return {};
  }
}
function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}
function requirePgUser(resolved) {
  if (resolved)
    return resolved;
  console.warn("[PG] DEPRECATION (P448/V1): PGUSER is not set and the silent 'xiaomi' " + "fallback has been removed. Source /etc/agenthive/env before the next " + "service restart. This will be a hard error in 2026-Q3 (P448/V2).");
  throw new AgentHiveConfigError("[PG] PGUSER is required but not set. " + "Set PGUSER (and PGHOST, PGDATABASE) in /etc/agenthive/env. " + "See scripts/systemd/env.template for a migration guide.");
}
function resolvePoolConfig(config) {
  const databaseUrlConfig = parseDatabaseUrl(process.env.DATABASE_URL);
  const host = config?.host ?? process.env.PGHOST ?? databaseUrlConfig.host ?? (StructuralKeys.PGHOST.defaultValue ?? "127.0.0.1");
  const port = Number(config?.port ?? process.env.PGPORT ?? databaseUrlConfig.port) || Number(process.env.AGENTHIVE_PG_PORT ?? 6432);
  const database = config?.database ?? process.env.PGDATABASE ?? databaseUrlConfig.database ?? StructuralKeys.PGDATABASE.defaultValue ?? "agenthive";
  const inNodeTestRunner = process.env.NODE_TEST_CONTEXT != null || process.execArgv.some((a) => a === "--test" || a.startsWith("--test")) || process.argv.some((a) => a === "--test");
  if (inNodeTestRunner && database === "agenthive" && process.env.AGENTHIVE_ALLOW_LIVE_DB !== "1") {
    throw new Error('[pool] Refusing to connect the test runner to the LIVE database "agenthive". ' + "Tests must run against an isolated database (set PGDATABASE to a test DB), or " + "set AGENTHIVE_ALLOW_LIVE_DB=1 to explicitly override this guard.");
  }
  const user = config?.user ?? process.env.PGUSER ?? databaseUrlConfig.user;
  const configuredPassword = typeof config?.password === "function" ? undefined : config?.password;
  const resolvedPassword = configuredPassword ?? ConfigResolver.resolvePasswordSync({
    host,
    port: String(port),
    database: database ?? "agenthive",
    user: user ?? ""
  }) ?? process.env.__PGPASSWORD_FROM_CONFIG;
  const schema = normalizeSchemaName(config?.schema ?? configuredSchema ?? process.env.PG_SCHEMA);
  return {
    host,
    port,
    user: requirePgUser(user),
    password: resolvedPassword,
    database: database ?? StructuralKeys.PGDATABASE.defaultValue ?? "agenthive",
    options: buildSearchPathOptions(config?.options ?? process.env.PG_OPTIONS, schema),
    schema,
    connectionTimeoutMillis: parsePositiveInteger(config?.connectionTimeoutMillis ?? process.env.PG_CONNECTION_TIMEOUT_MS, StructuralKeys.PG_CONNECTION_TIMEOUT_MS.defaultValue ?? 5000),
    queryTimeoutMillis: parsePositiveInteger(config?.query_timeout ?? process.env.PG_QUERY_TIMEOUT_MS, StructuralKeys.PG_QUERY_TIMEOUT_MS.defaultValue ?? 30000),
    statementTimeoutMillis: parsePositiveInteger(config?.statement_timeout ?? process.env.PG_STATEMENT_TIMEOUT_MS, StructuralKeys.PG_STATEMENT_TIMEOUT_MS.defaultValue ?? 30000),
    max: parsePositiveInteger(config?.max ?? process.env.PG_POOL_MAX, 30)
  };
}
function getPoolSignature(config) {
  return JSON.stringify({
    host: config.host,
    port: config.port,
    user: config.user,
    database: config.database,
    options: config.options ?? null,
    schema: config.schema,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
    queryTimeoutMillis: config.queryTimeoutMillis,
    statementTimeoutMillis: config.statementTimeoutMillis,
    max: config.max
  });
}
function getPool(config) {
  const resolvedConfig = resolvePoolConfig(config);
  const nextSignature = getPoolSignature(resolvedConfig);
  configuredSchema = resolvedConfig.schema;
  if (pool && poolSignature !== nextSignature) {
    if (isLongRunningPoolMode()) {
      console.warn(`[PG] getPool() signature change refused in long-running mode; keeping existing pool. new=${nextSignature} current=${poolSignature}
${new Error().stack}`);
      return pool;
    }
    endPoolBypassingGuard(pool).catch(() => {});
    pool = null;
    poolSignature = null;
  }
  if (!pool) {
    if (process.env.DEBUG_PG) {
      console.error(`[PG] Opening pool ${resolvedConfig.user}@${resolvedConfig.host}:${resolvedConfig.port}/${resolvedConfig.database} schema=${resolvedConfig.schema ?? "(default)"}`);
    }
    pool = new Pool({
      host: resolvedConfig.host,
      port: resolvedConfig.port,
      user: resolvedConfig.user,
      password: resolvedConfig.password,
      database: resolvedConfig.database,
      options: resolvedConfig.options,
      connectionTimeoutMillis: resolvedConfig.connectionTimeoutMillis,
      query_timeout: resolvedConfig.queryTimeoutMillis,
      statement_timeout: resolvedConfig.statementTimeoutMillis,
      max: resolvedConfig.max,
      allowExitOnIdle: true
    });
    installPoolEndGuard(pool);
    poolSignature = nextSignature;
    pool.on("error", (err) => {
      console.error("[PG] Unexpected pool error:", err.message);
    });
  }
  return pool;
}

class PoolManager {
  projectPools = new Map;
  projectConfigs = new Map;
  _metaPool;
  reapTimer = null;
  lastUsed = new Map;
  constructor(metaPool) {
    this._metaPool = metaPool;
  }
  get metaPool() {
    return this._metaPool;
  }
  static async init() {
    const mp = getPool();
    const pm = new PoolManager(mp);
    await pm.loadProjects();
    pm.startIdleReaping();
    return pm;
  }
  async loadProjects() {
    const { rows } = await this._metaPool.query(`SELECT id, name, db_name, git_root, discord_channel_id,
			        db_host, db_port, db_user, is_active
			   FROM roadmap_workforce.projects
			  WHERE is_active = true
			  ORDER BY id`);
    this.projectConfigs.clear();
    for (const row of rows) {
      this.projectConfigs.set(row.id, row);
    }
  }
  getPool(projectId) {
    if (projectId === 1) {
      return this._metaPool;
    }
    this.lastUsed.set(projectId, Date.now());
    if (this.projectPools.has(projectId)) {
      return this.projectPools.get(projectId);
    }
    const config = this.projectConfigs.get(projectId);
    if (!config) {
      throw new Error(`[PoolManager] Unknown project_id=${projectId}. ` + `Known: ${[...this.projectConfigs.keys()].join(", ") || "none"}. ` + `Run loadProjects() first or check roadmap_workforce.projects.`);
    }
    if (this.projectPools.size >= MAX_PROJECT_POOLS) {
      throw new Error(`[PoolManager] Max project pools (${MAX_PROJECT_POOLS}) reached. ` + `Cannot create pool for project_id=${projectId}.`);
    }
    const newPool = new Pool({
      host: config.db_host,
      port: config.db_port,
      database: config.db_name,
      user: config.db_user,
      password: ConfigResolver.resolvePasswordSync({
        host: config.db_host,
        port: String(config.db_port),
        database: config.db_name,
        user: config.db_user
      }),
      max: DEFAULT_PROJECT_MAX,
      idleTimeoutMillis: IDLE_REAP_MS,
      allowExitOnIdle: true
    });
    newPool.on("error", (err) => {
      console.error(`[PoolManager] Pool error for project ${projectId}:`, err.message);
    });
    this.projectPools.set(projectId, newPool);
    if (process.env.DEBUG_PG) {
      console.error(`[PoolManager] Created pool for project ${projectId} ` + `(${config.db_user}@${config.db_host}:${config.db_port}/${config.db_name})`);
    }
    return newPool;
  }
  getProjectConfig(projectId) {
    return this.projectConfigs.get(projectId);
  }
  listProjects() {
    return [...this.projectConfigs.values()];
  }
  async queryProject(projectId, text, params) {
    const p = this.getPool(projectId);
    return p.query(text, params);
  }
  async queryMeta(text, params) {
    return this._metaPool.query(text, params);
  }
  startIdleReaping() {
    this.reapTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, lastSeen] of this.lastUsed) {
        if (now - lastSeen > IDLE_REAP_MS && this.projectPools.has(id)) {
          const p = this.projectPools.get(id);
          p.end().catch(() => {});
          this.projectPools.delete(id);
          this.lastUsed.delete(id);
          if (process.env.DEBUG_PG) {
            console.error(`[PoolManager] Reaped idle pool for project ${id}`);
          }
        }
      }
    }, IDLE_REAP_MS);
  }
  async close() {
    if (this.reapTimer) {
      clearInterval(this.reapTimer);
      this.reapTimer = null;
    }
    for (const [, p] of this.projectPools) {
      await p.end().catch(() => {});
    }
    this.projectPools.clear();
    this.lastUsed.clear();
  }
}
var pool = null, configuredSchema = null, poolSignature = null, poolLifecycleMode = null, allowPoolEndDepth = 0, originalPoolEnd, DEFAULT_SEARCH_PATH, PoolAccessDenied, DEFAULT_PROJECT_MAX = 3, MAX_PROJECT_POOLS = 10, IDLE_REAP_MS;
var init_pool = __esm(() => {
  init_esm();
  init_agent_context();
  init_config();
  init_config_keys();
  init_endpoints();
  originalPoolEnd = Symbol("agenthive.originalPoolEnd");
  DEFAULT_SEARCH_PATH = getDefaultSearchPath();
  PoolAccessDenied = class PoolAccessDenied extends Error {
    constructor(principalId, projectSlug) {
      super(`[P844] Pool access denied: agent ${principalId} has no role for project ${projectSlug}`);
      this.name = "PoolAccessDenied";
    }
  };
  IDLE_REAP_MS = 5 * 60000;
});

// src/shared/vault/types.ts
var VaultError, VaultPermissionError, VaultSymlinkDetectedError, VaultCorruptedError, VaultInvalidRefError, VaultUnavailableError, VaultAuthError;
var init_types = __esm(() => {
  VaultError = class VaultError extends Error {
    ref;
    operation;
    constructor(ref, operation, message) {
      super(message);
      this.ref = ref;
      this.operation = operation;
      this.name = "VaultError";
    }
  };
  VaultPermissionError = class VaultPermissionError extends VaultError {
    actualMode;
    actualUid;
    constructor(ref, operation, actualMode, actualUid, message) {
      super(ref, operation, message);
      this.actualMode = actualMode;
      this.actualUid = actualUid;
      this.name = "VaultPermissionError";
    }
  };
  VaultSymlinkDetectedError = class VaultSymlinkDetectedError extends VaultError {
    path;
    constructor(ref, operation, path) {
      super(ref, operation, `Symlink detected at ${path} (vault ref: ${ref}); symlinks are not allowed`);
      this.path = path;
      this.name = "VaultSymlinkDetectedError";
    }
  };
  VaultCorruptedError = class VaultCorruptedError extends VaultError {
    constructor(ref, operation, message) {
      super(ref, operation, message);
      this.name = "VaultCorruptedError";
    }
  };
  VaultInvalidRefError = class VaultInvalidRefError extends VaultError {
    constructor(ref, operation, message) {
      super(ref, operation, message);
      this.name = "VaultInvalidRefError";
    }
  };
  VaultUnavailableError = class VaultUnavailableError extends VaultError {
    cause;
    constructor(ref, operation, cause, message) {
      super(ref, operation, message);
      this.cause = cause;
      this.name = "VaultUnavailableError";
    }
  };
  VaultAuthError = class VaultAuthError extends VaultError {
    statusCode;
    constructor(ref, operation, statusCode, message) {
      super(ref, operation, message);
      this.statusCode = statusCode;
      this.name = "VaultAuthError";
    }
  };
});

// src/shared/vault/file-vault.ts
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
function fileVault(options) {
  const basePath = options?.basePath || process.env.AGENTHIVE_VAULT_ROOT || "/etc/agenthive/secrets/";
  const adapter = new FileVaultImpl(basePath);
  return adapter;
}

class FileVaultImpl {
  basePath;
  cache = new Map;
  auditLogPath;
  constructor(basePath) {
    this.basePath = basePath.endsWith("/") ? basePath : basePath + "/";
    this.auditLogPath = path.join(this.basePath, ".audit.log");
  }
  async read(ref) {
    this.validateSecretRef(ref, "read");
    const cached = this.cache.get(ref);
    if (cached && Date.now() < cached.expiresAt) {
      await this.auditLog(ref, "read", true);
      return cached.value;
    }
    try {
      const filePath = this.secretRefToPath(ref);
      await this.checkSymlink(filePath, ref, "read");
      const stat = await fs.lstat(filePath);
      await this.checkPermissions(filePath, stat, ref, "read");
      const value = await fs.readFile(filePath, "utf-8");
      if (!value || value.length === 0) {
        throw new VaultCorruptedError(ref, "read", `Empty secret file at ${filePath}; file may be corrupted`);
      }
      const expiresAt = Date.now() + 60000;
      this.cache.set(ref, { value, expiresAt });
      await this.auditLog(ref, "read", true);
      return value;
    } catch (error) {
      if (error instanceof VaultError || error instanceof VaultPermissionError || error instanceof VaultSymlinkDetectedError || error instanceof VaultCorruptedError) {
        await this.auditLog(ref, "read", false, error.message);
        throw error;
      }
      const errno = error?.errno;
      const code = error?.code;
      if (code === "ENOENT") {
        const err2 = new VaultError(ref, "read", `Secret not found: ${ref}`);
        await this.auditLog(ref, "read", false, err2.message);
        throw err2;
      }
      if (code === "EACCES") {
        const err2 = new VaultPermissionError(ref, "read", 0, undefined, `Permission denied reading secret: ${ref}`);
        await this.auditLog(ref, "read", false, err2.message);
        throw err2;
      }
      const err = new VaultError(ref, "read", `Failed to read secret: ${code || errno || error.message}`);
      await this.auditLog(ref, "read", false, err.message);
      throw err;
    }
  }
  async write(ref, value) {
    this.validateSecretRef(ref, "write");
    try {
      const filePath = this.secretRefToPath(ref);
      await this.ensureDirectoryPermissions();
      const tmpPath = `${filePath}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(tmpPath, value, { mode: 384 });
        await fs.chmod(tmpPath, 384);
        await fs.rename(tmpPath, filePath);
        this.cache.delete(ref);
        await this.auditLog(ref, "write", true);
      } catch (tempError) {
        try {
          await fs.unlink(tmpPath);
        } catch {}
        throw tempError;
      }
    } catch (error) {
      if (error instanceof VaultError) {
        await this.auditLog(ref, "write", false, error.message);
        throw error;
      }
      const code = error?.code;
      const msg = error?.message || String(error);
      const err = new VaultError(ref, "write", `Failed to write secret: ${code || msg}`);
      await this.auditLog(ref, "write", false, err.message);
      throw err;
    }
  }
  async rotate(ref, newValue) {
    await this.write(ref, newValue);
    this.cache.delete(ref);
    await this.auditLog(ref, "rotate", true);
  }
  async exists(ref) {
    this.validateSecretRef(ref, "exists");
    try {
      const filePath = this.secretRefToPath(ref);
      await this.checkSymlink(filePath, ref, "exists");
      const stat = await fs.lstat(filePath);
      await this.checkPermissions(filePath, stat, ref, "exists");
      await this.auditLog(ref, "exists", true);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") {
        return false;
      }
      if (error instanceof VaultError) {
        await this.auditLog(ref, "exists", false, error.message);
        throw error;
      }
      const msg = error?.message || String(error);
      const err = new VaultError(ref, "exists", `Failed to check secret existence: ${msg}`);
      await this.auditLog(ref, "exists", false, err.message);
      throw err;
    }
  }
  validateSecretRef(ref, op) {
    if (!ref.startsWith("vault://file/")) {
      throw new VaultInvalidRefError(ref, op, `Invalid secret ref prefix: expected "vault://file/", got "${ref.substring(0, 20)}"`);
    }
    const pathPart = ref.substring("vault://file/".length);
    if (pathPart.includes("..") || pathPart.startsWith(".")) {
      throw new VaultInvalidRefError(ref, op, `Path traversal attempt in secret ref: contains ".." or starts with "."`);
    }
    if (pathPart.startsWith("project/")) {
      const parts = pathPart.split("/");
      if (parts.length < 2) {
        throw new VaultInvalidRefError(ref, op, `Invalid project secret ref format: expected "project/<slug>/...", got "${pathPart}"`);
      }
      const slug = parts[1];
      const slugPattern = /^[a-z][a-z0-9-]*[a-z0-9]$/;
      if (!slugPattern.test(slug)) {
        throw new VaultInvalidRefError(ref, op, `Invalid project slug: "${slug}" does not match pattern [a-z][a-z0-9-]*[a-z0-9]`);
      }
    }
  }
  secretRefToPath(ref) {
    const encoded = encodeURIComponent(ref);
    const filename = `${encoded}.secret`;
    return path.join(this.basePath, filename);
  }
  async checkSymlink(filePath, ref, op) {
    try {
      const stat = await fs.lstat(filePath);
      if (stat.isSymbolicLink()) {
        throw new VaultSymlinkDetectedError(ref, op, filePath);
      }
    } catch (error) {
      if (error?.code === "ENOENT") {
        return;
      }
      if (error instanceof VaultSymlinkDetectedError) {
        throw error;
      }
    }
  }
  async checkPermissions(filePath, stat, ref, op) {
    const isDirectory = stat.isDirectory();
    const expectedMode = isDirectory ? 448 : 384;
    const actualMode = stat.mode & 511;
    const processUid = process.getuid?.();
    if (actualMode !== expectedMode) {
      throw new VaultPermissionError(ref, op, actualMode, stat.uid, `Permission mismatch: ${filePath} has mode ${actualMode.toString(8)}, expected ${expectedMode.toString(8)}`);
    }
    if (processUid !== undefined && stat.uid !== processUid) {
      throw new VaultPermissionError(ref, op, actualMode, stat.uid, `Owner UID mismatch: ${filePath} is owned by ${stat.uid}, process UID is ${processUid}`);
    }
  }
  async ensureDirectoryPermissions() {
    try {
      const stat = await fs.lstat(this.basePath);
      if (!stat.isDirectory()) {
        throw new Error(`${this.basePath} is not a directory`);
      }
      const actualMode = stat.mode & 511;
      if (actualMode !== 448) {
        throw new Error(`${this.basePath} has mode ${actualMode.toString(8)}, expected 0700`);
      }
    } catch (error) {
      if (error?.code === "ENOENT") {
        await fs.mkdir(this.basePath, { mode: 448, recursive: true });
      } else {
        throw error;
      }
    }
  }
  async auditLog(ref, op, success, error) {
    try {
      const entry = {
        ts: new Date().toISOString(),
        op,
        ref,
        caller_pid: process.pid,
        success,
        ...error && { error }
      };
      const line = JSON.stringify(entry) + `
`;
      fsSync.appendFileSync(this.auditLogPath, line);
      try {
        const fd = fsSync.openSync(this.auditLogPath, "a");
        fsSync.fsyncSync(fd);
        fsSync.closeSync(fd);
      } catch {}
    } catch {}
  }
}
var init_file_vault = __esm(() => {
  init_types();
});

// src/shared/vault/hcv-vault.ts
import * as fs2 from "node:fs/promises";
import * as fsSync2 from "node:fs";
function hcvVault(opts) {
  return new HcvVaultImpl(opts);
}

class HcvVaultImpl {
  opts;
  addr;
  mount;
  namespace;
  cacheMaxAge;
  staleThreshold;
  auditLogPath;
  cache = new Map;
  token = null;
  tokenRefreshPromise = null;
  constructor(opts) {
    this.opts = opts;
    this.addr = opts.addr.replace(/\/$/, "");
    this.mount = opts.mount ?? DEFAULT_MOUNT;
    this.namespace = opts.namespace;
    this.cacheMaxAge = opts.cacheMaxAge ?? DEFAULT_CACHE_TTL_MS;
    this.staleThreshold = opts.cacheStaleThreshold ?? DEFAULT_STALE_THRESHOLD_MS;
    this.auditLogPath = opts.auditLogPath ?? null;
  }
  async read(ref) {
    const kvPath = this.extractPath(ref, "read");
    const now = Date.now();
    const cached = this.cache.get(kvPath);
    if (cached && now < cached.expiresAt) {
      this.audit(ref, "read", true);
      return cached.value;
    }
    try {
      await this.ensureToken();
      const value = await this.kvGet(kvPath, ref);
      this.cache.set(kvPath, {
        value,
        cachedAt: now,
        expiresAt: now + this.cacheMaxAge
      });
      this.audit(ref, "read", true);
      return value;
    } catch (err) {
      if (cached && now - cached.cachedAt < this.staleThreshold) {
        this.audit(ref, "read", true, undefined, "stale-cache");
        return cached.value;
      }
      if (err instanceof VaultError) {
        this.audit(ref, "read", false, err.message);
        throw err;
      }
      const wrapped = new VaultUnavailableError(ref, "read", err, `HCV unavailable: ${err.message}`);
      this.audit(ref, "read", false, wrapped.message);
      throw wrapped;
    }
  }
  async write(ref, value) {
    const kvPath = this.extractPath(ref, "write");
    try {
      await this.ensureToken();
      await this.kvPut(kvPath, value, ref);
      this.cache.delete(kvPath);
      this.audit(ref, "write", true);
    } catch (err) {
      if (err instanceof VaultError) {
        this.audit(ref, "write", false, err.message);
        throw err;
      }
      const wrapped = new VaultUnavailableError(ref, "write", err, `HCV unavailable: ${err.message}`);
      this.audit(ref, "write", false, wrapped.message);
      throw wrapped;
    }
  }
  async rotate(ref, newValue) {
    const kvPath = this.extractPath(ref, "rotate");
    try {
      await this.ensureToken();
      await this.kvPut(kvPath, newValue, ref);
      this.cache.delete(kvPath);
      this.audit(ref, "rotate", true);
    } catch (err) {
      if (err instanceof VaultError) {
        this.audit(ref, "rotate", false, err.message);
        throw err;
      }
      const wrapped = new VaultUnavailableError(ref, "rotate", err, `HCV unavailable: ${err.message}`);
      this.audit(ref, "rotate", false, wrapped.message);
      throw wrapped;
    }
  }
  async exists(ref) {
    const kvPath = this.extractPath(ref, "exists");
    const now = Date.now();
    const cached = this.cache.get(kvPath);
    if (cached && now < cached.expiresAt) {
      this.audit(ref, "exists", true);
      return true;
    }
    try {
      await this.ensureToken();
      const result = await this.kvExists(kvPath, ref);
      this.audit(ref, "exists", true);
      return result;
    } catch (err) {
      if (err instanceof VaultError) {
        this.audit(ref, "exists", false, err.message);
        throw err;
      }
      const wrapped = new VaultUnavailableError(ref, "exists", err, `HCV unavailable: ${err.message}`);
      this.audit(ref, "exists", false, wrapped.message);
      throw wrapped;
    }
  }
  async ensureToken() {
    const now = Date.now();
    if (this.token && now < this.token.renewAt)
      return;
    if (!this.tokenRefreshPromise) {
      this.tokenRefreshPromise = this.refreshToken().finally(() => {
        this.tokenRefreshPromise = null;
      });
    }
    await this.tokenRefreshPromise;
  }
  async refreshToken() {
    const roleId = await this.readCredential(this.opts.roleIdFile, this.opts.roleId, "role_id");
    const secretId = await this.readCredential(this.opts.secretIdFile, this.opts.secretId, "secret_id");
    const res = await this.vaultRequest("POST", "/v1/auth/approle/login", {
      role_id: roleId,
      secret_id: secretId
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new VaultAuthError("vault://hcv/", "read", res.status, `AppRole login failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    const leaseSec = json.auth.lease_duration;
    const now = Date.now();
    this.token = {
      token: json.auth.client_token,
      expiresAt: now + leaseSec * 1000,
      renewAt: now + leaseSec * 1000 * TOKEN_RENEW_FRACTION
    };
  }
  async readCredential(filePath, inline, name) {
    if (filePath) {
      const content = await fs2.readFile(filePath, "utf-8");
      return content.trim();
    }
    if (inline)
      return inline;
    throw new Error(`HCV vault: ${name} not configured; set ${name === "role_id" ? "roleIdFile or roleId" : "secretIdFile or secretId"} in HcvVaultOptions`);
  }
  async kvGet(kvPath, ref) {
    const url = `/v1/${this.mount}/data/${kvPath}`;
    const res = await this.vaultRequest("GET", url);
    if (res.status === 404) {
      throw new VaultError(ref, "read", `Secret not found: ${ref}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new VaultError(ref, "read", `KV read failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    const value = json.data?.data?.["value"];
    if (typeof value !== "string") {
      throw new VaultError(ref, "read", `KV secret at ${kvPath} has no "value" key in data map`);
    }
    return value;
  }
  async kvPut(kvPath, value, ref) {
    const url = `/v1/${this.mount}/data/${kvPath}`;
    const res = await this.vaultRequest("POST", url, { data: { value } });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new VaultError(ref, "write", `KV write failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
    }
  }
  async kvExists(kvPath, ref) {
    const url = `/v1/${this.mount}/metadata/${kvPath}`;
    const res = await this.vaultRequest("GET", url);
    if (res.status === 404)
      return false;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new VaultError(ref, "exists", `KV metadata check failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
    }
    return true;
  }
  async vaultRequest(method, urlPath, body) {
    const headers = {
      "Content-Type": "application/json"
    };
    if (this.token) {
      headers["X-Vault-Token"] = this.token.token;
    }
    if (this.namespace) {
      headers["X-Vault-Namespace"] = this.namespace;
    }
    const res = await fetch(`${this.addr}${urlPath}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    return res;
  }
  extractPath(ref, op) {
    if (!ref.startsWith(SCHEME)) {
      throw new VaultInvalidRefError(ref, op, `HCV adapter only handles ${SCHEME}* refs; got: ${ref}`);
    }
    const kvPath = ref.slice(SCHEME.length);
    if (!kvPath || kvPath.includes("..") || kvPath.startsWith(".")) {
      throw new VaultInvalidRefError(ref, op, `Invalid path in HCV ref: ${kvPath}`);
    }
    return kvPath;
  }
  audit(ref, op, success, error, note) {
    const entry = {
      ts: new Date().toISOString(),
      backend: "hcv",
      op,
      ref,
      caller_pid: process.pid,
      success,
      ...error && { error },
      ...note && { note }
    };
    const line = JSON.stringify(entry) + `
`;
    try {
      if (this.auditLogPath) {
        fsSync2.appendFileSync(this.auditLogPath, line);
      } else {
        process.stderr.write(line);
      }
    } catch {}
  }
}
var SCHEME = "vault://hcv/", DEFAULT_MOUNT = "secret", DEFAULT_CACHE_TTL_MS = 60000, DEFAULT_STALE_THRESHOLD_MS = 300000, TOKEN_RENEW_FRACTION = 0.75;
var init_hcv_vault = __esm(() => {
  init_types();
});

// src/shared/vault/aws-vault.ts
function awsVault(opts) {
  return new AwsVaultImpl(opts);
}

class AwsVaultImpl {
  client = null;
  region;
  constructor(opts) {
    this.region = opts.region;
  }
  async getClient() {
    if (this.client)
      return this.client;
    try {
      const { SecretsManagerClient } = await import(AWS_SDK_MODULE);
      this.client = new SecretsManagerClient({ region: this.region });
      return this.client;
    } catch {
      throw new Error(NOT_INSTALLED_MSG);
    }
  }
  async read(ref) {
    const secretName = this.extractName(ref, "read");
    const client = await this.getClient();
    try {
      const { GetSecretValueCommand } = await import(AWS_SDK_MODULE);
      const result = await client.send(new GetSecretValueCommand({ SecretId: secretName }));
      if (typeof result.SecretString !== "string") {
        throw new VaultError(ref, "read", `AWS secret ${secretName} is binary; only string secrets are supported`);
      }
      return result.SecretString;
    } catch (err) {
      if (err instanceof VaultError)
        throw err;
      throw new VaultError(ref, "read", `AWS GetSecretValue failed: ${err.message}`);
    }
  }
  async write(ref, value) {
    const secretName = this.extractName(ref, "write");
    const client = await this.getClient();
    try {
      const { PutSecretValueCommand } = await import(AWS_SDK_MODULE);
      await client.send(new PutSecretValueCommand({
        SecretId: secretName,
        SecretString: value
      }));
    } catch (err) {
      if (err instanceof VaultError)
        throw err;
      throw new VaultError(ref, "write", `AWS PutSecretValue failed: ${err.message}`);
    }
  }
  async rotate(ref, newValue) {
    await this.write(ref, newValue);
  }
  async exists(ref) {
    const secretName = this.extractName(ref, "exists");
    const client = await this.getClient();
    try {
      const { DescribeSecretCommand } = await import(AWS_SDK_MODULE);
      await client.send(new DescribeSecretCommand({ SecretId: secretName }));
      return true;
    } catch (err) {
      const code = err.name;
      if (code === "ResourceNotFoundException")
        return false;
      throw new VaultError(ref, "exists", `AWS DescribeSecret failed: ${err.message}`);
    }
  }
  extractName(ref, op) {
    if (!ref.startsWith("vault://aws/")) {
      throw new VaultError(ref, op, `AWS adapter only handles vault://aws/* refs; got: ${ref}`);
    }
    const name = ref.slice("vault://aws/".length);
    if (!name) {
      throw new VaultError(ref, op, `Empty secret name in AWS ref: ${ref}`);
    }
    return name;
  }
}
var AWS_SDK_MODULE = "@aws-sdk/client-secrets-manager", NOT_INSTALLED_MSG;
var init_aws_vault = __esm(() => {
  init_types();
  NOT_INSTALLED_MSG = `
AWS Secrets Manager vault adapter requires @aws-sdk/client-secrets-manager.
Install it with:

  npm install @aws-sdk/client-secrets-manager

Then set AGENTHIVE_VAULT_KIND=aws and configure AWS credentials via:
  - EC2/ECS/EKS instance role (recommended for production)
  - AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (local dev only)

See docs/architecture/vault-v2.md for per-tenant IAM policy templates.
`.trim();
});

// src/shared/vault/db-provider.ts
async function fetchActiveProvider(pool2, providerType) {
  const rows = providerType ? (await pool2.query(`SELECT id, slug, provider_type, config
					   FROM control_credential.vault_provider
					  WHERE lifecycle_status = 'active' AND provider_type = $1
					  ORDER BY updated_at DESC
					  LIMIT 1`, [providerType])).rows : (await pool2.query(`SELECT id, slug, provider_type, config
					   FROM control_credential.vault_provider
					  WHERE lifecycle_status = 'active'
					  ORDER BY updated_at DESC
					  LIMIT 1`)).rows;
  return rows[0] ?? null;
}

// src/shared/vault/index.ts
function buildRoutingVault(kind) {
  kind = kind || process.env.AGENTHIVE_VAULT_KIND || "file";
  const fileAdapter = fileVault();
  let hcvAdapter = null;
  let awsAdapter = null;
  if (kind === "hcv") {
    const addr = process.env.AGENTHIVE_HCV_ADDR;
    if (!addr) {
      throw new Error("AGENTHIVE_HCV_ADDR is required when AGENTHIVE_VAULT_KIND=hcv");
    }
    hcvAdapter = hcvVault({
      addr,
      roleIdFile: process.env.AGENTHIVE_HCV_ROLE_ID_FILE,
      secretIdFile: process.env.AGENTHIVE_HCV_SECRET_ID_FILE,
      mount: process.env.AGENTHIVE_HCV_MOUNT,
      namespace: process.env.AGENTHIVE_HCV_NAMESPACE,
      auditLogPath: process.env.AGENTHIVE_HCV_AUDIT_LOG
    });
  } else if (kind === "aws") {
    const region = process.env.AGENTHIVE_AWS_REGION;
    if (!region) {
      throw new Error("AGENTHIVE_AWS_REGION is required when AGENTHIVE_VAULT_KIND=aws");
    }
    awsAdapter = awsVault({ region });
  }
  const routingAdapter = {
    read(ref) {
      if (ref.startsWith("vault://file/"))
        return fileAdapter.read(ref);
      if (ref.startsWith("vault://hcv/")) {
        if (!hcvAdapter) {
          throw new VaultInvalidRefError(ref, "read", "HCV vault ref received but AGENTHIVE_VAULT_KIND≠hcv; set AGENTHIVE_VAULT_KIND=hcv");
        }
        return hcvAdapter.read(ref);
      }
      if (ref.startsWith("vault://aws/")) {
        if (!awsAdapter) {
          throw new VaultInvalidRefError(ref, "read", "AWS vault ref received but AGENTHIVE_VAULT_KIND≠aws; set AGENTHIVE_VAULT_KIND=aws");
        }
        return awsAdapter.read(ref);
      }
      throw new VaultInvalidRefError(ref, "read", `Unknown vault scheme in ref: ${ref}`);
    },
    write(ref, value) {
      if (ref.startsWith("vault://file/"))
        return fileAdapter.write(ref, value);
      if (ref.startsWith("vault://hcv/")) {
        if (!hcvAdapter)
          throw new VaultInvalidRefError(ref, "write", "HCV vault ref received but AGENTHIVE_VAULT_KIND≠hcv");
        return hcvAdapter.write(ref, value);
      }
      if (ref.startsWith("vault://aws/")) {
        if (!awsAdapter)
          throw new VaultInvalidRefError(ref, "write", "AWS vault ref received but AGENTHIVE_VAULT_KIND≠aws");
        return awsAdapter.write(ref, value);
      }
      throw new VaultInvalidRefError(ref, "write", `Unknown vault scheme in ref: ${ref}`);
    },
    rotate(ref, newValue) {
      if (ref.startsWith("vault://file/"))
        return fileAdapter.rotate(ref, newValue);
      if (ref.startsWith("vault://hcv/")) {
        if (!hcvAdapter)
          throw new VaultInvalidRefError(ref, "rotate", "HCV vault ref received but AGENTHIVE_VAULT_KIND≠hcv");
        return hcvAdapter.rotate(ref, newValue);
      }
      if (ref.startsWith("vault://aws/")) {
        if (!awsAdapter)
          throw new VaultInvalidRefError(ref, "rotate", "AWS vault ref received but AGENTHIVE_VAULT_KIND≠aws");
        return awsAdapter.rotate(ref, newValue);
      }
      throw new VaultInvalidRefError(ref, "rotate", `Unknown vault scheme in ref: ${ref}`);
    },
    exists(ref) {
      if (ref.startsWith("vault://file/"))
        return fileAdapter.exists(ref);
      if (ref.startsWith("vault://hcv/")) {
        if (!hcvAdapter)
          throw new VaultInvalidRefError(ref, "exists", "HCV vault ref received but AGENTHIVE_VAULT_KIND≠hcv");
        return hcvAdapter.exists(ref);
      }
      if (ref.startsWith("vault://aws/")) {
        if (!awsAdapter)
          throw new VaultInvalidRefError(ref, "exists", "AWS vault ref received but AGENTHIVE_VAULT_KIND≠aws");
        return awsAdapter.exists(ref);
      }
      throw new VaultInvalidRefError(ref, "exists", `Unknown vault scheme in ref: ${ref}`);
    }
  };
  return routingAdapter;
}
function mapProviderTypeToKind(providerType) {
  switch (providerType) {
    case "file":
      return "file";
    case "hcp_vault":
      return "hcv";
    case "aws_secrets":
      return "aws";
    case "env":
      return "env";
  }
}
function initVaultFromDb(getControlPool) {
  if (initPromise)
    return initPromise;
  initPromise = (async () => {
    const envKind = process.env.AGENTHIVE_VAULT_KIND;
    if (envKind && envKind.trim() !== "") {
      console.error(`[vault] Adapter initialized from env: AGENTHIVE_VAULT_KIND=${envKind}`);
      vaultInstance = buildRoutingVault(envKind);
      return vaultInstance;
    }
    try {
      const getPool2 = getControlPool ?? (await Promise.resolve().then(() => (init_pool_registry(), exports_pool_registry))).getControlPool;
      const pool2 = getPool2();
      const provider = await fetchActiveProvider(pool2);
      if (!provider) {
        console.error("[vault] No active vault_provider row; env fallback active");
        return vaultInstance;
      }
      const kind = mapProviderTypeToKind(provider.provider_type);
      vaultInstance = buildRoutingVault(kind === "env" ? "file" : kind);
      console.error(`[vault] Adapter initialized from DB: provider_type=${provider.provider_type} (slug=${provider.slug})`);
      return vaultInstance;
    } catch (err) {
      console.error(`[vault] DB init failed (env fallback active): ${err.message}`);
      return vaultInstance;
    }
  })();
  return initPromise;
}
function getVault() {
  return initPromise ?? initVaultFromDb();
}
var vaultInstance, initPromise = null;
var init_vault = __esm(() => {
  init_file_vault();
  init_hcv_vault();
  init_aws_vault();
  init_types();
  init_types();
  init_file_vault();
  init_hcv_vault();
  init_aws_vault();
  vaultInstance = buildRoutingVault();
});

// src/postgres/pool-registry.ts
var exports_pool_registry = {};
__export(exports_pool_registry, {
  verifyAgentHive2Connection: () => verifyAgentHive2Connection,
  shutdown: () => shutdown,
  setVault: () => setVault,
  resetForTesting: () => resetForTesting,
  poolStats: () => poolStats,
  pingProject: () => pingProject,
  getVault: () => getVault2,
  getProjectDb: () => getProjectDb,
  getControlPool: () => getControlPool,
  evictProject: () => evictProject,
  createBridgeAdapter: () => createBridgeAdapter,
  TenantSecretUnavailable: () => TenantSecretUnavailable,
  TenantDbUnreachable: () => TenantDbUnreachable,
  RegistryUnavailable: () => RegistryUnavailable,
  ProjectNotRegistered: () => ProjectNotRegistered,
  PoolExhausted: () => PoolExhausted,
  DsnFormatInvalid: () => DsnFormatInvalid
});
function makeCounters() {
  return {
    hits: 0,
    misses: 0,
    evictions: 0,
    create_failures: 0,
    create_retries: 0,
    drain_timeouts: 0
  };
}
function setVault(v) {
  _vault = v;
}
function createBridgeAdapter(sharedVault) {
  return {
    async read(ref) {
      if (ref.startsWith("vault://")) {
        const resolved = typeof sharedVault === "function" ? await sharedVault() : sharedVault;
        return resolved.read(ref);
      }
      return envVault.read(ref);
    }
  };
}
function getVault2() {
  if (!_vault) {
    _vault = createBridgeAdapter(getVault);
  }
  return _vault;
}
function getOrMakeCounters(name) {
  let c = _globalCounters.get(name);
  if (!c) {
    c = makeCounters();
    _globalCounters.set(name, c);
  }
  return c;
}
async function drainPool(entry, reason) {
  if (entry.draining)
    return;
  entry.draining = true;
  entry.counters.evictions++;
  let timedOut = false;
  const drainTimeout = new Promise((resolve) => {
    const t = setTimeout(() => {
      timedOut = true;
      resolve();
    }, DEFAULT_DRAIN_TIMEOUT_MS);
    if (typeof t.unref === "function")
      t.unref();
  });
  await Promise.race([
    entry.pool.end().catch((err) => {
      if (!timedOut) {
        console.error(`[pool-registry] Drain error for "${entry.name}" (${reason}):`, err.message);
      }
    }),
    drainTimeout
  ]);
  if (timedOut) {
    entry.counters.drain_timeouts++;
    console.warn(`[pool-registry] Drain timeout for pool "${entry.name}" (${reason}); force-closing.`);
  }
}
function readControlDsnSignature() {
  if (process.env.AGENTHIVE_CONTROL_DSN)
    return process.env.AGENTHIVE_CONTROL_DSN;
  const host = process.env.PGHOST ?? "127.0.0.1";
  const port = process.env.PGPORT ?? process.env.CONTROL_DB_PORT ?? "6432";
  const user = process.env.PGUSER ?? "xiaomi";
  const database = process.env.PGDATABASE ?? "agenthive";
  return `${user}@${host}:${port}/${database}`;
}
function buildControlPool() {
  const password = process.env.PGPASSWORD;
  if (!password) {
    throw new Error("[pool-registry] PGPASSWORD is required for getControlPool(). " + "Set PGPASSWORD before starting.");
  }
  const searchPathOptions = `-c search_path=${CONTROL_SEARCH_PATH}`;
  if (process.env.AGENTHIVE_CONTROL_DSN) {
    return new Pool({
      connectionString: process.env.AGENTHIVE_CONTROL_DSN,
      options: searchPathOptions,
      max: DEFAULT_POOL_MAX_CONTROL,
      idleTimeoutMillis: DEFAULT_IDLE_MS,
      connectionTimeoutMillis: DEFAULT_CONN_TIMEOUT_MS,
      statement_timeout: DEFAULT_STMT_TIMEOUT_MS,
      allowExitOnIdle: true
    });
  }
  return new Pool({
    host: process.env.PGHOST ?? "127.0.0.1",
    port: Number(process.env.PGPORT ?? process.env.CONTROL_DB_PORT ?? 6432),
    user: process.env.PGUSER ?? "xiaomi",
    database: process.env.PGDATABASE ?? "agenthive",
    password,
    options: searchPathOptions,
    max: DEFAULT_POOL_MAX_CONTROL,
    idleTimeoutMillis: DEFAULT_IDLE_MS,
    connectionTimeoutMillis: DEFAULT_CONN_TIMEOUT_MS,
    statement_timeout: DEFAULT_STMT_TIMEOUT_MS,
    allowExitOnIdle: true
  });
}
function getControlPool() {
  const sig = readControlDsnSignature();
  if (_controlEntry && _controlDsnSig !== sig) {
    const old = _controlEntry;
    _controlEntry = null;
    _controlDsnSig = null;
    drainPool(old, "shutdown").catch(() => {});
  }
  if (!_controlEntry) {
    const pool2 = buildControlPool();
    pool2.on("error", (err) => {
      console.error("[pool-registry] Control pool error:", err.message);
    });
    _controlEntry = {
      pool: pool2,
      counters: getOrMakeCounters("control"),
      name: "control",
      source: "control",
      lastUsedAt: Date.now(),
      draining: false
    };
    _controlDsnSig = sig;
  }
  _controlEntry.counters.hits++;
  _controlEntry.lastUsedAt = Date.now();
  return _controlEntry.pool;
}
function getLruMax() {
  const val = process.env.AGENTHIVE_TENANT_POOL_LRU_MAX;
  if (val) {
    const n = Number(val);
    if (Number.isFinite(n) && n > 0)
      return Math.trunc(n);
  }
  return DEFAULT_LRU_MAX;
}
function startIdleEvictionTimer() {
  if (_idleEvictionTimer)
    return;
  const halfIdle = Math.floor(DEFAULT_IDLE_MS / 2);
  _idleEvictionTimer = setInterval(async () => {
    const now = Date.now();
    for (const [key, entry] of _tenantPools) {
      if (!entry.draining && entry.pool.idleCount === entry.pool.totalCount && now - entry.lastUsedAt > DEFAULT_IDLE_MS) {
        _tenantPools.delete(key);
        drainPool(entry, "idle").catch(() => {});
      }
    }
  }, halfIdle);
  if (typeof _idleEvictionTimer.unref === "function") {
    _idleEvictionTimer.unref();
  }
}
async function ensureListenConnection() {
  if (_listenClient)
    return;
  const host = process.env.PGHOST ?? "127.0.0.1";
  const port = Number(process.env.PGPORT_DIRECT ?? process.env.PGPORT ?? 5432);
  const client = new Client({
    host,
    port,
    user: process.env.PGUSER ?? "xiaomi",
    database: process.env.PGDATABASE ?? "agenthive",
    password: process.env.PGPASSWORD,
    keepAlive: true
  });
  try {
    await client.connect();
    await client.query("LISTEN pool_evict");
    client.on("notification", (msg) => {
      if (msg.channel !== "pool_evict" || !msg.payload)
        return;
      try {
        const data = JSON.parse(msg.payload);
        const key = data.slug ?? (data.project_id !== undefined ? String(data.project_id) : null);
        if (key) {
          evictProject(key).catch((err) => {
            console.error(`[pool-registry] Auto-evict error for "${key}":`, err.message);
          });
        }
      } catch {}
    });
    client.on("error", (err) => {
      console.error("[pool-registry] LISTEN client error:", err.message);
      _listenClient = null;
      const t = setTimeout(() => void ensureListenConnection().catch(() => {}), 5000);
      if (typeof t.unref === "function")
        t.unref();
    });
    client.on("end", () => {
      _listenClient = null;
    });
    _listenClient = client;
  } catch (err) {
    console.error("[pool-registry] Failed to establish LISTEN connection:", err.message);
    client.end().catch(() => {});
  }
}
function isFatalError(err) {
  return err instanceof ProjectNotRegistered || err instanceof DsnFormatInvalid;
}
function isTransientVaultError(err) {
  const cause = err.cause;
  return cause?.code === "ECONNREFUSED" || cause?.code === "ETIMEDOUT";
}
function isTransient(err) {
  if (isFatalError(err))
    return false;
  if (err instanceof TenantSecretUnavailable)
    return isTransientVaultError(err);
  if (err instanceof TenantDbUnreachable)
    return true;
  if (err instanceof RegistryUnavailable)
    return true;
  return false;
}
async function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === "function")
      t.unref();
  });
}
async function createTenantPoolOnce(canonical) {
  let row;
  try {
    const ctrl = getControlPool();
    const result = await ctrl.query(`SELECT slug,
              project_id,
              dsn_secret_ref,
              pool_max,
              idle_ms,
              stmt_timeout_ms
         FROM roadmap.project
        WHERE slug = $1
           OR project_id::text = $1
        LIMIT 1`, [canonical]);
    if (!result.rows[0])
      throw new ProjectNotRegistered(canonical);
    row = result.rows[0];
  } catch (err) {
    if (err instanceof ProjectNotRegistered)
      throw err;
    throw new RegistryUnavailable(err);
  }
  let dsn;
  try {
    dsn = await getVault2().read(row.dsn_secret_ref);
  } catch (err) {
    if (err instanceof TenantSecretUnavailable)
      throw err;
    throw new TenantSecretUnavailable(row.dsn_secret_ref, err);
  }
  let dsnHost;
  try {
    const parsed = new URL(dsn);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
      throw new Error("not a postgres URL");
    }
    dsnHost = parsed.hostname;
  } catch {
    throw new DsnFormatInvalid(row.dsn_secret_ref);
  }
  const poolMax = row.pool_max ?? DEFAULT_POOL_MAX_TENANT;
  const idleMs = row.idle_ms ?? DEFAULT_IDLE_MS;
  const stmtTimeout = row.stmt_timeout_ms ?? DEFAULT_STMT_TIMEOUT_MS;
  const pool2 = new Pool({
    connectionString: dsn,
    max: poolMax,
    idleTimeoutMillis: idleMs,
    connectionTimeoutMillis: DEFAULT_CONN_TIMEOUT_MS,
    statement_timeout: stmtTimeout,
    allowExitOnIdle: true
  });
  try {
    const client = await pool2.connect();
    client.release();
  } catch (err) {
    pool2.end().catch(() => {});
    throw new TenantDbUnreachable(canonical, dsnHost, err);
  }
  pool2.on("error", (err) => {
    console.error(`[pool-registry] Tenant pool error for "${canonical}":`, err.message);
  });
  return pool2;
}
async function createTenantPool(canonical) {
  const counters = getOrMakeCounters(canonical);
  counters.misses++;
  let totalBackoffMs = 0;
  let lastErr;
  for (let i = 0;i <= RETRY_BACKOFF_SEQUENCE_MS.length; i++) {
    try {
      const pool2 = await createTenantPoolOnce(canonical);
      const lruMax = getLruMax();
      if (_tenantPools.size >= lruMax) {
        const [oldestKey, oldestEntry] = _tenantPools.entries().next().value;
        _tenantPools.delete(oldestKey);
        drainPool(oldestEntry, "lru").catch(() => {});
      }
      const entry = {
        pool: pool2,
        counters,
        name: canonical,
        source: "project",
        lastUsedAt: Date.now(),
        draining: false
      };
      _tenantPools.set(canonical, entry);
      startIdleEvictionTimer();
      ensureListenConnection().catch(() => {});
      return pool2;
    } catch (err) {
      lastErr = err;
      if (isFatalError(err))
        throw err;
      const backoffMs = RETRY_BACKOFF_SEQUENCE_MS[i];
      if (backoffMs === undefined || totalBackoffMs + backoffMs > 30000)
        break;
      if (isTransient(err)) {
        counters.create_retries++;
        await sleep(backoffMs);
        totalBackoffMs += backoffMs;
      } else {
        break;
      }
    }
  }
  counters.create_failures++;
  throw lastErr;
}
async function checkAgentProjectRole(principalId, projectSlug) {
  try {
    const ctrlPool = await getControlPool();
    const result = await ctrlPool.query(`SELECT EXISTS(
         SELECT 1 FROM control_identity.agent_project_roles
         WHERE agent_principal_did = $1 AND project_slug = $2
       ) AS exists`, [principalId, projectSlug]);
    return result.rows[0]?.exists ?? false;
  } catch (err) {
    console.error(`[P844] checkAgentProjectRole failed:`, err);
    return false;
  }
}
async function writePoolAudit(principalId, projectSlug, result, callSite) {
  try {
    const ctrlPool = await getControlPool();
    await ctrlPool.query(`INSERT INTO control_identity.pool_access_audit
         (principal_id, project_slug, result, call_site)
       VALUES ($1, $2, $3, $4)`, [principalId, projectSlug, result, callSite]);
  } catch {}
}
async function getProjectDb(slugOrId) {
  const canonical = String(slugOrId);
  if (canonical === "hiveControl") {
    throw new ProjectNotRegistered("hiveControl");
  }
  const ctx = agentContextStorage.getStore();
  if (ctx?.verified?.principal_kind === "agent") {
    const allowed = await checkAgentProjectRole(ctx.verified.principal_id, canonical);
    await writePoolAudit(ctx.verified.principal_id, canonical, allowed ? "allowed" : "denied", "getProjectDb");
    if (!allowed) {
      throw new PoolAccessDenied(ctx.verified.principal_id, canonical);
    }
  } else if (ctx?.verified) {
    await writePoolAudit(ctx.verified.principal_id, canonical, "bootstrap_passthrough", "getProjectDb");
  }
  const existing = _tenantPools.get(canonical);
  if (existing && !existing.draining) {
    _tenantPools.delete(canonical);
    _tenantPools.set(canonical, existing);
    existing.counters.hits++;
    existing.lastUsedAt = Date.now();
    return existing.pool;
  }
  const inflight = _inflightCreates.get(canonical);
  if (inflight)
    return inflight;
  const createPromise = createTenantPool(canonical).then((pool2) => {
    _inflightCreates.delete(canonical);
    return pool2;
  }).catch((err) => {
    _inflightCreates.delete(canonical);
    throw err;
  });
  _inflightCreates.set(canonical, createPromise);
  return createPromise;
}
async function evictProject(slugOrId) {
  const canonical = String(slugOrId);
  _inflightCreates.delete(canonical);
  const entry = _tenantPools.get(canonical);
  if (!entry)
    return;
  _tenantPools.delete(canonical);
  await drainPool(entry, "stale");
}
function poolStats() {
  const pools = [];
  if (_controlEntry) {
    pools.push({
      name: "control",
      source: "control",
      hits: _controlEntry.counters.hits,
      misses: _controlEntry.counters.misses,
      evictions: _controlEntry.counters.evictions,
      create_failures: _controlEntry.counters.create_failures,
      create_retries: _controlEntry.counters.create_retries,
      active_connections: _controlEntry.pool.totalCount - _controlEntry.pool.idleCount,
      idle_connections: _controlEntry.pool.idleCount,
      drain_timeouts: _controlEntry.counters.drain_timeouts
    });
  }
  for (const [name, entry] of _tenantPools) {
    pools.push({
      name,
      source: "project",
      hits: entry.counters.hits,
      misses: entry.counters.misses,
      evictions: entry.counters.evictions,
      create_failures: entry.counters.create_failures,
      create_retries: entry.counters.create_retries,
      active_connections: entry.pool.totalCount - entry.pool.idleCount,
      idle_connections: entry.pool.idleCount,
      drain_timeouts: entry.counters.drain_timeouts
    });
  }
  return {
    timestamp: new Date().toISOString(),
    pools,
    total_active_pools: (_controlEntry ? 1 : 0) + _tenantPools.size
  };
}
async function pingProject(slug) {
  try {
    const pool2 = await getProjectDb(slug);
    await pool2.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
async function shutdown() {
  if (_idleEvictionTimer) {
    clearInterval(_idleEvictionTimer);
    _idleEvictionTimer = null;
  }
  const tenantDrains = [];
  for (const [key, entry] of _tenantPools) {
    _tenantPools.delete(key);
    tenantDrains.push(drainPool(entry, "shutdown").catch(() => {}));
  }
  await Promise.all(tenantDrains);
  if (_listenClient) {
    try {
      await _listenClient.query("UNLISTEN pool_evict");
      await _listenClient.end();
    } catch {}
    _listenClient = null;
  }
  if (_controlEntry) {
    const ctrl = _controlEntry;
    _controlEntry = null;
    _controlDsnSig = null;
    await drainPool(ctrl, "shutdown").catch(() => {});
  }
  console.info("[pool-registry] shutdown complete. final stats:", JSON.stringify(poolStats()));
  _globalCounters.clear();
}
async function resetForTesting(opts) {
  await shutdown().catch(() => {});
  _globalCounters.clear();
  _inflightCreates.clear();
  _vault = opts?.vault ?? envVault;
}
async function verifyAgentHive2Connection(projectSchema) {
  const dsn = process.env.AGENTHIVE_V2_DB_URL;
  if (!dsn)
    return;
  const client = new Client({ connectionString: dsn });
  try {
    await client.connect();
    if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(projectSchema)) {
      throw new Error(`Invalid schema name: ${projectSchema}`);
    }
    await client.query(`SET search_path = "${projectSchema}", public`);
    await client.query("SELECT 1");
    console.info(`[pool-registry] agentHive2 connectivity verified (schema=${projectSchema})`);
  } catch (err) {
    console.warn(`[pool-registry] agentHive2 connectivity check failed (schema=${projectSchema}):`, err.message);
  } finally {
    await client.end().catch(() => {});
  }
}
var DEFAULT_LRU_MAX = 16, CONTROL_SEARCH_PATH = "roadmap_proposal,roadmap_workforce,roadmap_efficiency,roadmap,public", DEFAULT_POOL_MAX_CONTROL = 10, DEFAULT_POOL_MAX_TENANT = 8, DEFAULT_IDLE_MS, DEFAULT_DRAIN_TIMEOUT_MS = 30000, DEFAULT_STMT_TIMEOUT_MS = 30000, DEFAULT_CONN_TIMEOUT_MS = 5000, RETRY_BACKOFF_SEQUENCE_MS, ProjectNotRegistered, RegistryUnavailable, TenantSecretUnavailable, TenantDbUnreachable, DsnFormatInvalid, PoolExhausted, envVault, _vault = null, _globalCounters, _controlEntry = null, _controlDsnSig = null, _tenantPools, _inflightCreates, _idleEvictionTimer = null, _listenClient = null;
var init_pool_registry = __esm(() => {
  init_esm();
  init_pool();
  init_agent_context();
  init_vault();
  DEFAULT_IDLE_MS = 5 * 60000;
  RETRY_BACKOFF_SEQUENCE_MS = [500, 1000, 2000, 4000, 8000, 15000];
  ProjectNotRegistered = class ProjectNotRegistered extends Error {
    slugOrId;
    constructor(slugOrId) {
      super(String(slugOrId) === "hiveControl" ? "hiveControl is the control plane; use getControlPool() not getProjectDb()" : `Project not found in registry: ${slugOrId}`);
      this.slugOrId = slugOrId;
      this.name = "ProjectNotRegistered";
      Object.setPrototypeOf(this, ProjectNotRegistered.prototype);
    }
  };
  RegistryUnavailable = class RegistryUnavailable extends Error {
    cause;
    constructor(cause) {
      super(`hiveControl registry is unavailable: ${cause.message}`);
      this.cause = cause;
      this.name = "RegistryUnavailable";
      Object.setPrototypeOf(this, RegistryUnavailable.prototype);
    }
  };
  TenantSecretUnavailable = class TenantSecretUnavailable extends Error {
    ref;
    cause;
    constructor(ref, cause) {
      super(`Vault secret unavailable for ref "${ref}": ${cause.message}`);
      this.ref = ref;
      this.cause = cause;
      this.name = "TenantSecretUnavailable";
      Object.setPrototypeOf(this, TenantSecretUnavailable.prototype);
    }
  };
  TenantDbUnreachable = class TenantDbUnreachable extends Error {
    slug;
    dsnHost;
    cause;
    constructor(slug, dsnHost, cause) {
      super(`Tenant DB unreachable for "${slug}" at ${dsnHost}: ${cause.message}`);
      this.slug = slug;
      this.dsnHost = dsnHost;
      this.cause = cause;
      this.name = "TenantDbUnreachable";
      Object.setPrototypeOf(this, TenantDbUnreachable.prototype);
    }
  };
  DsnFormatInvalid = class DsnFormatInvalid extends Error {
    ref;
    constructor(ref) {
      super(`Vault ref "${ref}" returned a value that is not a valid postgres DSN`);
      this.ref = ref;
      this.name = "DsnFormatInvalid";
      Object.setPrototypeOf(this, DsnFormatInvalid.prototype);
    }
  };
  PoolExhausted = class PoolExhausted extends Error {
    poolName;
    max;
    constructor(poolName, max) {
      super(`Pool "${poolName}" is exhausted (max=${max})`);
      this.poolName = poolName;
      this.max = max;
      this.name = "PoolExhausted";
      Object.setPrototypeOf(this, PoolExhausted.prototype);
    }
  };
  envVault = {
    async read(ref) {
      const val = process.env[ref];
      if (!val) {
        throw new TenantSecretUnavailable(ref, new Error(`environment variable "${ref}" is not set`));
      }
      return val;
    }
  };
  _globalCounters = new Map;
  _tenantPools = new Map;
  _inflightCreates = new Map;
});

// src/shared/runtime/config.ts
var exports_config = {};
__export(exports_config, {
  set: () => set,
  reload: () => reload,
  loadRuntimeEnvFile: () => loadRuntimeEnvFile,
  initConfigFromControlPool: () => initConfigFromControlPool,
  initConfig: () => initConfig,
  getProjectDb: () => getProjectDb2,
  getOptional: () => getOptional,
  getAuditSnapshot: () => getAuditSnapshot,
  getAudit: () => getAudit,
  get: () => get,
  clearCache: () => clearCache,
  cleanup: () => cleanup,
  RuntimeConfigMutationForbidden: () => RuntimeConfigMutationForbidden,
  RuntimeConfigMissing: () => RuntimeConfigMissing,
  RuntimeConfigInvalidSource: () => RuntimeConfigInvalidSource,
  ProjectIdMissing: () => ProjectIdMissing,
  DEFAULT_ENV_FILE_PATH: () => DEFAULT_ENV_FILE_PATH,
  ConfigResolver: () => ConfigResolver
});
async function loadRuntimeEnvFile(filePath = DEFAULT_ENV_FILE_PATH) {
  try {
    const { readFileSync } = await import("node:fs");
    const content = readFileSync(filePath, "utf-8");
    for (const line of content.split(`
`)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#"))
        continue;
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
      if (!match)
        continue;
      const [, key, value] = match;
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {}
}

class ConfigResolver {
  cache = new Map;
  auditMap = new Map;
  tenantDsnAuditMap = new Map;
  yamlConfig = null;
  pool = null;
  dbCache = new Map;
  notifySubscription = null;
  scopeContext = {};
  directListenPool = null;
  static parsePgpassFile(pgpassPath, host, port, database, user) {
    try {
      const { readFileSync } = __require("node:fs");
      const content = readFileSync(pgpassPath, "utf-8");
      for (const line of content.split(`
`)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#"))
          continue;
        const parts = trimmed.replace(/\\:/g, "").split(":").map((p2) => p2.replace(/\uF000/g, ":"));
        if (parts.length < 5)
          continue;
        const [h, p, d2, u, ...rest] = parts;
        const pw = rest.join(":");
        const m = (pat, val) => pat === "*" || pat === val;
        if (m(h, host) && m(p, port) && m(d2, database) && m(u, user)) {
          return pw;
        }
      }
    } catch {}
    return;
  }
  static resolvePasswordSync(opts) {
    if (process.env.PGPASSWORD)
      return process.env.PGPASSWORD;
    const pgpassPath = opts.pgpassPath ?? (process.env.PGPASSFILE || `${process.env.HOME || ""}/.pgpass`);
    return ConfigResolver.parsePgpassFile(pgpassPath, opts.host, opts.port, opts.database, opts.user);
  }
  async init(opts) {
    this.yamlConfig = opts.yamlConfig || null;
    this.pool = opts.pool || null;
    this.scopeContext = opts.scopeContext || {};
    if (opts.envFilePath) {
      await loadRuntimeEnvFile(opts.envFilePath);
    }
    if (this.pool) {
      await this.setupNotifyListener();
    }
  }
  static buildDirectListenPoolConfig(poolOptions, directPort) {
    const opts = poolOptions ?? {};
    const connStr = typeof opts.connectionString === "string" ? opts.connectionString : undefined;
    if (connStr) {
      const {
        connectionString: _drop,
        port: _dropPort,
        host: _dropHost,
        user: _dropUser,
        password: _dropPw,
        database: _dropDb,
        ...rest
      } = opts;
      try {
        const u = new URL(connStr);
        const cfg = {
          ...rest,
          host: decodeURIComponent(u.hostname),
          port: directPort,
          max: 1
        };
        if (u.username)
          cfg.user = decodeURIComponent(u.username);
        if (u.password)
          cfg.password = decodeURIComponent(u.password);
        const db = u.pathname.replace(/^\//, "");
        if (db)
          cfg.database = decodeURIComponent(db);
        return cfg;
      } catch {
        return { ...rest, port: directPort, max: 1 };
      }
    }
    return { ...opts, port: directPort, max: 1 };
  }
  async setupNotifyListener() {
    try {
      let client;
      const directPortEnv = process.env.PGPORT_DIRECT;
      if (directPortEnv) {
        const directPort = Number(directPortEnv);
        if (Number.isFinite(directPort) && directPort > 0 && directPort <= 65535) {
          const { Pool: Pool2 } = await Promise.resolve().then(() => (init_esm(), exports_esm));
          const poolOptions = this.pool.options ?? {};
          this.directListenPool = new Pool2(ConfigResolver.buildDirectListenPoolConfig(poolOptions, directPort));
          client = await this.directListenPool.connect();
        } else {
          client = await this.pool.connect();
        }
      } else {
        client = await this.pool.connect();
      }
      await client.query("LISTEN runtime_flag_changed");
      client.on("notification", (msg) => {
        this.handleFlagNotification(msg.payload);
      });
      client.on("error", () => {
        this.notifySubscription = null;
      });
      this.notifySubscription = client;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[ConfigResolver] LISTEN unavailable: hot-reload disabled. ${msg}`);
    }
  }
  handleFlagNotification(payload) {
    if (!payload) {
      this.dbCache.clear();
      return;
    }
    try {
      const parsed = JSON.parse(payload);
      if (typeof parsed.flag_name === "string" && typeof parsed.scope === "string") {
        const dbCacheKey = `runtime_flag:${parsed.flag_name}:${parsed.scope}`;
        this.dbCache.delete(dbCacheKey);
        this.cache.delete(parsed.flag_name);
      } else {
        this.dbCache.clear();
      }
    } catch {
      this.dbCache.clear();
    }
  }
  async getScopedFlagValue(flagName) {
    if (!this.pool)
      return;
    const candidates = [];
    if (this.scopeContext.projectSlug) {
      candidates.push(`project:${this.scopeContext.projectSlug}`);
    }
    if (this.scopeContext.hostId) {
      candidates.push(`host:${this.scopeContext.hostId}`);
    }
    if (this.scopeContext.agencyId) {
      candidates.push(`agency:${this.scopeContext.agencyId}`);
    }
    candidates.push("global");
    for (const scope of candidates) {
      const cacheKey = `runtime_flag:${flagName}:${scope}`;
      const cached = this.dbCache.get(cacheKey);
      if (cached !== undefined && typeof cached === "object" && cached !== null && "resolvedAt" in cached) {
        const entry = cached;
        if (Date.now() - entry.resolvedAt < FLAG_CACHE_TTL_MS) {
          return entry.value;
        }
        this.dbCache.delete(cacheKey);
      }
      try {
        const result = await this.pool.query(`SELECT value_jsonb FROM ${RUNTIME_FLAG_TABLE}
					  WHERE flag_name = $1 AND scope = $2 AND lifecycle_status = 'active'
					  LIMIT 1`, [flagName, scope]);
        if (result.rows.length > 0) {
          const value = result.rows[0].value_jsonb;
          const entry = { value, resolvedAt: Date.now() };
          this.dbCache.set(cacheKey, entry);
          return value;
        }
      } catch {}
    }
    return;
  }
  async resolve(key) {
    if (key.class === "tenant_dsn") {
      throw new RuntimeConfigInvalidSource(key.name, "get()", ["getProjectDb(slug)"], `[RuntimeConfig] tenant_dsn keys cannot be read via get(). Use config.getProjectDb(slug) instead. For per-tenant databases, pool binding is required.`);
    }
    const cachedValue = this.cache.get(key.name);
    if (cachedValue !== undefined) {
      const audit2 = this.auditMap.get(key.name);
      if (audit2) {
        audit2.lastAccessedAt = new Date;
        audit2.accessCount++;
      }
      return cachedValue;
    }
    let value;
    let source = "default";
    const envValue = process.env[key.name];
    if (envValue !== undefined) {
      try {
        value = key.parse(envValue);
        source = "env";
      } catch (err) {
        throw new RuntimeConfigMissing(key.name, key.class, `Invalid env value: ${envValue}
${err.message}`);
      }
    }
    if (value === undefined && key.class === "structural") {
      if (key.assembleFromYaml && this.yamlConfig) {
        const assembled = key.assembleFromYaml(this.yamlConfig);
        if (assembled !== undefined) {
          value = assembled;
          source = "yaml";
        }
      } else if (key.yamlPath) {
        const yamlValue = this.getYamlValue(key.yamlPath);
        if (yamlValue !== undefined) {
          try {
            value = key.parse(String(yamlValue));
            source = "yaml";
          } catch (err) {
            throw new RuntimeConfigMissing(key.name, key.class, `Invalid yaml value at ${key.yamlPath}: ${yamlValue}
${err.message}`);
          }
        }
      }
    }
    if (value === undefined && (key.class === "registry" || key.class === "flag") && key.dbTable === RUNTIME_FLAG_TABLE && key.name.startsWith("PROJECT_") && !this.scopeContext.projectSlug) {
      throw new ProjectIdMissing(key.name);
    }
    if (value === undefined && key.class === "registry" && key.dbTable && this.pool) {
      const registryDbValue = await this.getDbValue(key.dbTable, key.dbColumn || key.name, key.name);
      if (registryDbValue !== undefined) {
        try {
          const raw = typeof registryDbValue === "string" ? registryDbValue : JSON.stringify(registryDbValue);
          value = key.parse(raw);
          source = "db";
        } catch (err) {
          throw new RuntimeConfigMissing(key.name, key.class, `Invalid DB value from ${key.dbTable}: ${registryDbValue}
${err.message}`);
        }
      }
    }
    if (value === undefined && key.class === "flag" && key.dbTable && this.pool) {
      const flagDbValue = await this.getDbValue(key.dbTable, key.dbColumn || key.name, key.name);
      if (flagDbValue !== undefined) {
        try {
          const raw = typeof flagDbValue === "string" ? flagDbValue : JSON.stringify(flagDbValue);
          value = key.parse(raw);
          source = "db";
        } catch (err) {
          throw new RuntimeConfigMissing(key.name, key.class, `Invalid flag value from ${key.dbTable}: ${flagDbValue}
${err.message}`);
        }
      }
    }
    if (value === undefined && key.defaultValue !== undefined) {
      value = key.defaultValue;
      source = "default";
    }
    if (value === undefined && key.required) {
      throw new RuntimeConfigMissing(key.name, key.class, `No value found in env, yaml, or DB. Required keys must be explicitly set.`);
    }
    if (key.class === "secret" && (source === "yaml" || source === "db")) {
      throw new RuntimeConfigInvalidSource(key.name, source === "yaml" ? "roadmap.yaml" : "database", ["env", "default"]);
    }
    const cached = {
      value,
      source,
      resolvedAt: new Date
    };
    this.cache.set(key.name, cached);
    const audit = this.auditMap.get(key.name) || {
      keyName: key.name,
      keyClass: key.class,
      lastAccessedAt: new Date,
      source,
      accessCount: 0
    };
    audit.lastAccessedAt = new Date;
    audit.accessCount++;
    this.auditMap.set(key.name, audit);
    return cached;
  }
  async get(key) {
    const cached = await this.resolve(key);
    if (cached.value === undefined && key.required) {
      throw new RuntimeConfigMissing(key.name, key.class, "Value is undefined");
    }
    return cached.value;
  }
  async getOptional(key) {
    const cached = await this.resolve(key);
    return cached.value;
  }
  recordTenantDsnAccess(slug) {
    const syntheticKey = `tenant_dsn:${slug}`;
    const existing = this.tenantDsnAuditMap.get(syntheticKey);
    if (existing) {
      existing.lastAccessedAt = new Date;
      existing.accessCount++;
    } else {
      this.tenantDsnAuditMap.set(syntheticKey, {
        syntheticKey,
        slug,
        lastAccessedAt: new Date,
        accessCount: 1
      });
    }
  }
  clear() {
    this.cache.clear();
    this.dbCache.clear();
  }
  async reload() {
    const ctx = agentContextStorage.getStore();
    if (!ctx?.verified) {
      throw new RuntimeConfigMutationForbidden("<reload>", "NO_IDENTITY_CONTEXT", null);
    }
    const authority = ConfigResolver.resolveAuthority(ctx.verified.principal_kind);
    if (authority !== "operator") {
      throw new RuntimeConfigMutationForbidden("<reload>", "RELOAD_UNAUTHORIZED", authority);
    }
    this.clear();
  }
  static resolveAuthority(kind) {
    switch (kind) {
      case "operator":
        return "operator";
      case "agency":
        return "system";
      default:
        return "agent_read_only";
    }
  }
  async set(key, value) {
    const ctx = agentContextStorage.getStore();
    const emergencyDid = process.env.AGENTHIVE_EMERGENCY_OPERATOR_DID?.trim();
    if (!ctx?.verified) {
      if (emergencyDid) {
        console.warn(`[ConfigResolver] EMERGENCY operator override active for set("${key.name}") ` + `via AGENTHIVE_EMERGENCY_OPERATOR_DID — no verified principal in context.`);
        if (key.class === "secret" || key.class === "tenant_dsn") {
          throw new RuntimeConfigMutationForbidden(key.name, "IMMUTABLE_CLASS", "operator");
        }
        if (!this.pool) {
          throw new RuntimeConfigMissing(key.name, key.class, "[RuntimeConfig] set() requires a control-plane pool (hiveCentral) to persist + audit the mutation.");
        }
        await this.persistMutation(key, value, {
          authority: "operator",
          emergencyDid
        });
        return;
      }
      throw new RuntimeConfigMutationForbidden(key.name, "NO_IDENTITY_CONTEXT", null);
    }
    const authority = ConfigResolver.resolveAuthority(ctx.verified.principal_kind);
    if (authority === "agent_read_only") {
      throw new RuntimeConfigMutationForbidden(key.name, "AGENT_READ_ONLY", authority);
    }
    if (key.class === "secret" || key.class === "tenant_dsn") {
      throw new RuntimeConfigMutationForbidden(key.name, "IMMUTABLE_CLASS", authority);
    }
    if (key.class === "structural" && authority !== "operator") {
      throw new RuntimeConfigMutationForbidden(key.name, "SYSTEM_STRUCTURAL_DENIED", authority);
    }
    if (key.class === "registry" && authority === "system") {
      throw new RuntimeConfigMutationForbidden(key.name, "SYSTEM_REGISTRY_DENIED", authority);
    }
    if (!this.pool) {
      throw new RuntimeConfigMissing(key.name, key.class, "[RuntimeConfig] set() requires a control-plane pool (hiveCentral) to persist + audit the mutation.");
    }
    await this.persistMutation(key, value, {
      authority,
      principalId: ctx.verified.principal_id
    });
  }
  async persistMutation(key, value, opts) {
    const pool2 = this.pool;
    const { authority } = opts;
    let lookup;
    if (opts.emergencyDid !== undefined) {
      lookup = await pool2.query(`SELECT id, did, principal_type FROM control_identity.principal
				  WHERE did = $1 AND lifecycle_status = 'active' LIMIT 1`, [opts.emergencyDid]);
    } else {
      lookup = await pool2.query(`SELECT id, did, principal_type FROM control_identity.principal
				  WHERE id = $1 AND lifecycle_status = 'active' LIMIT 1`, [opts.principalId]);
    }
    if (lookup.rows.length === 0) {
      throw new RuntimeConfigMutationForbidden(key.name, "PRINCIPAL_LOOKUP_FAILED", authority);
    }
    const row = lookup.rows[0];
    if (row.principal_type === "human") {
      console.warn(`[ConfigResolver] principal ${row.did} has principal_type='human'; ` + `config mutation denied (AC-29) — register as an operator principal.`);
      throw new RuntimeConfigMutationForbidden(key.name, "AGENT_READ_ONLY", "agent_read_only");
    }
    const callerDid = row.did;
    const principalDbId = row.id;
    const scope = "global";
    const oldValue = await this.getOptional(key).catch(() => {
      return;
    });
    const oldJson = oldValue === undefined ? null : JSON.stringify(oldValue);
    try {
      key.parse(JSON.stringify(value));
    } catch (parseErr) {
      const errMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      await pool2.query(`INSERT INTO core.config_mutation_log
					   (key_name, key_class, scope, old_value, new_value, caller_did,
					    principal_id, mutation_authority, validation_result, validation_error)
					 VALUES ($1, $2, $3, $4::jsonb, NULL, $5, $6, $7, 'failed', $8)`, [
        key.name,
        key.class,
        scope,
        oldJson,
        callerDid,
        principalDbId,
        authority,
        errMsg
      ]).catch(() => {});
      throw parseErr;
    }
    const newJson = JSON.stringify(value);
    const client = await pool2.connect();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO ${RUNTIME_FLAG_TABLE}
				   (flag_name, scope, value_jsonb, owner_did, modified_by_did)
				 VALUES ($1, $2, $3::jsonb, $4, $4)
				 ON CONFLICT (flag_name, scope)
				 DO UPDATE SET value_jsonb = EXCLUDED.value_jsonb,
				               modified_by_did = EXCLUDED.modified_by_did`, [key.name, scope, newJson, callerDid]);
      await client.query(`INSERT INTO core.config_mutation_log
				   (key_name, key_class, scope, old_value, new_value, caller_did,
				    principal_id, mutation_authority, validation_result)
				 VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, 'success')`, [
        key.name,
        key.class,
        scope,
        oldJson,
        newJson,
        callerDid,
        principalDbId,
        authority
      ]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    await pool2.query(`SELECT pg_notify('runtime_flag_changed', $1)`, [
      JSON.stringify({
        flag_name: key.name,
        scope,
        op: "UPDATE",
        mutated_by_did: callerDid
      })
    ]).catch(() => {});
    this.cache.delete(key.name);
    this.dbCache.delete(`runtime_flag:${key.name}:${scope}`);
  }
  getAudit() {
    return [...this.auditMap.values()];
  }
  getTenantDsnAudit() {
    return [...this.tenantDsnAuditMap.values()];
  }
  getAuditSnapshot() {
    return {
      config: this.getAudit(),
      tenantDsn: this.getTenantDsnAudit()
    };
  }
  getYamlValue(path2) {
    if (!this.yamlConfig)
      return;
    const parts = path2.split(".");
    let current = this.yamlConfig;
    for (const part of parts) {
      if (current === null || typeof current !== "object") {
        return;
      }
      current = current[part];
    }
    return current;
  }
  async getActiveFlagValue(flagName, scope = "global") {
    if (!this.pool)
      return;
    const cacheKey = `runtime_flag:${flagName}:${scope}`;
    if (this.dbCache.has(cacheKey))
      return this.dbCache.get(cacheKey);
    try {
      const result = await this.pool.query(`SELECT value_jsonb FROM core.runtime_flag WHERE flag_name = $1 AND scope = $2 AND lifecycle_status = 'active' LIMIT 1`, [flagName, scope]);
      const value = result.rows[0]?.value_jsonb;
      this.dbCache.set(cacheKey, value);
      return value;
    } catch {
      return;
    }
  }
  async getDbValue(table, column, flagName) {
    if (!this.pool)
      return;
    if (table === RUNTIME_FLAG_TABLE && flagName) {
      return this.getScopedFlagValue(flagName);
    }
    const cacheKey = `${table}:${column}`;
    if (this.dbCache.has(cacheKey)) {
      return this.dbCache.get(cacheKey);
    }
    try {
      const result = await this.pool.query(`SELECT ${column} FROM ${table} LIMIT 1`);
      const value = result.rows[0]?.[column];
      this.dbCache.set(cacheKey, value);
      return value;
    } catch {
      return;
    }
  }
  async cleanup() {
    if (!this.notifySubscription)
      return;
    try {
      await this.notifySubscription.query("UNLISTEN runtime_flag_changed");
      this.notifySubscription.release();
    } catch {} finally {
      this.notifySubscription = null;
    }
    if (this.directListenPool) {
      try {
        await this.directListenPool.end();
      } catch {} finally {
        this.directListenPool = null;
      }
    }
  }
}
async function initConfig(opts) {
  if (globalResolver) {
    await globalResolver.cleanup();
  }
  const resolver = new ConfigResolver;
  await resolver.init(opts);
  globalResolver = resolver;
  return resolver;
}
async function initConfigFromControlPool(opts) {
  if (globalResolver && !opts?.force) {
    return globalResolver;
  }
  const { getControlPool: getControlPool2 } = await Promise.resolve().then(() => (init_pool_registry(), exports_pool_registry));
  const pool2 = getControlPool2();
  return initConfig({
    pool: pool2,
    yamlConfig: opts?.yamlConfig,
    envFilePath: opts?.envFilePath,
    scopeContext: opts?.scopeContext
  });
}
function getResolver() {
  if (!globalResolver) {
    throw new Error("[Config] Resolver not initialized. Call initConfig() at process startup.");
  }
  return globalResolver;
}
async function get(key) {
  return getResolver().get(key);
}
async function set(key, value) {
  return getResolver().set(key, value);
}
async function getOptional(key) {
  return getResolver().getOptional(key);
}
async function getProjectDb2(slugOrId) {
  const { getProjectDb: registryGetProjectDb } = await Promise.resolve().then(() => (init_pool_registry(), exports_pool_registry));
  const slug = String(slugOrId);
  const pool2 = await registryGetProjectDb(slugOrId);
  if (globalResolver) {
    globalResolver.recordTenantDsnAccess(slug);
  }
  return pool2;
}
async function reload() {
  return getResolver().reload();
}
function getAudit() {
  if (!globalResolver)
    return [];
  return globalResolver.getAudit();
}
function getAuditSnapshot() {
  if (!globalResolver)
    return { config: [], tenantDsn: [] };
  return globalResolver.getAuditSnapshot();
}
function clearCache() {
  if (!globalResolver)
    return;
  globalResolver.clear();
}
async function cleanup() {
  if (!globalResolver)
    return;
  await globalResolver.cleanup();
  globalResolver = null;
}
var RuntimeConfigMissing, RuntimeConfigInvalidSource, ProjectIdMissing, RuntimeConfigMutationForbidden, FLAG_CACHE_TTL_MS = 300000, RUNTIME_FLAG_TABLE = "core.runtime_flag", DEFAULT_ENV_FILE_PATH = "/etc/agenthive/env", globalResolver = null;
var init_config = __esm(() => {
  init_agent_context();
  RuntimeConfigMissing = class RuntimeConfigMissing extends Error {
    keyName;
    keyClass;
    constructor(keyName, keyClass, details) {
      super(`[RuntimeConfig] Required ${keyClass} key not found: ${keyName}
${details}`);
      this.keyName = keyName;
      this.keyClass = keyClass;
      this.name = "RuntimeConfigMissing";
      Object.setPrototypeOf(this, RuntimeConfigMissing.prototype);
    }
  };
  RuntimeConfigInvalidSource = class RuntimeConfigInvalidSource extends Error {
    keyName;
    attemptedSource;
    allowedSources;
    constructor(keyName, attemptedSource, allowedSources, message) {
      super(message ?? `[RuntimeConfig] Key "${keyName}" cannot be read from ${attemptedSource}. ` + `Allowed sources: ${allowedSources.join(", ")}`);
      this.keyName = keyName;
      this.attemptedSource = attemptedSource;
      this.allowedSources = allowedSources;
      this.name = "RuntimeConfigInvalidSource";
      Object.setPrototypeOf(this, RuntimeConfigInvalidSource.prototype);
    }
  };
  ProjectIdMissing = class ProjectIdMissing extends Error {
    keyName;
    constructor(keyName) {
      super(`[RuntimeConfig] Key "${keyName}" requires project scope but no projectSlug was provided to ConfigResolver.init(). Pass scopeContext.projectSlug.`);
      this.keyName = keyName;
      this.name = "ProjectIdMissing";
      Object.setPrototypeOf(this, ProjectIdMissing.prototype);
    }
  };
  RuntimeConfigMutationForbidden = class RuntimeConfigMutationForbidden extends Error {
    keyName;
    reason;
    authority;
    constructor(keyName, reason, authority) {
      super(`[RuntimeConfig] mutation of "${keyName}" forbidden: ${reason}` + (authority ? ` (authority=${authority})` : " (no identity context)"));
      this.keyName = keyName;
      this.reason = reason;
      this.authority = authority;
      this.name = "RuntimeConfigMutationForbidden";
      Object.setPrototypeOf(this, RuntimeConfigMutationForbidden.prototype);
    }
  };
});

// src/apps/agenthive-cli.ts
import { execSync, spawn } from "node:child_process";
import { constants, readFileSync } from "node:fs";
import { access, writeFile as writeFile2 } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join as join2, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// node_modules/@clack/core/dist/index.mjs
var import_picocolors = __toESM(require_picocolors(), 1);
var import_sisteransi = __toESM(require_src(), 1);
import { stdout as R, stdin as q } from "node:process";
import * as k from "node:readline";
import ot from "node:readline";
import { ReadStream as J } from "node:tty";
function B(t, e, s) {
  if (!s.some((u) => !u.disabled))
    return t;
  const i = t + e, r = Math.max(s.length - 1, 0), n = i < 0 ? r : i > r ? 0 : i;
  return s[n].disabled ? B(n, e < 0 ? -1 : 1, s) : n;
}
var at = (t) => t === 161 || t === 164 || t === 167 || t === 168 || t === 170 || t === 173 || t === 174 || t >= 176 && t <= 180 || t >= 182 && t <= 186 || t >= 188 && t <= 191 || t === 198 || t === 208 || t === 215 || t === 216 || t >= 222 && t <= 225 || t === 230 || t >= 232 && t <= 234 || t === 236 || t === 237 || t === 240 || t === 242 || t === 243 || t >= 247 && t <= 250 || t === 252 || t === 254 || t === 257 || t === 273 || t === 275 || t === 283 || t === 294 || t === 295 || t === 299 || t >= 305 && t <= 307 || t === 312 || t >= 319 && t <= 322 || t === 324 || t >= 328 && t <= 331 || t === 333 || t === 338 || t === 339 || t === 358 || t === 359 || t === 363 || t === 462 || t === 464 || t === 466 || t === 468 || t === 470 || t === 472 || t === 474 || t === 476 || t === 593 || t === 609 || t === 708 || t === 711 || t >= 713 && t <= 715 || t === 717 || t === 720 || t >= 728 && t <= 731 || t === 733 || t === 735 || t >= 768 && t <= 879 || t >= 913 && t <= 929 || t >= 931 && t <= 937 || t >= 945 && t <= 961 || t >= 963 && t <= 969 || t === 1025 || t >= 1040 && t <= 1103 || t === 1105 || t === 8208 || t >= 8211 && t <= 8214 || t === 8216 || t === 8217 || t === 8220 || t === 8221 || t >= 8224 && t <= 8226 || t >= 8228 && t <= 8231 || t === 8240 || t === 8242 || t === 8243 || t === 8245 || t === 8251 || t === 8254 || t === 8308 || t === 8319 || t >= 8321 && t <= 8324 || t === 8364 || t === 8451 || t === 8453 || t === 8457 || t === 8467 || t === 8470 || t === 8481 || t === 8482 || t === 8486 || t === 8491 || t === 8531 || t === 8532 || t >= 8539 && t <= 8542 || t >= 8544 && t <= 8555 || t >= 8560 && t <= 8569 || t === 8585 || t >= 8592 && t <= 8601 || t === 8632 || t === 8633 || t === 8658 || t === 8660 || t === 8679 || t === 8704 || t === 8706 || t === 8707 || t === 8711 || t === 8712 || t === 8715 || t === 8719 || t === 8721 || t === 8725 || t === 8730 || t >= 8733 && t <= 8736 || t === 8739 || t === 8741 || t >= 8743 && t <= 8748 || t === 8750 || t >= 8756 && t <= 8759 || t === 8764 || t === 8765 || t === 8776 || t === 8780 || t === 8786 || t === 8800 || t === 8801 || t >= 8804 && t <= 8807 || t === 8810 || t === 8811 || t === 8814 || t === 8815 || t === 8834 || t === 8835 || t === 8838 || t === 8839 || t === 8853 || t === 8857 || t === 8869 || t === 8895 || t === 8978 || t >= 9312 && t <= 9449 || t >= 9451 && t <= 9547 || t >= 9552 && t <= 9587 || t >= 9600 && t <= 9615 || t >= 9618 && t <= 9621 || t === 9632 || t === 9633 || t >= 9635 && t <= 9641 || t === 9650 || t === 9651 || t === 9654 || t === 9655 || t === 9660 || t === 9661 || t === 9664 || t === 9665 || t >= 9670 && t <= 9672 || t === 9675 || t >= 9678 && t <= 9681 || t >= 9698 && t <= 9701 || t === 9711 || t === 9733 || t === 9734 || t === 9737 || t === 9742 || t === 9743 || t === 9756 || t === 9758 || t === 9792 || t === 9794 || t === 9824 || t === 9825 || t >= 9827 && t <= 9829 || t >= 9831 && t <= 9834 || t === 9836 || t === 9837 || t === 9839 || t === 9886 || t === 9887 || t === 9919 || t >= 9926 && t <= 9933 || t >= 9935 && t <= 9939 || t >= 9941 && t <= 9953 || t === 9955 || t === 9960 || t === 9961 || t >= 9963 && t <= 9969 || t === 9972 || t >= 9974 && t <= 9977 || t === 9979 || t === 9980 || t === 9982 || t === 9983 || t === 10045 || t >= 10102 && t <= 10111 || t >= 11094 && t <= 11097 || t >= 12872 && t <= 12879 || t >= 57344 && t <= 63743 || t >= 65024 && t <= 65039 || t === 65533 || t >= 127232 && t <= 127242 || t >= 127248 && t <= 127277 || t >= 127280 && t <= 127337 || t >= 127344 && t <= 127373 || t === 127375 || t === 127376 || t >= 127387 && t <= 127404 || t >= 917760 && t <= 917999 || t >= 983040 && t <= 1048573 || t >= 1048576 && t <= 1114109;
var lt = (t) => t === 12288 || t >= 65281 && t <= 65376 || t >= 65504 && t <= 65510;
var ht = (t) => t >= 4352 && t <= 4447 || t === 8986 || t === 8987 || t === 9001 || t === 9002 || t >= 9193 && t <= 9196 || t === 9200 || t === 9203 || t === 9725 || t === 9726 || t === 9748 || t === 9749 || t >= 9800 && t <= 9811 || t === 9855 || t === 9875 || t === 9889 || t === 9898 || t === 9899 || t === 9917 || t === 9918 || t === 9924 || t === 9925 || t === 9934 || t === 9940 || t === 9962 || t === 9970 || t === 9971 || t === 9973 || t === 9978 || t === 9981 || t === 9989 || t === 9994 || t === 9995 || t === 10024 || t === 10060 || t === 10062 || t >= 10067 && t <= 10069 || t === 10071 || t >= 10133 && t <= 10135 || t === 10160 || t === 10175 || t === 11035 || t === 11036 || t === 11088 || t === 11093 || t >= 11904 && t <= 11929 || t >= 11931 && t <= 12019 || t >= 12032 && t <= 12245 || t >= 12272 && t <= 12287 || t >= 12289 && t <= 12350 || t >= 12353 && t <= 12438 || t >= 12441 && t <= 12543 || t >= 12549 && t <= 12591 || t >= 12593 && t <= 12686 || t >= 12688 && t <= 12771 || t >= 12783 && t <= 12830 || t >= 12832 && t <= 12871 || t >= 12880 && t <= 19903 || t >= 19968 && t <= 42124 || t >= 42128 && t <= 42182 || t >= 43360 && t <= 43388 || t >= 44032 && t <= 55203 || t >= 63744 && t <= 64255 || t >= 65040 && t <= 65049 || t >= 65072 && t <= 65106 || t >= 65108 && t <= 65126 || t >= 65128 && t <= 65131 || t >= 94176 && t <= 94180 || t === 94192 || t === 94193 || t >= 94208 && t <= 100343 || t >= 100352 && t <= 101589 || t >= 101632 && t <= 101640 || t >= 110576 && t <= 110579 || t >= 110581 && t <= 110587 || t === 110589 || t === 110590 || t >= 110592 && t <= 110882 || t === 110898 || t >= 110928 && t <= 110930 || t === 110933 || t >= 110948 && t <= 110951 || t >= 110960 && t <= 111355 || t === 126980 || t === 127183 || t === 127374 || t >= 127377 && t <= 127386 || t >= 127488 && t <= 127490 || t >= 127504 && t <= 127547 || t >= 127552 && t <= 127560 || t === 127568 || t === 127569 || t >= 127584 && t <= 127589 || t >= 127744 && t <= 127776 || t >= 127789 && t <= 127797 || t >= 127799 && t <= 127868 || t >= 127870 && t <= 127891 || t >= 127904 && t <= 127946 || t >= 127951 && t <= 127955 || t >= 127968 && t <= 127984 || t === 127988 || t >= 127992 && t <= 128062 || t === 128064 || t >= 128066 && t <= 128252 || t >= 128255 && t <= 128317 || t >= 128331 && t <= 128334 || t >= 128336 && t <= 128359 || t === 128378 || t === 128405 || t === 128406 || t === 128420 || t >= 128507 && t <= 128591 || t >= 128640 && t <= 128709 || t === 128716 || t >= 128720 && t <= 128722 || t >= 128725 && t <= 128727 || t >= 128732 && t <= 128735 || t === 128747 || t === 128748 || t >= 128756 && t <= 128764 || t >= 128992 && t <= 129003 || t === 129008 || t >= 129292 && t <= 129338 || t >= 129340 && t <= 129349 || t >= 129351 && t <= 129535 || t >= 129648 && t <= 129660 || t >= 129664 && t <= 129672 || t >= 129680 && t <= 129725 || t >= 129727 && t <= 129733 || t >= 129742 && t <= 129755 || t >= 129760 && t <= 129768 || t >= 129776 && t <= 129784 || t >= 131072 && t <= 196605 || t >= 196608 && t <= 262141;
var O = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/y;
var y = /[\x00-\x08\x0A-\x1F\x7F-\x9F]{1,1000}/y;
var L = /\t{1,1000}/y;
var P = /[\u{1F1E6}-\u{1F1FF}]{2}|\u{1F3F4}[\u{E0061}-\u{E007A}]{2}[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]{1,3}\u{E007F}|(?:\p{Emoji}\uFE0F\u20E3?|\p{Emoji_Modifier_Base}\p{Emoji_Modifier}?|\p{Emoji_Presentation})(?:\u200D(?:\p{Emoji_Modifier_Base}\p{Emoji_Modifier}?|\p{Emoji_Presentation}|\p{Emoji}\uFE0F\u20E3?))*/yu;
var M = /(?:[\x20-\x7E\xA0-\xFF](?!\uFE0F)){1,1000}/y;
var ct = /\p{M}+/gu;
var ft = { limit: 1 / 0, ellipsis: "" };
var X = (t, e = {}, s = {}) => {
  const i = e.limit ?? 1 / 0, r = e.ellipsis ?? "", n = e?.ellipsisWidth ?? (r ? X(r, ft, s).width : 0), u = s.ansiWidth ?? 0, a = s.controlWidth ?? 0, l = s.tabWidth ?? 8, E = s.ambiguousWidth ?? 1, g = s.emojiWidth ?? 2, m = s.fullWidthWidth ?? 2, A = s.regularWidth ?? 1, V = s.wideWidth ?? 2;
  let h = 0, o = 0, p = t.length, v = 0, F = false, d = p, b = Math.max(0, i - n), C = 0, w = 0, c = 0, f = 0;
  t:
    for (;; ) {
      if (w > C || o >= p && o > h) {
        const ut = t.slice(C, w) || t.slice(h, o);
        v = 0;
        for (const Y of ut.replaceAll(ct, "")) {
          const $ = Y.codePointAt(0) || 0;
          if (lt($) ? f = m : ht($) ? f = V : E !== A && at($) ? f = E : f = A, c + f > b && (d = Math.min(d, Math.max(C, h) + v)), c + f > i) {
            F = true;
            break t;
          }
          v += Y.length, c += f;
        }
        C = w = 0;
      }
      if (o >= p)
        break;
      if (M.lastIndex = o, M.test(t)) {
        if (v = M.lastIndex - o, f = v * A, c + f > b && (d = Math.min(d, o + Math.floor((b - c) / A))), c + f > i) {
          F = true;
          break;
        }
        c += f, C = h, w = o, o = h = M.lastIndex;
        continue;
      }
      if (O.lastIndex = o, O.test(t)) {
        if (c + u > b && (d = Math.min(d, o)), c + u > i) {
          F = true;
          break;
        }
        c += u, C = h, w = o, o = h = O.lastIndex;
        continue;
      }
      if (y.lastIndex = o, y.test(t)) {
        if (v = y.lastIndex - o, f = v * a, c + f > b && (d = Math.min(d, o + Math.floor((b - c) / a))), c + f > i) {
          F = true;
          break;
        }
        c += f, C = h, w = o, o = h = y.lastIndex;
        continue;
      }
      if (L.lastIndex = o, L.test(t)) {
        if (v = L.lastIndex - o, f = v * l, c + f > b && (d = Math.min(d, o + Math.floor((b - c) / l))), c + f > i) {
          F = true;
          break;
        }
        c += f, C = h, w = o, o = h = L.lastIndex;
        continue;
      }
      if (P.lastIndex = o, P.test(t)) {
        if (c + g > b && (d = Math.min(d, o)), c + g > i) {
          F = true;
          break;
        }
        c += g, C = h, w = o, o = h = P.lastIndex;
        continue;
      }
      o += 1;
    }
  return { width: F ? b : c, index: F ? d : p, truncated: F, ellipsed: F && i >= n };
};
var pt = { limit: 1 / 0, ellipsis: "", ellipsisWidth: 0 };
var S = (t, e = {}) => X(t, pt, e).width;
var W = "\x1B";
var Z = "";
var Ft = 39;
var j = "\x07";
var Q = "[";
var dt = "]";
var tt = "m";
var U = `${dt}8;;`;
var et = new RegExp(`(?:\\${Q}(?<code>\\d+)m|\\${U}(?<uri>.*)${j})`, "y");
var mt = (t) => {
  if (t >= 30 && t <= 37 || t >= 90 && t <= 97)
    return 39;
  if (t >= 40 && t <= 47 || t >= 100 && t <= 107)
    return 49;
  if (t === 1 || t === 2)
    return 22;
  if (t === 3)
    return 23;
  if (t === 4)
    return 24;
  if (t === 7)
    return 27;
  if (t === 8)
    return 28;
  if (t === 9)
    return 29;
  if (t === 0)
    return 0;
};
var st = (t) => `${W}${Q}${t}${tt}`;
var it = (t) => `${W}${U}${t}${j}`;
var gt = (t) => t.map((e) => S(e));
var G = (t, e, s) => {
  const i = e[Symbol.iterator]();
  let r = false, n = false, u = t.at(-1), a = u === undefined ? 0 : S(u), l = i.next(), E = i.next(), g = 0;
  for (;!l.done; ) {
    const m = l.value, A = S(m);
    a + A <= s ? t[t.length - 1] += m : (t.push(m), a = 0), (m === W || m === Z) && (r = true, n = e.startsWith(U, g + 1)), r ? n ? m === j && (r = false, n = false) : m === tt && (r = false) : (a += A, a === s && !E.done && (t.push(""), a = 0)), l = E, E = i.next(), g += m.length;
  }
  u = t.at(-1), !a && u !== undefined && u.length > 0 && t.length > 1 && (t[t.length - 2] += t.pop());
};
var vt = (t) => {
  const e = t.split(" ");
  let s = e.length;
  for (;s > 0 && !(S(e[s - 1]) > 0); )
    s--;
  return s === e.length ? t : e.slice(0, s).join(" ") + e.slice(s).join("");
};
var Et = (t, e, s = {}) => {
  if (s.trim !== false && t.trim() === "")
    return "";
  let i = "", r, n;
  const u = t.split(" "), a = gt(u);
  let l = [""];
  for (const [h, o] of u.entries()) {
    s.trim !== false && (l[l.length - 1] = (l.at(-1) ?? "").trimStart());
    let p = S(l.at(-1) ?? "");
    if (h !== 0 && (p >= e && (s.wordWrap === false || s.trim === false) && (l.push(""), p = 0), (p > 0 || s.trim === false) && (l[l.length - 1] += " ", p++)), s.hard && a[h] > e) {
      const v = e - p, F = 1 + Math.floor((a[h] - v - 1) / e);
      Math.floor((a[h] - 1) / e) < F && l.push(""), G(l, o, e);
      continue;
    }
    if (p + a[h] > e && p > 0 && a[h] > 0) {
      if (s.wordWrap === false && p < e) {
        G(l, o, e);
        continue;
      }
      l.push("");
    }
    if (p + a[h] > e && s.wordWrap === false) {
      G(l, o, e);
      continue;
    }
    l[l.length - 1] += o;
  }
  s.trim !== false && (l = l.map((h) => vt(h)));
  const E = l.join(`
`), g = E[Symbol.iterator]();
  let m = g.next(), A = g.next(), V = 0;
  for (;!m.done; ) {
    const h = m.value, o = A.value;
    if (i += h, h === W || h === Z) {
      et.lastIndex = V + 1;
      const F = et.exec(E)?.groups;
      if (F?.code !== undefined) {
        const d = Number.parseFloat(F.code);
        r = d === Ft ? undefined : d;
      } else
        F?.uri !== undefined && (n = F.uri.length === 0 ? undefined : F.uri);
    }
    const p = r ? mt(r) : undefined;
    o === `
` ? (n && (i += it("")), r && p && (i += st(p))) : h === `
` && (r && p && (i += st(r)), n && (i += it(n))), V += h.length, m = A, A = g.next();
  }
  return i;
};
function K(t, e, s) {
  return String(t).normalize().replaceAll(`\r
`, `
`).split(`
`).map((i) => Et(i, e, s)).join(`
`);
}
var At = ["up", "down", "left", "right", "space", "enter", "cancel"];
var _ = { actions: new Set(At), aliases: new Map([["k", "up"], ["j", "down"], ["h", "left"], ["l", "right"], ["\x03", "cancel"], ["escape", "cancel"]]), messages: { cancel: "Canceled", error: "Something went wrong" }, withGuide: true };
function H(t, e) {
  if (typeof t == "string")
    return _.aliases.get(t) === e;
  for (const s of t)
    if (s !== undefined && H(s, e))
      return true;
  return false;
}
function _t(t, e) {
  if (t === e)
    return;
  const s = t.split(`
`), i = e.split(`
`), r = Math.max(s.length, i.length), n = [];
  for (let u = 0;u < r; u++)
    s[u] !== i[u] && n.push(u);
  return { lines: n, numLinesBefore: s.length, numLinesAfter: i.length, numLines: r };
}
var bt = globalThis.process.platform.startsWith("win");
var z = Symbol("clack:cancel");
function Ct(t) {
  return t === z;
}
function T(t, e) {
  const s = t;
  s.isTTY && s.setRawMode(e);
}
function Bt({ input: t = q, output: e = R, overwrite: s = true, hideCursor: i = true } = {}) {
  const r = k.createInterface({ input: t, output: e, prompt: "", tabSize: 1 });
  k.emitKeypressEvents(t, r), t instanceof J && t.isTTY && t.setRawMode(true);
  const n = (u, { name: a, sequence: l }) => {
    const E = String(u);
    if (H([E, a, l], "cancel")) {
      i && e.write(import_sisteransi.cursor.show), process.exit(0);
      return;
    }
    if (!s)
      return;
    const g = a === "return" ? 0 : -1, m = a === "return" ? -1 : 0;
    k.moveCursor(e, g, m, () => {
      k.clearLine(e, 1, () => {
        t.once("keypress", n);
      });
    });
  };
  return i && e.write(import_sisteransi.cursor.hide), t.once("keypress", n), () => {
    t.off("keypress", n), i && e.write(import_sisteransi.cursor.show), t instanceof J && t.isTTY && !bt && t.setRawMode(false), r.terminal = false, r.close();
  };
}
var rt = (t) => ("columns" in t) && typeof t.columns == "number" ? t.columns : 80;
var nt = (t) => ("rows" in t) && typeof t.rows == "number" ? t.rows : 20;
class x {
  input;
  output;
  _abortSignal;
  rl;
  opts;
  _render;
  _track = false;
  _prevFrame = "";
  _subscribers = new Map;
  _cursor = 0;
  state = "initial";
  error = "";
  value;
  userInput = "";
  constructor(e, s = true) {
    const { input: i = q, output: r = R, render: n, signal: u, ...a } = e;
    this.opts = a, this.onKeypress = this.onKeypress.bind(this), this.close = this.close.bind(this), this.render = this.render.bind(this), this._render = n.bind(this), this._track = s, this._abortSignal = u, this.input = i, this.output = r;
  }
  unsubscribe() {
    this._subscribers.clear();
  }
  setSubscriber(e, s) {
    const i = this._subscribers.get(e) ?? [];
    i.push(s), this._subscribers.set(e, i);
  }
  on(e, s) {
    this.setSubscriber(e, { cb: s });
  }
  once(e, s) {
    this.setSubscriber(e, { cb: s, once: true });
  }
  emit(e, ...s) {
    const i = this._subscribers.get(e) ?? [], r = [];
    for (const n of i)
      n.cb(...s), n.once && r.push(() => i.splice(i.indexOf(n), 1));
    for (const n of r)
      n();
  }
  prompt() {
    return new Promise((e) => {
      if (this._abortSignal) {
        if (this._abortSignal.aborted)
          return this.state = "cancel", this.close(), e(z);
        this._abortSignal.addEventListener("abort", () => {
          this.state = "cancel", this.close();
        }, { once: true });
      }
      this.rl = ot.createInterface({ input: this.input, tabSize: 2, prompt: "", escapeCodeTimeout: 50, terminal: true }), this.rl.prompt(), this.opts.initialUserInput !== undefined && this._setUserInput(this.opts.initialUserInput, true), this.input.on("keypress", this.onKeypress), T(this.input, true), this.output.on("resize", this.render), this.render(), this.once("submit", () => {
        this.output.write(import_sisteransi.cursor.show), this.output.off("resize", this.render), T(this.input, false), e(this.value);
      }), this.once("cancel", () => {
        this.output.write(import_sisteransi.cursor.show), this.output.off("resize", this.render), T(this.input, false), e(z);
      });
    });
  }
  _isActionKey(e, s) {
    return e === "\t";
  }
  _setValue(e) {
    this.value = e, this.emit("value", this.value);
  }
  _setUserInput(e, s) {
    this.userInput = e ?? "", this.emit("userInput", this.userInput), s && this._track && this.rl && (this.rl.write(this.userInput), this._cursor = this.rl.cursor);
  }
  _clearUserInput() {
    this.rl?.write(null, { ctrl: true, name: "u" }), this._setUserInput("");
  }
  onKeypress(e, s) {
    if (this._track && s.name !== "return" && (s.name && this._isActionKey(e, s) && this.rl?.write(null, { ctrl: true, name: "h" }), this._cursor = this.rl?.cursor ?? 0, this._setUserInput(this.rl?.line)), this.state === "error" && (this.state = "active"), s?.name && (!this._track && _.aliases.has(s.name) && this.emit("cursor", _.aliases.get(s.name)), _.actions.has(s.name) && this.emit("cursor", s.name)), e && (e.toLowerCase() === "y" || e.toLowerCase() === "n") && this.emit("confirm", e.toLowerCase() === "y"), this.emit("key", e?.toLowerCase(), s), s?.name === "return") {
      if (this.opts.validate) {
        const i = this.opts.validate(this.value);
        i && (this.error = i instanceof Error ? i.message : i, this.state = "error", this.rl?.write(this.userInput));
      }
      this.state !== "error" && (this.state = "submit");
    }
    H([e, s?.name, s?.sequence], "cancel") && (this.state = "cancel"), (this.state === "submit" || this.state === "cancel") && this.emit("finalize"), this.render(), (this.state === "submit" || this.state === "cancel") && this.close();
  }
  close() {
    this.input.unpipe(), this.input.removeListener("keypress", this.onKeypress), this.output.write(`
`), T(this.input, false), this.rl?.close(), this.rl = undefined, this.emit(`${this.state}`, this.value), this.unsubscribe();
  }
  restoreCursor() {
    const e = K(this._prevFrame, process.stdout.columns, { hard: true, trim: false }).split(`
`).length - 1;
    this.output.write(import_sisteransi.cursor.move(-999, e * -1));
  }
  render() {
    const e = K(this._render(this) ?? "", process.stdout.columns, { hard: true, trim: false });
    if (e !== this._prevFrame) {
      if (this.state === "initial")
        this.output.write(import_sisteransi.cursor.hide);
      else {
        const s = _t(this._prevFrame, e), i = nt(this.output);
        if (this.restoreCursor(), s) {
          const r = Math.max(0, s.numLinesAfter - i), n = Math.max(0, s.numLinesBefore - i);
          let u = s.lines.find((a) => a >= r);
          if (u === undefined) {
            this._prevFrame = e;
            return;
          }
          if (s.lines.length === 1) {
            this.output.write(import_sisteransi.cursor.move(0, u - n)), this.output.write(import_sisteransi.erase.lines(1));
            const a = e.split(`
`);
            this.output.write(a[u]), this._prevFrame = e, this.output.write(import_sisteransi.cursor.move(0, a.length - u - 1));
            return;
          } else if (s.lines.length > 1) {
            if (r < n)
              u = r;
            else {
              const l = u - n;
              l > 0 && this.output.write(import_sisteransi.cursor.move(0, l));
            }
            this.output.write(import_sisteransi.erase.down());
            const a = e.split(`
`).slice(u);
            this.output.write(a.join(`
`)), this._prevFrame = e;
            return;
          }
        }
        this.output.write(import_sisteransi.erase.down());
      }
      this.output.write(e), this.state === "initial" && (this.state = "active"), this._prevFrame = e;
    }
  }
}
function wt(t, e) {
  if (t === undefined || e.length === 0)
    return 0;
  const s = e.findIndex((i) => i.value === t);
  return s !== -1 ? s : 0;
}
function Dt(t, e) {
  return (e.label ?? String(e.value)).toLowerCase().includes(t.toLowerCase());
}
function St(t, e) {
  if (e)
    return t ? e : e[0];
}

class Vt extends x {
  filteredOptions;
  multiple;
  isNavigating = false;
  selectedValues = [];
  focusedValue;
  #t = 0;
  #s = "";
  #i;
  #e;
  get cursor() {
    return this.#t;
  }
  get userInputWithCursor() {
    if (!this.userInput)
      return import_picocolors.default.inverse(import_picocolors.default.hidden("_"));
    if (this._cursor >= this.userInput.length)
      return `${this.userInput}█`;
    const e = this.userInput.slice(0, this._cursor), [s, ...i] = this.userInput.slice(this._cursor);
    return `${e}${import_picocolors.default.inverse(s)}${i.join("")}`;
  }
  get options() {
    return typeof this.#e == "function" ? this.#e() : this.#e;
  }
  constructor(e) {
    super(e), this.#e = e.options;
    const s = this.options;
    this.filteredOptions = [...s], this.multiple = e.multiple === true, this.#i = e.filter ?? Dt;
    let i;
    if (e.initialValue && Array.isArray(e.initialValue) ? this.multiple ? i = e.initialValue : i = e.initialValue.slice(0, 1) : !this.multiple && this.options.length > 0 && (i = [this.options[0].value]), i)
      for (const r of i) {
        const n = s.findIndex((u) => u.value === r);
        n !== -1 && (this.toggleSelected(r), this.#t = n);
      }
    this.focusedValue = this.options[this.#t]?.value, this.on("key", (r, n) => this.#r(r, n)), this.on("userInput", (r) => this.#n(r));
  }
  _isActionKey(e, s) {
    return e === "\t" || this.multiple && this.isNavigating && s.name === "space" && e !== undefined && e !== "";
  }
  #r(e, s) {
    const i = s.name === "up", r = s.name === "down", n = s.name === "return";
    i || r ? (this.#t = B(this.#t, i ? -1 : 1, this.filteredOptions), this.focusedValue = this.filteredOptions[this.#t]?.value, this.multiple || (this.selectedValues = [this.focusedValue]), this.isNavigating = true) : n ? this.value = St(this.multiple, this.selectedValues) : this.multiple ? this.focusedValue !== undefined && (s.name === "tab" || this.isNavigating && s.name === "space") ? this.toggleSelected(this.focusedValue) : this.isNavigating = false : (this.focusedValue && (this.selectedValues = [this.focusedValue]), this.isNavigating = false);
  }
  deselectAll() {
    this.selectedValues = [];
  }
  toggleSelected(e) {
    this.filteredOptions.length !== 0 && (this.multiple ? this.selectedValues.includes(e) ? this.selectedValues = this.selectedValues.filter((s) => s !== e) : this.selectedValues = [...this.selectedValues, e] : this.selectedValues = [e]);
  }
  #n(e) {
    if (e !== this.#s) {
      this.#s = e;
      const s = this.options;
      e ? this.filteredOptions = s.filter((n) => this.#i(e, n)) : this.filteredOptions = [...s];
      const i = wt(this.focusedValue, this.filteredOptions);
      this.#t = B(i, 0, this.filteredOptions);
      const r = this.filteredOptions[this.#t];
      r && !r.disabled ? this.focusedValue = r.value : this.focusedValue = undefined, this.multiple || (this.focusedValue !== undefined ? this.toggleSelected(this.focusedValue) : this.deselectAll());
    }
  }
}

class kt extends x {
  get cursor() {
    return this.value ? 0 : 1;
  }
  get _value() {
    return this.cursor === 0;
  }
  constructor(e) {
    super(e, false), this.value = !!e.initialValue, this.on("userInput", () => {
      this.value = this._value;
    }), this.on("confirm", (s) => {
      this.output.write(import_sisteransi.cursor.move(0, -1)), this.value = s, this.state = "submit", this.close();
    }), this.on("cursor", () => {
      this.value = !this.value;
    });
  }
}

class yt extends x {
  options;
  cursor = 0;
  #t;
  getGroupItems(e) {
    return this.options.filter((s) => s.group === e);
  }
  isGroupSelected(e) {
    const s = this.getGroupItems(e), i = this.value;
    return i === undefined ? false : s.every((r) => i.includes(r.value));
  }
  toggleValue() {
    const e = this.options[this.cursor];
    if (this.value === undefined && (this.value = []), e.group === true) {
      const s = e.value, i = this.getGroupItems(s);
      this.isGroupSelected(s) ? this.value = this.value.filter((r) => i.findIndex((n) => n.value === r) === -1) : this.value = [...this.value, ...i.map((r) => r.value)], this.value = Array.from(new Set(this.value));
    } else {
      const s = this.value.includes(e.value);
      this.value = s ? this.value.filter((i) => i !== e.value) : [...this.value, e.value];
    }
  }
  constructor(e) {
    super(e, false);
    const { options: s } = e;
    this.#t = e.selectableGroups !== false, this.options = Object.entries(s).flatMap(([i, r]) => [{ value: i, group: true, label: i }, ...r.map((n) => ({ ...n, group: i }))]), this.value = [...e.initialValues ?? []], this.cursor = Math.max(this.options.findIndex(({ value: i }) => i === e.cursorAt), this.#t ? 0 : 1), this.on("cursor", (i) => {
      switch (i) {
        case "left":
        case "up": {
          this.cursor = this.cursor === 0 ? this.options.length - 1 : this.cursor - 1;
          const r = this.options[this.cursor]?.group === true;
          !this.#t && r && (this.cursor = this.cursor === 0 ? this.options.length - 1 : this.cursor - 1);
          break;
        }
        case "down":
        case "right": {
          this.cursor = this.cursor === this.options.length - 1 ? 0 : this.cursor + 1;
          const r = this.options[this.cursor]?.group === true;
          !this.#t && r && (this.cursor = this.cursor === this.options.length - 1 ? 0 : this.cursor + 1);
          break;
        }
        case "space":
          this.toggleValue();
          break;
      }
    });
  }
}

// node_modules/@clack/prompts/dist/index.mjs
var import_picocolors2 = __toESM(require_picocolors(), 1);
import N2 from "node:process";
var import_sisteransi2 = __toESM(require_src(), 1);
function me() {
  return N2.platform !== "win32" ? N2.env.TERM !== "linux" : !!N2.env.CI || !!N2.env.WT_SESSION || !!N2.env.TERMINUS_SUBLIME || N2.env.ConEmuTask === "{cmd::Cmder}" || N2.env.TERM_PROGRAM === "Terminus-Sublime" || N2.env.TERM_PROGRAM === "vscode" || N2.env.TERM === "xterm-256color" || N2.env.TERM === "alacritty" || N2.env.TERMINAL_EMULATOR === "JetBrains-JediTerm";
}
var et2 = me();
var ct2 = () => process.env.CI === "true";
var C = (t, r) => et2 ? t : r;
var Rt = C("◆", "*");
var dt2 = C("■", "x");
var $t2 = C("▲", "x");
var V = C("◇", "o");
var ht2 = C("┌", "T");
var d = C("│", "|");
var x2 = C("└", "—");
var Ot = C("┐", "T");
var Pt = C("┘", "—");
var Q2 = C("●", ">");
var H2 = C("○", " ");
var st2 = C("◻", "[•]");
var U2 = C("◼", "[+]");
var q2 = C("◻", "[ ]");
var Nt = C("▪", "•");
var rt2 = C("─", "-");
var mt2 = C("╮", "+");
var Wt2 = C("├", "+");
var pt2 = C("╯", "+");
var gt2 = C("╰", "+");
var Lt2 = C("╭", "+");
var ft2 = C("●", "•");
var Ft2 = C("◆", "*");
var yt2 = C("▲", "!");
var Et2 = C("■", "x");
var W2 = (t) => {
  switch (t) {
    case "initial":
    case "active":
      return import_picocolors2.default.cyan(Rt);
    case "cancel":
      return import_picocolors2.default.red(dt2);
    case "error":
      return import_picocolors2.default.yellow($t2);
    case "submit":
      return import_picocolors2.default.green(V);
  }
};
var pe = (t) => t === 161 || t === 164 || t === 167 || t === 168 || t === 170 || t === 173 || t === 174 || t >= 176 && t <= 180 || t >= 182 && t <= 186 || t >= 188 && t <= 191 || t === 198 || t === 208 || t === 215 || t === 216 || t >= 222 && t <= 225 || t === 230 || t >= 232 && t <= 234 || t === 236 || t === 237 || t === 240 || t === 242 || t === 243 || t >= 247 && t <= 250 || t === 252 || t === 254 || t === 257 || t === 273 || t === 275 || t === 283 || t === 294 || t === 295 || t === 299 || t >= 305 && t <= 307 || t === 312 || t >= 319 && t <= 322 || t === 324 || t >= 328 && t <= 331 || t === 333 || t === 338 || t === 339 || t === 358 || t === 359 || t === 363 || t === 462 || t === 464 || t === 466 || t === 468 || t === 470 || t === 472 || t === 474 || t === 476 || t === 593 || t === 609 || t === 708 || t === 711 || t >= 713 && t <= 715 || t === 717 || t === 720 || t >= 728 && t <= 731 || t === 733 || t === 735 || t >= 768 && t <= 879 || t >= 913 && t <= 929 || t >= 931 && t <= 937 || t >= 945 && t <= 961 || t >= 963 && t <= 969 || t === 1025 || t >= 1040 && t <= 1103 || t === 1105 || t === 8208 || t >= 8211 && t <= 8214 || t === 8216 || t === 8217 || t === 8220 || t === 8221 || t >= 8224 && t <= 8226 || t >= 8228 && t <= 8231 || t === 8240 || t === 8242 || t === 8243 || t === 8245 || t === 8251 || t === 8254 || t === 8308 || t === 8319 || t >= 8321 && t <= 8324 || t === 8364 || t === 8451 || t === 8453 || t === 8457 || t === 8467 || t === 8470 || t === 8481 || t === 8482 || t === 8486 || t === 8491 || t === 8531 || t === 8532 || t >= 8539 && t <= 8542 || t >= 8544 && t <= 8555 || t >= 8560 && t <= 8569 || t === 8585 || t >= 8592 && t <= 8601 || t === 8632 || t === 8633 || t === 8658 || t === 8660 || t === 8679 || t === 8704 || t === 8706 || t === 8707 || t === 8711 || t === 8712 || t === 8715 || t === 8719 || t === 8721 || t === 8725 || t === 8730 || t >= 8733 && t <= 8736 || t === 8739 || t === 8741 || t >= 8743 && t <= 8748 || t === 8750 || t >= 8756 && t <= 8759 || t === 8764 || t === 8765 || t === 8776 || t === 8780 || t === 8786 || t === 8800 || t === 8801 || t >= 8804 && t <= 8807 || t === 8810 || t === 8811 || t === 8814 || t === 8815 || t === 8834 || t === 8835 || t === 8838 || t === 8839 || t === 8853 || t === 8857 || t === 8869 || t === 8895 || t === 8978 || t >= 9312 && t <= 9449 || t >= 9451 && t <= 9547 || t >= 9552 && t <= 9587 || t >= 9600 && t <= 9615 || t >= 9618 && t <= 9621 || t === 9632 || t === 9633 || t >= 9635 && t <= 9641 || t === 9650 || t === 9651 || t === 9654 || t === 9655 || t === 9660 || t === 9661 || t === 9664 || t === 9665 || t >= 9670 && t <= 9672 || t === 9675 || t >= 9678 && t <= 9681 || t >= 9698 && t <= 9701 || t === 9711 || t === 9733 || t === 9734 || t === 9737 || t === 9742 || t === 9743 || t === 9756 || t === 9758 || t === 9792 || t === 9794 || t === 9824 || t === 9825 || t >= 9827 && t <= 9829 || t >= 9831 && t <= 9834 || t === 9836 || t === 9837 || t === 9839 || t === 9886 || t === 9887 || t === 9919 || t >= 9926 && t <= 9933 || t >= 9935 && t <= 9939 || t >= 9941 && t <= 9953 || t === 9955 || t === 9960 || t === 9961 || t >= 9963 && t <= 9969 || t === 9972 || t >= 9974 && t <= 9977 || t === 9979 || t === 9980 || t === 9982 || t === 9983 || t === 10045 || t >= 10102 && t <= 10111 || t >= 11094 && t <= 11097 || t >= 12872 && t <= 12879 || t >= 57344 && t <= 63743 || t >= 65024 && t <= 65039 || t === 65533 || t >= 127232 && t <= 127242 || t >= 127248 && t <= 127277 || t >= 127280 && t <= 127337 || t >= 127344 && t <= 127373 || t === 127375 || t === 127376 || t >= 127387 && t <= 127404 || t >= 917760 && t <= 917999 || t >= 983040 && t <= 1048573 || t >= 1048576 && t <= 1114109;
var ge = (t) => t === 12288 || t >= 65281 && t <= 65376 || t >= 65504 && t <= 65510;
var fe = (t) => t >= 4352 && t <= 4447 || t === 8986 || t === 8987 || t === 9001 || t === 9002 || t >= 9193 && t <= 9196 || t === 9200 || t === 9203 || t === 9725 || t === 9726 || t === 9748 || t === 9749 || t >= 9800 && t <= 9811 || t === 9855 || t === 9875 || t === 9889 || t === 9898 || t === 9899 || t === 9917 || t === 9918 || t === 9924 || t === 9925 || t === 9934 || t === 9940 || t === 9962 || t === 9970 || t === 9971 || t === 9973 || t === 9978 || t === 9981 || t === 9989 || t === 9994 || t === 9995 || t === 10024 || t === 10060 || t === 10062 || t >= 10067 && t <= 10069 || t === 10071 || t >= 10133 && t <= 10135 || t === 10160 || t === 10175 || t === 11035 || t === 11036 || t === 11088 || t === 11093 || t >= 11904 && t <= 11929 || t >= 11931 && t <= 12019 || t >= 12032 && t <= 12245 || t >= 12272 && t <= 12287 || t >= 12289 && t <= 12350 || t >= 12353 && t <= 12438 || t >= 12441 && t <= 12543 || t >= 12549 && t <= 12591 || t >= 12593 && t <= 12686 || t >= 12688 && t <= 12771 || t >= 12783 && t <= 12830 || t >= 12832 && t <= 12871 || t >= 12880 && t <= 19903 || t >= 19968 && t <= 42124 || t >= 42128 && t <= 42182 || t >= 43360 && t <= 43388 || t >= 44032 && t <= 55203 || t >= 63744 && t <= 64255 || t >= 65040 && t <= 65049 || t >= 65072 && t <= 65106 || t >= 65108 && t <= 65126 || t >= 65128 && t <= 65131 || t >= 94176 && t <= 94180 || t === 94192 || t === 94193 || t >= 94208 && t <= 100343 || t >= 100352 && t <= 101589 || t >= 101632 && t <= 101640 || t >= 110576 && t <= 110579 || t >= 110581 && t <= 110587 || t === 110589 || t === 110590 || t >= 110592 && t <= 110882 || t === 110898 || t >= 110928 && t <= 110930 || t === 110933 || t >= 110948 && t <= 110951 || t >= 110960 && t <= 111355 || t === 126980 || t === 127183 || t === 127374 || t >= 127377 && t <= 127386 || t >= 127488 && t <= 127490 || t >= 127504 && t <= 127547 || t >= 127552 && t <= 127560 || t === 127568 || t === 127569 || t >= 127584 && t <= 127589 || t >= 127744 && t <= 127776 || t >= 127789 && t <= 127797 || t >= 127799 && t <= 127868 || t >= 127870 && t <= 127891 || t >= 127904 && t <= 127946 || t >= 127951 && t <= 127955 || t >= 127968 && t <= 127984 || t === 127988 || t >= 127992 && t <= 128062 || t === 128064 || t >= 128066 && t <= 128252 || t >= 128255 && t <= 128317 || t >= 128331 && t <= 128334 || t >= 128336 && t <= 128359 || t === 128378 || t === 128405 || t === 128406 || t === 128420 || t >= 128507 && t <= 128591 || t >= 128640 && t <= 128709 || t === 128716 || t >= 128720 && t <= 128722 || t >= 128725 && t <= 128727 || t >= 128732 && t <= 128735 || t === 128747 || t === 128748 || t >= 128756 && t <= 128764 || t >= 128992 && t <= 129003 || t === 129008 || t >= 129292 && t <= 129338 || t >= 129340 && t <= 129349 || t >= 129351 && t <= 129535 || t >= 129648 && t <= 129660 || t >= 129664 && t <= 129672 || t >= 129680 && t <= 129725 || t >= 129727 && t <= 129733 || t >= 129742 && t <= 129755 || t >= 129760 && t <= 129768 || t >= 129776 && t <= 129784 || t >= 131072 && t <= 196605 || t >= 196608 && t <= 262141;
var At2 = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/y;
var it2 = /[\x00-\x08\x0A-\x1F\x7F-\x9F]{1,1000}/y;
var nt2 = /\t{1,1000}/y;
var wt2 = /[\u{1F1E6}-\u{1F1FF}]{2}|\u{1F3F4}[\u{E0061}-\u{E007A}]{2}[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]{1,3}\u{E007F}|(?:\p{Emoji}\uFE0F\u20E3?|\p{Emoji_Modifier_Base}\p{Emoji_Modifier}?|\p{Emoji_Presentation})(?:\u200D(?:\p{Emoji_Modifier_Base}\p{Emoji_Modifier}?|\p{Emoji_Presentation}|\p{Emoji}\uFE0F\u20E3?))*/yu;
var at2 = /(?:[\x20-\x7E\xA0-\xFF](?!\uFE0F)){1,1000}/y;
var Fe = /\p{M}+/gu;
var ye = { limit: 1 / 0, ellipsis: "" };
var jt = (t, r = {}, s = {}) => {
  const i = r.limit ?? 1 / 0, a = r.ellipsis ?? "", o = r?.ellipsisWidth ?? (a ? jt(a, ye, s).width : 0), u = s.ansiWidth ?? 0, l = s.controlWidth ?? 0, n = s.tabWidth ?? 8, c = s.ambiguousWidth ?? 1, g = s.emojiWidth ?? 2, F = s.fullWidthWidth ?? 2, p = s.regularWidth ?? 1, E = s.wideWidth ?? 2;
  let $ = 0, m = 0, h = t.length, y2 = 0, f = false, v = h, S2 = Math.max(0, i - o), I2 = 0, B2 = 0, A = 0, w = 0;
  t:
    for (;; ) {
      if (B2 > I2 || m >= h && m > $) {
        const _2 = t.slice(I2, B2) || t.slice($, m);
        y2 = 0;
        for (const D2 of _2.replaceAll(Fe, "")) {
          const T2 = D2.codePointAt(0) || 0;
          if (ge(T2) ? w = F : fe(T2) ? w = E : c !== p && pe(T2) ? w = c : w = p, A + w > S2 && (v = Math.min(v, Math.max(I2, $) + y2)), A + w > i) {
            f = true;
            break t;
          }
          y2 += D2.length, A += w;
        }
        I2 = B2 = 0;
      }
      if (m >= h)
        break;
      if (at2.lastIndex = m, at2.test(t)) {
        if (y2 = at2.lastIndex - m, w = y2 * p, A + w > S2 && (v = Math.min(v, m + Math.floor((S2 - A) / p))), A + w > i) {
          f = true;
          break;
        }
        A += w, I2 = $, B2 = m, m = $ = at2.lastIndex;
        continue;
      }
      if (At2.lastIndex = m, At2.test(t)) {
        if (A + u > S2 && (v = Math.min(v, m)), A + u > i) {
          f = true;
          break;
        }
        A += u, I2 = $, B2 = m, m = $ = At2.lastIndex;
        continue;
      }
      if (it2.lastIndex = m, it2.test(t)) {
        if (y2 = it2.lastIndex - m, w = y2 * l, A + w > S2 && (v = Math.min(v, m + Math.floor((S2 - A) / l))), A + w > i) {
          f = true;
          break;
        }
        A += w, I2 = $, B2 = m, m = $ = it2.lastIndex;
        continue;
      }
      if (nt2.lastIndex = m, nt2.test(t)) {
        if (y2 = nt2.lastIndex - m, w = y2 * n, A + w > S2 && (v = Math.min(v, m + Math.floor((S2 - A) / n))), A + w > i) {
          f = true;
          break;
        }
        A += w, I2 = $, B2 = m, m = $ = nt2.lastIndex;
        continue;
      }
      if (wt2.lastIndex = m, wt2.test(t)) {
        if (A + g > S2 && (v = Math.min(v, m)), A + g > i) {
          f = true;
          break;
        }
        A += g, I2 = $, B2 = m, m = $ = wt2.lastIndex;
        continue;
      }
      m += 1;
    }
  return { width: f ? S2 : A, index: f ? v : h, truncated: f, ellipsed: f && i >= o };
};
var Ee = { limit: 1 / 0, ellipsis: "", ellipsisWidth: 0 };
var M2 = (t, r = {}) => jt(t, Ee, r).width;
var ot2 = "\x1B";
var Gt = "";
var ve = 39;
var Ct2 = "\x07";
var kt2 = "[";
var Ae = "]";
var Vt2 = "m";
var St2 = `${Ae}8;;`;
var Ht = new RegExp(`(?:\\${kt2}(?<code>\\d+)m|\\${St2}(?<uri>.*)${Ct2})`, "y");
var we = (t) => {
  if (t >= 30 && t <= 37 || t >= 90 && t <= 97)
    return 39;
  if (t >= 40 && t <= 47 || t >= 100 && t <= 107)
    return 49;
  if (t === 1 || t === 2)
    return 22;
  if (t === 3)
    return 23;
  if (t === 4)
    return 24;
  if (t === 7)
    return 27;
  if (t === 8)
    return 28;
  if (t === 9)
    return 29;
  if (t === 0)
    return 0;
};
var Ut = (t) => `${ot2}${kt2}${t}${Vt2}`;
var Kt = (t) => `${ot2}${St2}${t}${Ct2}`;
var Ce = (t) => t.map((r) => M2(r));
var It2 = (t, r, s) => {
  const i = r[Symbol.iterator]();
  let a = false, o = false, u = t.at(-1), l = u === undefined ? 0 : M2(u), n = i.next(), c = i.next(), g = 0;
  for (;!n.done; ) {
    const F = n.value, p = M2(F);
    l + p <= s ? t[t.length - 1] += F : (t.push(F), l = 0), (F === ot2 || F === Gt) && (a = true, o = r.startsWith(St2, g + 1)), a ? o ? F === Ct2 && (a = false, o = false) : F === Vt2 && (a = false) : (l += p, l === s && !c.done && (t.push(""), l = 0)), n = c, c = i.next(), g += F.length;
  }
  u = t.at(-1), !l && u !== undefined && u.length > 0 && t.length > 1 && (t[t.length - 2] += t.pop());
};
var Se = (t) => {
  const r = t.split(" ");
  let s = r.length;
  for (;s > 0 && !(M2(r[s - 1]) > 0); )
    s--;
  return s === r.length ? t : r.slice(0, s).join(" ") + r.slice(s).join("");
};
var Ie = (t, r, s = {}) => {
  if (s.trim !== false && t.trim() === "")
    return "";
  let i = "", a, o;
  const u = t.split(" "), l = Ce(u);
  let n = [""];
  for (const [$, m] of u.entries()) {
    s.trim !== false && (n[n.length - 1] = (n.at(-1) ?? "").trimStart());
    let h = M2(n.at(-1) ?? "");
    if ($ !== 0 && (h >= r && (s.wordWrap === false || s.trim === false) && (n.push(""), h = 0), (h > 0 || s.trim === false) && (n[n.length - 1] += " ", h++)), s.hard && l[$] > r) {
      const y2 = r - h, f = 1 + Math.floor((l[$] - y2 - 1) / r);
      Math.floor((l[$] - 1) / r) < f && n.push(""), It2(n, m, r);
      continue;
    }
    if (h + l[$] > r && h > 0 && l[$] > 0) {
      if (s.wordWrap === false && h < r) {
        It2(n, m, r);
        continue;
      }
      n.push("");
    }
    if (h + l[$] > r && s.wordWrap === false) {
      It2(n, m, r);
      continue;
    }
    n[n.length - 1] += m;
  }
  s.trim !== false && (n = n.map(($) => Se($)));
  const c = n.join(`
`), g = c[Symbol.iterator]();
  let F = g.next(), p = g.next(), E = 0;
  for (;!F.done; ) {
    const $ = F.value, m = p.value;
    if (i += $, $ === ot2 || $ === Gt) {
      Ht.lastIndex = E + 1;
      const f = Ht.exec(c)?.groups;
      if (f?.code !== undefined) {
        const v = Number.parseFloat(f.code);
        a = v === ve ? undefined : v;
      } else
        f?.uri !== undefined && (o = f.uri.length === 0 ? undefined : f.uri);
    }
    const h = a ? we(a) : undefined;
    m === `
` ? (o && (i += Kt("")), a && h && (i += Ut(h))) : $ === `
` && (a && h && (i += Ut(a)), o && (i += Kt(o))), E += $.length, F = p, p = g.next();
  }
  return i;
};
function J2(t, r, s) {
  return String(t).normalize().replaceAll(`\r
`, `
`).split(`
`).map((i) => Ie(i, r, s)).join(`
`);
}
var Re = (t) => {
  const r = t.active ?? "Yes", s = t.inactive ?? "No";
  return new kt({ active: r, inactive: s, signal: t.signal, input: t.input, output: t.output, initialValue: t.initialValue ?? true, render() {
    const i = t.withGuide ?? _.withGuide, a = `${i ? `${import_picocolors2.default.gray(d)}
` : ""}${W2(this.state)}  ${t.message}
`, o = this.value ? r : s;
    switch (this.state) {
      case "submit": {
        const u = i ? `${import_picocolors2.default.gray(d)}  ` : "";
        return `${a}${u}${import_picocolors2.default.dim(o)}`;
      }
      case "cancel": {
        const u = i ? `${import_picocolors2.default.gray(d)}  ` : "";
        return `${a}${u}${import_picocolors2.default.strikethrough(import_picocolors2.default.dim(o))}${i ? `
${import_picocolors2.default.gray(d)}` : ""}`;
      }
      default: {
        const u = i ? `${import_picocolors2.default.cyan(d)}  ` : "", l = i ? import_picocolors2.default.cyan(x2) : "";
        return `${a}${u}${this.value ? `${import_picocolors2.default.green(Q2)} ${r}` : `${import_picocolors2.default.dim(H2)} ${import_picocolors2.default.dim(r)}`}${t.vertical ? i ? `
${import_picocolors2.default.cyan(d)}  ` : `
` : ` ${import_picocolors2.default.dim("/")} `}${this.value ? `${import_picocolors2.default.dim(H2)} ${import_picocolors2.default.dim(s)}` : `${import_picocolors2.default.green(Q2)} ${s}`}
${l}
`;
      }
    }
  } }).prompt();
};
var R2 = { message: (t = [], { symbol: r = import_picocolors2.default.gray(d), secondarySymbol: s = import_picocolors2.default.gray(d), output: i = process.stdout, spacing: a = 1, withGuide: o } = {}) => {
  const u = [], l = o ?? _.withGuide, n = l ? s : "", c = l ? `${r}  ` : "", g = l ? `${s}  ` : "";
  for (let p = 0;p < a; p++)
    u.push(n);
  const F = Array.isArray(t) ? t : t.split(`
`);
  if (F.length > 0) {
    const [p, ...E] = F;
    p.length > 0 ? u.push(`${c}${p}`) : u.push(l ? r : "");
    for (const $ of E)
      $.length > 0 ? u.push(`${g}${$}`) : u.push(l ? s : "");
  }
  i.write(`${u.join(`
`)}
`);
}, info: (t, r) => {
  R2.message(t, { ...r, symbol: import_picocolors2.default.blue(ft2) });
}, success: (t, r) => {
  R2.message(t, { ...r, symbol: import_picocolors2.default.green(Ft2) });
}, step: (t, r) => {
  R2.message(t, { ...r, symbol: import_picocolors2.default.green(V) });
}, warn: (t, r) => {
  R2.message(t, { ...r, symbol: import_picocolors2.default.yellow(yt2) });
}, warning: (t, r) => {
  R2.warn(t, r);
}, error: (t, r) => {
  R2.message(t, { ...r, symbol: import_picocolors2.default.red(Et2) });
} };
var We = (t = "", r) => {
  (r?.output ?? process.stdout).write(`${import_picocolors2.default.gray(ht2)}  ${t}
`);
};
var Le = (t = "", r) => {
  (r?.output ?? process.stdout).write(`${import_picocolors2.default.gray(d)}
${import_picocolors2.default.gray(x2)}  ${t}

`);
};
var Ge = (t) => import_picocolors2.default.dim(t);
var ke = (t, r, s) => {
  const i = { hard: true, trim: false }, a = J2(t, r, i).split(`
`), o = a.reduce((n, c) => Math.max(M2(c), n), 0), u = a.map(s).reduce((n, c) => Math.max(M2(c), n), 0), l = r - (u - o);
  return J2(t, l, i);
};
var Ve = (t = "", r = "", s) => {
  const i = s?.output ?? N2.stdout, a = s?.withGuide ?? _.withGuide, o = s?.format ?? Ge, u = ["", ...ke(t, rt(i) - 6, o).split(`
`).map(o), ""], l = M2(r), n = Math.max(u.reduce((p, E) => {
    const $ = M2(E);
    return $ > p ? $ : p;
  }, 0), l) + 2, c = u.map((p) => `${import_picocolors2.default.gray(d)}  ${p}${" ".repeat(n - M2(p))}${import_picocolors2.default.gray(d)}`).join(`
`), g = a ? `${import_picocolors2.default.gray(d)}
` : "", F = a ? Wt2 : gt2;
  i.write(`${g}${import_picocolors2.default.green(V)}  ${import_picocolors2.default.reset(r)} ${import_picocolors2.default.gray(rt2.repeat(Math.max(n - l - 1, 1)) + mt2)}
${c}
${import_picocolors2.default.gray(F + rt2.repeat(n + 2) + pt2)}
`);
};
var Ke = import_picocolors2.default.magenta;
var bt2 = ({ indicator: t = "dots", onCancel: r, output: s = process.stdout, cancelMessage: i, errorMessage: a, frames: o = et2 ? ["◒", "◐", "◓", "◑"] : ["•", "o", "O", "0"], delay: u = et2 ? 80 : 120, signal: l, ...n } = {}) => {
  const c = ct2();
  let g, F, p = false, E = false, $ = "", m, h = performance.now();
  const y2 = rt(s), f = n?.styleFrame ?? Ke, v = (b) => {
    const O2 = b > 1 ? a ?? _.messages.error : i ?? _.messages.cancel;
    E = b === 1, p && (L2(O2, b), E && typeof r == "function" && r());
  }, S2 = () => v(2), I2 = () => v(1), B2 = () => {
    process.on("uncaughtExceptionMonitor", S2), process.on("unhandledRejection", S2), process.on("SIGINT", I2), process.on("SIGTERM", I2), process.on("exit", v), l && l.addEventListener("abort", I2);
  }, A = () => {
    process.removeListener("uncaughtExceptionMonitor", S2), process.removeListener("unhandledRejection", S2), process.removeListener("SIGINT", I2), process.removeListener("SIGTERM", I2), process.removeListener("exit", v), l && l.removeEventListener("abort", I2);
  }, w = () => {
    if (m === undefined)
      return;
    c && s.write(`
`);
    const b = J2(m, y2, { hard: true, trim: false }).split(`
`);
    b.length > 1 && s.write(import_sisteransi2.cursor.up(b.length - 1)), s.write(import_sisteransi2.cursor.to(0)), s.write(import_sisteransi2.erase.down());
  }, _2 = (b) => b.replace(/\.+$/, ""), D2 = (b) => {
    const O2 = (performance.now() - b) / 1000, j2 = Math.floor(O2 / 60), G2 = Math.floor(O2 % 60);
    return j2 > 0 ? `[${j2}m ${G2}s]` : `[${G2}s]`;
  }, T2 = n.withGuide ?? _.withGuide, Y = (b = "") => {
    p = true, g = Bt({ output: s }), $ = _2(b), h = performance.now(), T2 && s.write(`${import_picocolors2.default.gray(d)}
`);
    let O2 = 0, j2 = 0;
    B2(), F = setInterval(() => {
      if (c && $ === m)
        return;
      w(), m = $;
      const G2 = f(o[O2]);
      let tt2;
      if (c)
        tt2 = `${G2}  ${$}...`;
      else if (t === "timer")
        tt2 = `${G2}  ${$} ${D2(h)}`;
      else {
        const te = ".".repeat(Math.floor(j2)).slice(0, 3);
        tt2 = `${G2}  ${$}${te}`;
      }
      const Zt = J2(tt2, y2, { hard: true, trim: false });
      s.write(Zt), O2 = O2 + 1 < o.length ? O2 + 1 : 0, j2 = j2 < 4 ? j2 + 0.125 : 0;
    }, u);
  }, L2 = (b = "", O2 = 0, j2 = false) => {
    if (!p)
      return;
    p = false, clearInterval(F), w();
    const G2 = O2 === 0 ? import_picocolors2.default.green(V) : O2 === 1 ? import_picocolors2.default.red(dt2) : import_picocolors2.default.red($t2);
    $ = b ?? $, j2 || (t === "timer" ? s.write(`${G2}  ${$} ${D2(h)}
`) : s.write(`${G2}  ${$}
`)), A(), g();
  };
  return { start: Y, stop: (b = "") => L2(b, 0), message: (b = "") => {
    $ = _2(b ?? $);
  }, cancel: (b = "") => L2(b, 1), error: (b = "") => L2(b, 2), clear: () => L2("", 0, true), get isCancelled() {
    return E;
  } };
};
var zt = { light: C("─", "-"), heavy: C("━", "="), block: C("█", "#") };
var Qt = `${import_picocolors2.default.gray(d)}  `;

// node_modules/commander/esm.mjs
var import__ = __toESM(require_commander(), 1);
var {
  program,
  createCommand,
  createArgument,
  createOption,
  CommanderError,
  InvalidArgumentError,
  InvalidOptionArgumentError,
  Command,
  Argument,
  Option,
  Help
} = import__.default;

// src/apps/agenthive-cli.ts
var import_picocolors3 = __toESM(require_picocolors(), 1);
var __filename2 = fileURLToPath(import.meta.url);
var __dirname2 = dirname(__filename2);
function resolveProjectRoot() {
  for (const start of [process.cwd(), __dirname2]) {
    let dir = resolve(start);
    while (dir !== "/") {
      try {
        const pkg = JSON.parse(readFileSync(join2(dir, "package.json"), "utf-8"));
        if (pkg.name === "agentRoadmap")
          return dir;
      } catch {}
      const parent = dirname(dir);
      if (parent === dir)
        break;
      dir = parent;
    }
  }
  return resolve(__dirname2, "../..");
}
var PROJECT_ROOT = resolveProjectRoot();
var WORKTREE_ROOT = resolve(PROJECT_ROOT, "../worktree");
var SYSTEMD_SERVICE_NAME = "agenthive-orchestrator";
var SYSTEMD_SERVICE_PATH = `/etc/systemd/system/${SYSTEMD_SERVICE_NAME}.service`;
var ENV_FILE_PATH = "/etc/agenthive/env";
var AGENTHIVE_USER = "agenthive";
var AGENTHIVE_HOME = "/var/lib/agenthive";
function die(msg) {
  R2.error(msg);
  process.exit(1);
}
function run(cmd, opts) {
  try {
    return execSync(cmd.join(" "), {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      ...opts
    }).trim();
  } catch (err) {
    throw new Error(`${cmd.join(" ")} failed: ${err.stderr || err.message}`);
  }
}
function sudo(cmd, opts) {
  return run(["sudo", ...cmd], opts);
}
function sudoSpawn(cmd, opts) {
  return new Promise((resolve2, reject) => {
    const child = spawn("sudo", cmd, {
      stdio: "inherit",
      shell: false,
      ...opts
    });
    child.on("exit", (code) => resolve2(code ?? 1));
    child.on("error", reject);
  });
}
function checkSudo() {
  try {
    run(["sudo", "-n", "true"]);
    return true;
  } catch {
    return false;
  }
}
async function cmdInit() {
  We(import_picocolors3.default.bgCyan(import_picocolors3.default.black(" AgentHive System Init ")));
  if (process.platform !== "linux") {
    die("AgentHive system init currently supports Linux only.");
  }
  const isRoot = userInfo().uid === 0;
  if (isRoot) {
    die("Do not run init as root. Run as a regular user with sudo access.");
  }
  const hasSudo = checkSudo();
  if (!hasSudo) {
    R2.warn("Passwordless sudo not detected. You will be prompted for your password.");
  }
  const confirmed = await Re({
    message: "This will create the agenthive system user, install systemd services, and configure the host. Continue?",
    initialValue: true
  });
  if (Ct(confirmed) || !confirmed) {
    Le("Aborted.");
    return;
  }
  const s = bt2();
  s.start("Creating agenthive system user...");
  try {
    sudo(["id", AGENTHIVE_USER]);
    s.stop("agenthive user already exists.");
  } catch {
    try {
      sudo([
        "useradd",
        "-r",
        "-m",
        "-s",
        "/bin/bash",
        "-d",
        AGENTHIVE_HOME,
        "-U",
        AGENTHIVE_USER
      ]);
      s.stop("Created agenthive user.");
    } catch (e2) {
      s.stop("Failed to create agenthive user.");
      throw e2;
    }
  }
  s.start("Configuring group memberships...");
  try {
    sudo(["usermod", "-aG", "dev", AGENTHIVE_USER]);
  } catch {}
  s.stop("Group memberships configured.");
  s.start("Installing Hermes CLI for agenthive...");
  try {
    const xiaomiHome = process.env.XIAOMI_HOME || "/home/xiaomi";
    try {
      const xiaomiHermes = `${xiaomiHome}/.local/bin/hermes`;
      await access(xiaomiHermes, constants.X_OK);
      const agenthiveBin = `${AGENTHIVE_HOME}/.local/bin`;
      sudo(["mkdir", "-p", agenthiveBin]);
      sudo(["ln", "-sf", xiaomiHermes, `${agenthiveBin}/hermes`]);
      sudo(["ln", "-sf", `${xiaomiHome}/.hermes`, `${AGENTHIVE_HOME}/.hermes`]);
      sudo(["chmod", "750", `${xiaomiHome}/.hermes`]);
      sudo(["chgrp", "-R", "dev", `${xiaomiHome}/.hermes`]);
      sudo(["chmod", "-R", "g+rX", `${xiaomiHome}/.hermes`]);
      s.stop("Linked Hermes from xiaomi installation.");
    } catch {
      sudo(["-u", AGENTHIVE_USER, "pip", "install", "--user", "hermes-agent"]);
      s.stop("Installed Hermes fresh for agenthive.");
    }
  } catch (e2) {
    s.stop("Hermes install failed.");
    throw e2;
  }
  s.start("Creating environment file...");
  try {
    await access(ENV_FILE_PATH);
    s.stop("Environment file already exists.");
  } catch {
    const envContent = `# AgentHive system environment
# This file is sourced by the systemd service.
# Edit to customize database credentials, API keys, etc.

PGHOST=127.0.0.1
PGPORT=5432
PGUSER=agenthive
PG_DATABASE=agenthive
PG_SCHEMA=roadmap
`;
    try {
      sudo(["mkdir", "-p", "/etc/agenthive"]);
      const tmpPath = `/tmp/agenthive-env-${Date.now()}`;
      await writeFile2(tmpPath, envContent, { mode: 416 });
      sudo(["cp", tmpPath, ENV_FILE_PATH]);
      sudo(["chmod", "640", ENV_FILE_PATH]);
      sudo(["chown", `root:dev`, ENV_FILE_PATH]);
    } catch (e2) {
      s.stop("Failed to write env file.");
      throw e2;
    }
    s.stop("Created environment file.");
  }
  s.start("Installing systemd service...");
  const serviceContent = `[Unit]
Description=AgentHive Orchestrator (event-driven agent dispatcher)
After=network.target postgresql.service agenthive-mcp.service
Requires=agenthive-mcp.service

[Service]
Type=simple
User=${AGENTHIVE_USER}
Group=${AGENTHIVE_USER}
WorkingDirectory=/data/code/AgentHive
EnvironmentFile=${ENV_FILE_PATH}
Environment=NODE_ENV=production
Environment=PATH=${AGENTHIVE_HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=${AGENTHIVE_HOME}
Environment=PROJECT_ROOT=/data/code/AgentHive
Environment=AGENTHIVE_ORCHESTRATOR_POLL=1
ExecStart=/usr/local/bin/bun scripts/orchestrator.ts
Restart=on-failure
RestartSec=10
TimeoutStopSec=300
KillSignal=SIGTERM
MemoryMax=512M
CPUQuota=50%
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SYSTEMD_SERVICE_NAME}

[Install]
WantedBy=multi-user.target
`;
  try {
    const tmpService = `/tmp/${SYSTEMD_SERVICE_NAME}.service`;
    await writeFile2(tmpService, serviceContent);
    sudo(["cp", tmpService, SYSTEMD_SERVICE_PATH]);
    sudo(["chmod", "644", SYSTEMD_SERVICE_PATH]);
    s.stop("Installed systemd service.");
  } catch (e2) {
    s.stop("Failed to install systemd service.");
    throw e2;
  }
  s.start("Setting filesystem permissions...");
  try {
    sudo(["mkdir", "-p", WORKTREE_ROOT]);
    sudo(["chown", ":dev", WORKTREE_ROOT]);
    sudo(["chmod", "g+srwx", WORKTREE_ROOT]);
    sudo(["chown", "-R", ":dev", PROJECT_ROOT]);
    sudo(["chmod", "-R", "g+srX", PROJECT_ROOT]);
    s.stop("Filesystem permissions set.");
  } catch (e2) {
    s.stop("Permission setup failed.");
    throw e2;
  }
  s.start("Reloading systemd...");
  try {
    sudo(["systemctl", "daemon-reload"]);
    s.stop("Systemd reloaded.");
  } catch (e2) {
    s.stop("systemctl daemon-reload failed.");
    throw e2;
  }
  R2.info("The orchestrator requires a PostgreSQL database.");
  const setupDb = await Re({
    message: "Have you initialized the AgentHive database? (run psql -f database/migrations/*.sql)",
    initialValue: false
  });
  if (Ct(setupDb) || !setupDb) {
    R2.warn("Remember to run the migration files in database/migrations/ before starting the service.");
  }
  Ve(`Service: ${SYSTEMD_SERVICE_NAME}
` + `User:    ${AGENTHIVE_USER}
` + `Home:    ${AGENTHIVE_HOME}
` + `Env:     ${ENV_FILE_PATH}
` + `
Start with:  sudo systemctl start ${SYSTEMD_SERVICE_NAME}
` + `Status:      sudo systemctl status ${SYSTEMD_SERVICE_NAME}
` + `Logs:        sudo journalctl -u ${SYSTEMD_SERVICE_NAME} -f`, "Next steps");
  Le("AgentHive system initialized.");
}
async function cmdStatus() {
  try {
    const out = run([
      "systemctl",
      "status",
      SYSTEMD_SERVICE_NAME,
      "--no-pager"
    ]);
    console.log(out);
  } catch (e2) {
    console.log(import_picocolors3.default.yellow("Service is not running or not installed."));
    console.log(import_picocolors3.default.dim(e2.message));
  }
}
async function cmdStart() {
  bt2().start("Starting orchestrator...");
  try {
    sudo(["systemctl", "start", SYSTEMD_SERVICE_NAME]);
    Le("Orchestrator started.");
  } catch (e2) {
    Le(`Failed to start: ${e2.message}`);
    process.exit(1);
  }
}
async function cmdStop() {
  bt2().start("Stopping orchestrator...");
  try {
    sudo(["systemctl", "stop", SYSTEMD_SERVICE_NAME]);
    Le("Orchestrator stopped.");
  } catch (e2) {
    Le(`Failed to stop: ${e2.message}`);
    process.exit(1);
  }
}
async function cmdRestart() {
  bt2().start("Restarting orchestrator...");
  try {
    sudo(["systemctl", "restart", SYSTEMD_SERVICE_NAME]);
    Le("Orchestrator restarted.");
  } catch (e2) {
    Le(`Failed to restart: ${e2.message}`);
    process.exit(1);
  }
}
async function cmdLogs() {
  await sudoSpawn([
    "journalctl",
    "-u",
    SYSTEMD_SERVICE_NAME,
    "-f",
    "--no-pager"
  ]);
}
async function cmdDbPing(target) {
  const targets = target === "all" ? ["postgres", "pgbouncer"] : [target];
  for (const t of targets) {
    if (t === "pgbouncer") {
      const host = process.env.PGBOUNCER_HOST ?? "127.0.0.1";
      const port = Number(process.env.PGBOUNCER_PORT ?? process.env.PGPORT ?? 6432);
      const user = process.env.PGBOUNCER_ADMIN_USER ?? process.env.PGUSER ?? "agenthive";
      R2.info(`Pinging PgBouncer at ${host}:${port} (user: ${user})…`);
      const start = Date.now();
      try {
        const out = run([
          "psql",
          `-h`,
          host,
          `-p`,
          String(port),
          `-U`,
          user,
          `pgbouncer`,
          `-c`,
          `SHOW VERSION`,
          `-t`,
          `-A`
        ]);
        const ms = Date.now() - start;
        R2.success(`PgBouncer OK — ${out.trim()} (${ms}ms)`);
      } catch (e2) {
        R2.error(`PgBouncer UNREACHABLE at ${host}:${port} — ${e2.message}`);
        process.exitCode = 1;
      }
    } else if (t === "postgres") {
      const host = process.env.PGHOST ?? "127.0.0.1";
      const port = Number(process.env.PGPORT_DIRECT ?? process.env.PGPORT ?? 5432);
      const user = process.env.PGUSER ?? "agenthive";
      R2.info(`Pinging PostgreSQL at ${host}:${port} (user: ${user})…`);
      const start = Date.now();
      try {
        run([
          "psql",
          `-h`,
          host,
          `-p`,
          String(port),
          `-U`,
          user,
          `-c`,
          `SELECT 1`,
          `-t`,
          `-A`
        ]);
        const ms = Date.now() - start;
        R2.success(`PostgreSQL OK (${ms}ms)`);
      } catch (e2) {
        R2.error(`PostgreSQL UNREACHABLE at ${host}:${port} — ${e2.message}`);
        process.exitCode = 1;
      }
    } else {
      R2.error(`Unknown target '${t}'. Use: postgres | pgbouncer | all`);
      process.exitCode = 1;
    }
  }
}
async function cmdConfigSet(opts) {
  const keyName = opts.key?.trim();
  const operatorId = opts.operatorId?.trim();
  if (!keyName) {
    R2.error("--key is required.");
    process.exitCode = 1;
    return;
  }
  if (opts.value === undefined) {
    R2.error("--value is required.");
    process.exitCode = 1;
    return;
  }
  if (!operatorId) {
    R2.error("--operator-id is required (control_identity.principal id of the operator).");
    process.exitCode = 1;
    return;
  }
  const { agentContextStorage: agentContextStorage2 } = await Promise.resolve().then(() => (init_agent_context(), exports_agent_context));
  const { getConfigKeyByName: getConfigKeyByName2 } = await Promise.resolve().then(() => (init_config_keys(), exports_config_keys));
  const { initConfigFromControlPool: initConfigFromControlPool2, set: configSet } = await Promise.resolve().then(() => (init_config(), exports_config));
  let key;
  try {
    key = getConfigKeyByName2(keyName);
  } catch (e2) {
    R2.error(e2?.message ?? String(e2));
    process.exitCode = 1;
    return;
  }
  let parsed;
  try {
    parsed = key.parse(opts.value);
  } catch (e2) {
    R2.error(`Invalid --value for ${keyName}: ${e2?.message ?? e2}`);
    process.exitCode = 1;
    return;
  }
  try {
    await initConfigFromControlPool2();
  } catch (e2) {
    R2.error(`Control-plane pool init failed: ${e2?.message ?? e2}`);
    process.exitCode = 1;
    return;
  }
  await agentContextStorage2.run({
    verified: {
      principal_id: operatorId,
      principal_kind: "operator",
      parent_principal_id: null
    }
  }, async () => {
    try {
      await configSet(key, parsed);
      R2.success(`config set: ${keyName} = ${opts.value} (operator ${operatorId})`);
    } catch (e2) {
      R2.error(`config set failed: ${e2?.message ?? e2}`);
      process.exitCode = 1;
    }
  });
}
var program2 = new Command("agenthive").description("AgentHive system administration CLI").version("0.1.0");
program2.command("init").description("One-time system setup (creates user, service, env file)").action(cmdInit);
program2.command("status").description("Check orchestrator service status").action(cmdStatus);
program2.command("start").description("Start the orchestrator service").action(cmdStart);
program2.command("stop").description("Stop the orchestrator service").action(cmdStop);
program2.command("restart").description("Restart the orchestrator service").action(cmdRestart);
program2.command("logs").description("Tail orchestrator logs").action(cmdLogs);
program2.command("db-ping").description("Ping a database endpoint: postgres | pgbouncer | all").argument("[target]", "postgres | pgbouncer | all", "all").action(cmdDbPing);
var configCmd = program2.command("config").description("Runtime config administration");
configCmd.command("set").description("Set a runtime config key via the audited ConfigResolver.set() path").requiredOption("--key <key>", "Config key name (e.g. USE_OFFER_DISPATCH)").requiredOption("--value <value>", "New value (parsed by the key's parser)").requiredOption("--operator-id <id>", "Operator's control_identity.principal id (audit FK)").action((opts) => cmdConfigSet(opts));
program2.parse();
