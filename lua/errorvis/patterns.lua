--- patterns.lua — port of classifyLine() and all regex constants from src/resultFinder.ts
---
--- Exports:
---   M.classify_line(line_text, symbol) → HandlingKind | nil
---   M.kind_label(kind) → string

local M = {}

--- Escape a symbol name for safe embedding in a Vim \v regex pattern.
--- In \v mode every non-alphanumeric/underscore char is special; backslash before
--- a special char makes it literal.
local function regex_escape(sym)
  return (sym:gsub('([.+*?^${}%(%)%[%]|\\/<>])', '\\%1'))
end

--- Returns true when the Vim regex pattern matches anywhere in line.
local function vmatch(line, pat)
  return vim.fn.match(line, pat) >= 0
end

--- Build a pattern from a template by substituting 'SYMBOL' with the escaped symbol.
local function build(tplt, sym)
  return (tplt:gsub('SYMBOL', regex_escape(sym)))
end

-- ─────────────────────────────────────────────────────────────────────────────
-- Pattern templates in Vim \v (very magic) regex.
-- SYMBOL is substituted at runtime via build().
-- Mirror of the constants in src/resultFinder.ts:46-104.
-- ─────────────────────────────────────────────────────────────────────────────

-- Optional call suffix: matches (arg) with no nested parens.
-- JS: (?:\([^()]*(?:\([^()]*\)[^()]*)*\))?   (one level of nesting)
-- Simplified to flat: %(\([^)]*\))?
local CALL_SUFFIX = [[%(\([^)]*\))?]]

-- Optional path prefix: module::sub:: or self.field. etc.
-- JS: (?:(?:\w+)(?:::|\.))+ made optional at use-site
local PATH_PREFIX = [[%(\w+%(::|\.))+]]

-- ── question_mark ─────────────────────────────────────────────────────────────
-- JS: \b(SYMBOL)CALL_SUFFIX\s*\?
-- Matches: foo?, foo(x)?, foo(a,b)?
local QM_TPLT = [[\v<SYMBOL>]] .. CALL_SUFFIX .. [[\s*[?]]]

-- ── return (explicit) ────────────────────────────────────────────────────────
-- JS: \breturn\s+(?:PATH_PREFIX)?\*{0,2}\s*(SYMBOL)CALL_SUFFIX\s*;?
-- Matches: return foo;  return *foo  return mod::foo
local RET_TPLT = [[\v<return>\s+%(]] .. PATH_PREFIX .. [[)?\**\s*<SYMBOL>]] .. CALL_SUFFIX .. [[\s*;?]]

-- ── return (bare last expression) ────────────────────────────────────────────
-- JS: ^\s*(?:PATH_PREFIX)?\*{0,2}\s*(SYMBOL)CALL_SUFFIX\s*$
-- Matches lines that ARE just the return value: foo  *foo  mod::foo(x)
local DRET_TPLT = [[\v^\s*%(\w+%(::|\.))*\**\s*<SYMBOL>]] .. CALL_SUFFIX .. [[\s*$]]

-- ── match ────────────────────────────────────────────────────────────────────
-- JS: \bmatch\s+(?:PATH_PREFIX)?\*{0,2}\s*(SYMBOL)\bCALL_SUFFIX
-- Matches: match foo  match *foo  match self.foo
local MATCH_TPLT = [[\v<match>\s+.{-}\**\s*<SYMBOL>]]

-- ── if let ───────────────────────────────────────────────────────────────────
-- JS: \bif\s+let\s+(?:Ok|Err|Some|None)\s*(?:\([^)]*\))?\s*=\s*...*?\s*(SYMBOL)
local IF_LET_TPLT = [[\v<if>\s+<let>\s+%(Ok|Err|Some|None)\s*%([^)]*\))?\s*=\s*.{-}<SYMBOL>]]

