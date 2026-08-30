#!/usr/bin/env node

import { evaluate, format, parse } from "mathjs";
import { createInterface } from "node:readline";

const functions = new Set([
  "abs", "acos", "acosh", "asin", "asinh", "atan", "atan2", "atanh",
  "cbrt", "ceil", "combinations", "cos", "cosh", "exp", "factorial",
  "floor", "gcd", "hypot", "lcm", "log", "log10", "log2", "max", "mean",
  "median", "min", "mod", "permutations", "pow", "round", "sign", "sin",
  "sinh", "sqrt", "std", "sum", "tan", "tanh", "variance",
]);
const constants = new Set(["e", "pi", "tau", "phi"]);
const aggregateFunctions = new Set(["max", "mean", "median", "min", "std", "sum", "variance"]);

function literalNumber(node) {
  if (!node) return null;
  if (node.type === "ConstantNode") {
    const value = Number(node.value);
    return Number.isFinite(value) ? value : null;
  }
  if (node.type === "ParenthesisNode") return literalNumber(node.content);
  if (node.type === "OperatorNode" && node.args?.length === 1
      && (node.op === "+" || node.op === "-")) {
    const value = literalNumber(node.args[0]);
    return value === null ? null : (node.op === "-" ? -value : value);
  }
  return null;
}

function resourceSafe(tree) {
  let safe = true;
  let nodes = 0;
  tree.traverse((node) => {
    if (!safe || ++nodes > 120) { safe = false; return; }
    if (node.type === "ConstantNode") {
      const value = Number(node.value);
      if (!Number.isFinite(value) || Math.abs(value) > 1e15) safe = false;
      return;
    }
    if (node.type === "OperatorNode" && (node.op === "^" || node.op === "**")) {
      const exponent = literalNumber(node.args?.[1]);
      if (exponent === null || Math.abs(exponent) > 10_000) safe = false;
      return;
    }
    if (node.type !== "FunctionNode") return;
    const args = node.args || [];
    if (args.length > 200 || (aggregateFunctions.has(node.name) && args.length > 200)) {
      safe = false; return;
    }
    if (node.name === "factorial") {
      const n = literalNumber(args[0]);
      if (n === null || !Number.isInteger(n) || n < 0 || n > 1000) safe = false;
    } else if (node.name === "combinations" || node.name === "permutations") {
      const n = literalNumber(args[0]);
      const k = literalNumber(args[1]);
      if (n === null || k === null || !Number.isInteger(n) || !Number.isInteger(k)
          || n < 0 || n > 1000 || k < 0 || k > n) safe = false;
    } else if (["exp", "cosh", "sinh", "tanh"].includes(node.name)) {
      const n = literalNumber(args[0]);
      if (n === null || Math.abs(n) > 1000) safe = false;
    } else if (node.name === "pow") {
      const exponent = literalNumber(args[1]);
      if (exponent === null || Math.abs(exponent) > 10_000) safe = false;
    }
  });
  return safe;
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function normalizeUnit(unit) {
  const value = unit.trim();
  if (/^[fF]$/.test(value)) return "degF";
  if (/^[cC]$/.test(value)) return "degC";
  return value;
}

function commandExpression(text) {
  const match = text.match(/^\s*(sum|add|total|average|avg|mean|product)\s+(.+?)\s*[?.!]*\s*$/i);
  if (!match) return null;
  const values = match[2].match(/[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[-+]?\d+)?/gi) || [];
  if (values.length < 2) return null;
  // Reject leftover prose rather than silently ignoring it.
  const residue = match[2]
    .replace(/[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[-+]?\d+)?/gi, "")
    .replace(/[\s,;]+/g, "");
  if (residue !== "") return null;
  const command = match[1].toLowerCase();
  if (command === "product") return `prod(${values.join(", ")})`;
  if (command === "average" || command === "avg" || command === "mean")
    return `mean(${values.join(", ")})`;
  return `sum(${values.join(", ")})`;
}

function conversionExpression(text) {
  const number = "[-+]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:e[-+]?\\d+)?";
  const unit = "[A-Za-z°µμ][A-Za-z0-9°µμ]*(?:\\s*[/^*-]\\s*[A-Za-z0-9°µμ]+)*";
  const pattern = new RegExp(`(${number})\\s+(${unit})\\s+(?:to|in|as)\\s+(${unit})`, "i");
  const match = text.match(pattern);
  if (!match) return null;
  return `${match[1]} ${normalizeUnit(match[2])} to ${normalizeUnit(match[3])}`;
}

function arithmeticExpression(text) {
  const number = "(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:e[-+]?\\d+)?";
  const atom = `(?:[-+]?${number}|\\([^()]+\\))`;
  const chain = new RegExp(`${atom}(?:\\s*(?:\\+|-|\\*{1,2}|/|\\^|%)\\s*${atom})+`, "gi");
  const matches = text.match(chain) || [];
  if (matches.length > 0) return matches.sort((a, b) => b.length - a.length)[0].replace(/=\s*$/, "");

  const names = Array.from(functions).sort((a, b) => b.length - a.length).join("|");
  const call = new RegExp(`\\b(?:${names})\\s*\\([^()]*\\)`, "i");
  const functionMatch = text.match(call);
  return functionMatch ? functionMatch[0] : null;
}

function safeExpression(expression, conversion) {
  let safe = true;
  const tree = parse(expression);
  tree.traverse((node, path, parent) => {
    if (!safe) return;
    if (node.type === "ConstantNode" || node.type === "OperatorNode"
        || node.type === "ParenthesisNode") return;
    if (node.type === "FunctionNode") {
      if (!functions.has(node.name)) safe = false;
      return;
    }
    if (node.type === "SymbolNode") {
      if (parent && parent.type === "FunctionNode" && parent.fn === node) return;
      if (!conversion && !constants.has(node.name)) safe = false;
      return;
    }
    safe = false;
  });
  return safe;
}

function calculate(input) {
  const text = String(input || "").trim();
  if (text === "" || text.length > 500) return null;
  const command = commandExpression(text);
  const conversion = command ? null : conversionExpression(text);
  const normalizedText = text.replace(/(\d+(?:\.\d+)?)%(?!\s*\d)/g, "($1 / 100)");
  let expression = command || conversion || arithmeticExpression(normalizedText);
  if (!expression) return null;
  // A postfix percent means percentage in calculator prose; a percent between
  // two values remains mathjs modulo.
  expression = expression.replace(/(\d+(?:\.\d+)?)%(?!\s*\d)/g, "($1 / 100)");
  try {
    const tree = parse(expression);
    if (!safeExpression(expression, Boolean(conversion)) || !resourceSafe(tree)) return null;
    const value = evaluate(expression, new Map());
    const answer = format(value, { precision: 14 });
    if ((typeof value === "number" && !Number.isFinite(value))
        || !answer || /^(?:NaN|-?Infinity)$/.test(answer) || answer.length > 240) return null;
    const display = tree.toString({ parenthesis: "auto" });
    return { expression: display, answer };
  } catch {
    return null;
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const query = String(message.query || "");
  emit({ id: message.id, query, result: calculate(query) });
});