-- ── while let ────────────────────────────────────────────────────────────────
local WHILE_LET_TPLT = [[\v<while>\s+<let>\s+%(Ok|Err|Some|None)\s*%([^)]*\))?\s*=\s*.{-}<SYMBOL>]]

-- ── method chain: unwrap ─────────────────────────────────────────────────────
-- JS: \b(SYMBOL)CALL_SUFFIX\s*\.\s*unwrap\s*[(;\s,]
local UNWRAP_TPLT    = [[\v<SYMBOL>]] .. CALL_SUFFIX .. [[\s*\.\s*unwrap\s*\(]]

-- ── method chain: expect ─────────────────────────────────────────────────────
local EXPECT_TPLT    = [[\v<SYMBOL>]] .. CALL_SUFFIX .. [[\s*\.\s*expect\s*\(]]

-- ── method chain: unwrap_or* ─────────────────────────────────────────────────
-- JS: unwrap_or(?:_else|_default)?
local UNWRAP_OR_TPLT = [[\v<SYMBOL>]] .. CALL_SUFFIX .. [[\s*\.\s*unwrap_or%(_%(else|default))?\s*\(]]

-- ── method chain: is_ok / is_err ─────────────────────────────────────────────
local CHECK_TPLT     = [[\v<SYMBOL>]] .. CALL_SUFFIX .. [[\s*\.\s*is_%(ok|err)\s*\(]]

-- ── method chain: map combinators ────────────────────────────────────────────
-- JS: map|and_then|or(?:_else)?|ok|err|map_err|flatten|transpose
local MAP_TPLT = [[\v<SYMBOL>]] .. CALL_SUFFIX
  .. [[\s*\.\s*%(map|and_then|or%(_else)?|ok|err|map_err|flatten|transpose)\s*\(]]

-- ─────────────────────────────────────────────────────────────────────────────
-- Public API
-- ─────────────────────────────────────────────────────────────────────────────

--- Classify a line of Rust source code by how it handles `symbol`.
---
--- Tests patterns in priority order matching classifyLine() in
--- src/resultFinder.ts:73-104.
---
--- @param line_text string  raw source line
--- @param symbol    string  Rust identifier to look for
--- @return string|nil  HandlingKind or nil when no pattern matches
function M.classify_line(line_text, symbol)
  if vmatch(line_text, build(QM_TPLT,        symbol)) then return 'question_mark'  end
  if vmatch(line_text, build(RET_TPLT,       symbol)) then return 'return'         end
  if vmatch(line_text, build(DRET_TPLT,      symbol)) then return 'return'         end
  if vmatch(line_text, build(MATCH_TPLT,     symbol)) then return 'match'          end
  if vmatch(line_text, build(IF_LET_TPLT,    symbol)) then return 'if_let'         end
  if vmatch(line_text, build(WHILE_LET_TPLT, symbol)) then return 'while_let'      end
  if vmatch(line_text, build(UNWRAP_TPLT,    symbol)) then return 'unwrap'         end
  if vmatch(line_text, build(EXPECT_TPLT,    symbol)) then return 'expect'         end
  if vmatch(line_text, build(UNWRAP_OR_TPLT, symbol)) then return 'unwrap_or'      end
  if vmatch(line_text, build(CHECK_TPLT,     symbol)) then return 'check'          end
  if vmatch(line_text, build(MAP_TPLT,       symbol)) then return 'map_combinator' end
  return nil
end

--- Human-readable label for a handling kind.
--- Mirrors kindLabelPlain() in src/extension.ts:180-193.
--- @param kind string
--- @return string
function M.kind_label(kind)
  local labels = {
    unwrap         = '.unwrap()',
    expect         = '.expect(...)',
    unwrap_or      = '.unwrap_or*(...)',
    map_combinator = 'combinator',
    question_mark  = '?',
    ['return']     = 'return',
    match          = 'match',
    if_let         = 'if let',
    while_let      = 'while let',
    check          = '.is_ok()/.is_err()',
  }
  return labels[kind] or kind
end

return M
