--- finder.lua — core search logic, tree building, workspace scanning.
---
--- Port of src/resultFinder.ts.
---
--- Key public functions:
---   M.find_handling_locations(bufnr, symbol, pos)  → {locations, lsp_available}
---   M.find_handling_tree(bufnr, symbol, pos, ...)  → HandlingLocation[]
---   M.scan_buffer_for_result_fns(bufnr)            → ScannedFn[]
---   M.build_global_result_tree(on_progress)        → GlobalResultTree
---   M.build_cfg_test_line_set(lines)               → table<number,bool>

local M = {}

local patterns = require('errorvis.patterns')

-- Maximum recursion depth when following propagation chains.
-- Mirrors MAX_DEPTH in src/resultFinder.ts:61.
local MAX_DEPTH = 10

-- Vim \v patterns mirroring FN_SIGNATURE and RETURNS_RESULT from
-- src/codeLensProvider.ts:12-13 and src/resultFinder.ts:64-65.
local FN_SIG_PAT      = [[\v^\s*%(pub%(%(.*\)))?\s+)?%(async\s+)?fn\s+(\w+)\s*[<(]]]
local RETURNS_RESULT  = [[\v->.*%(Result|Option)\s*<]]
local IMPL_LINE_PAT   = [[\v^\s*impl\b]]

-- ─────────────────────────────────────────────────────────────────────────────
-- Helpers
-- ─────────────────────────────────────────────────────────────────────────────

--- Returns true when the file path belongs to a test, example, or bench directory.
--- Mirrors isTestOrExamplePath() in src/resultFinder.ts:610-613.
local function is_test_path(fpath)
  local norm = fpath:gsub('\\', '/')
  return norm:match('/(tests|examples|benches)/') ~= nil
end

--- Read all lines from a buffer (0-indexed line numbers in results list).
--- @param bufnr integer
--- @return string[]  1-indexed Lua list of line strings
local function buf_lines(bufnr)
  return vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
end

--- Load a file into a buffer (may already be loaded) and return its bufnr.
--- Returns nil on failure.
local function load_file(fpath)
  local ok, bufnr = pcall(function()
    local b = vim.fn.bufadd(fpath)
    vim.fn.bufload(b)
    return b
  end)
  return ok and bufnr or nil
end

--- Strip nested angle-bracket generics from a line (up to 6 passes).
--- Mirrors stripGenerics() in src/resultFinder.ts:449-457.
local function strip_generics(line)
  local s = line
  for _ = 1, 6 do
    local stripped = s:gsub('<[^<>]*>', '')
    if stripped == s then break end
    s = stripped
  end
  return s
end

--- Extract the concrete struct/type name from an `impl ...` line.
--- Mirrors extractImplStructName() in src/resultFinder.ts:460-467.
local function extract_impl_struct_name(line)
  local simplified = strip_generics(line)
  -- Prefer "for TypeName" (trait impl) over the first type after `impl`
  local for_match = simplified:match('%f[%w]for%f[%W]%s+(%w+)')
  if for_match then return for_match end
  return simplified:match('%f[%w]impl%f[%W]%s+(%w+)')
end

--- Scan lines up to and including fn_line to find the innermost enclosing
--- impl struct name using forward brace-depth tracking.
--- Mirrors getEnclosingImplName() in src/resultFinder.ts:267-294.
--- @param lines string[]  1-indexed list of lines
--- @param fn_line integer  0-indexed line number of the function
--- @return string|nil
local function get_enclosing_impl_name(lines, fn_line)
  local brace_depth = 0
  local current_impl = nil
  local impl_brace_depth = 0

  for i = 1, fn_line + 1 do  -- lines are 1-indexed, fn_line is 0-indexed
    local text = lines[i]
    if text == nil then break end

    if current_impl == nil
      and vim.fn.match(text, IMPL_LINE_PAT) >= 0
      and text:find('{', 1, true)
    then
      local name = extract_impl_struct_name(text)
      if name then
        current_impl = name
        impl_brace_depth = brace_depth
      end
    end

    for ch in text:gmatch('.') do
      if ch == '{' then brace_depth = brace_depth + 1
      elseif ch == '}' then brace_depth = brace_depth - 1
      end
    end

    if current_impl ~= nil and brace_depth <= impl_brace_depth then
      current_impl = nil
    end
  end

  return current_impl
end

--- Build a set (table with true values) of 0-indexed line numbers that fall
--- inside #[cfg(test)] mod blocks.
--- Mirrors buildCfgTestLineSet() in src/resultFinder.ts:619-656.
--- @param lines string[]  1-indexed list of lines
--- @return table<number,boolean>
function M.build_cfg_test_line_set(lines)
  local test_lines = {}
  local brace_depth = 0
  local in_cfg_test = false
  local cfg_test_brace = 0
  local pending_cfg = false

  for i, text in ipairs(lines) do
    local idx = i - 1  -- convert to 0-indexed

    if text:match('^%s*#%[cfg%(test%)%]') then
      pending_cfg = true
    end

    if pending_cfg
      and vim.fn.match(text, [[\v<mod>]]) >= 0
      and text:find('{', 1, true)
    then
      in_cfg_test = true
      cfg_test_brace = brace_depth
      pending_cfg = false
    elseif pending_cfg
      and text:match('%S')
      and not text:match('^%s*//')
      and not text:match('^%s*#')
    then
      pending_cfg = false
    end

    for ch in text:gmatch('.') do
      if ch == '{' then brace_depth = brace_depth + 1
      elseif ch == '}' then brace_depth = brace_depth - 1
      end
    end

    if in_cfg_test and brace_depth <= cfg_test_brace then
      in_cfg_test = false
    end

    if in_cfg_test then
      test_lines[idx] = true
    end
  end

  return test_lines
end

--- Find the innermost function symbol containing `line` (0-indexed) using LSP
--- documentSymbol, then fall back to scanning lines upward.
---
--- Returns { name, file, line (0-indexed), struct_name? } or nil.
--- Mirrors getEnclosingFunctionName() in src/resultFinder.ts:212-261.
local function get_enclosing_function(bufnr, line)
  local lines = buf_lines(bufnr)

  -- Tier 1: LSP documentSymbol
  local fpath = vim.api.nvim_buf_get_name(bufnr)
  local params = { textDocument = { uri = vim.uri_from_fname(fpath) } }
  local lsp_result = vim.lsp.buf_request_sync(bufnr, 'textDocument/documentSymbol', params, 3000)

  if lsp_result then
    -- Find the innermost Function/Method symbol whose range contains `line`
    local best = nil
    local best_size = math.huge

    local function walk(syms)
      for _, sym in ipairs(syms or {}) do
        local r = sym.range or (sym.location and sym.location.range)
        if r then
          local s = r.start.line
          local e = r['end'].line
          if s <= line and line <= e then
            local kind = sym.kind
            -- LSP SymbolKind: 12 = Function, 6 = Method
            if kind == 12 or kind == 6 then
              local sz = (e - s) * 10000 + r['end'].character
              if sz < best_size then
                best = sym
                best_size = sz
              end
            end
            if sym.children then walk(sym.children) end
          end
        end
      end
    end

    for _, resp in pairs(lsp_result) do
      if resp.result then walk(resp.result) end
    end

    if best then
      local fn_line = (best.selectionRange or best.range).start.line
      return {
        name        = best.name,
        file        = fpath,
        line        = fn_line,
        struct_name = get_enclosing_impl_name(lines, fn_line),
      }
    end
  end

  -- Tier 2: regex scan upward
  local fn_pat = [[\v^\s*%(pub\s+)?%(async\s+)?fn\s+(\w+)]]
  for i = line + 1, 1, -1 do  -- 1-indexed, scan from line downward
    local text = lines[i]
    if text == nil then break end
    local m = vim.fn.matchlist(text, fn_pat)
    if m and m[2] and m[2] ~= '' then
      local fn_name = m[2]
      local col = text:find(fn_name, 1, true) or 1
      local fn_line = i - 1  -- 0-indexed
      return {
        name        = fn_name,
        file        = fpath,
        line        = fn_line,
        struct_name = get_enclosing_impl_name(lines, fn_line),
      }
    end
  end

  return nil
end

--- Find the definition position of a named function using workspace symbols
--- (LSP), falling back to a regex scan of `fallback_bufnr`.
---
--- Returns { file, line (0-indexed), col } or nil.
--- Mirrors findFunctionDefinition() in src/resultFinder.ts:331-371.
local function find_function_definition(fn_name, fallback_bufnr)
  -- Tier 1: workspace/symbol
  local params = { query = fn_name }
  local lsp_result = vim.lsp.buf_request_sync(
    fallback_bufnr, 'workspace/symbol', params, 3000
  )
  if lsp_result then
    for _, resp in pairs(lsp_result) do
      for _, sym in ipairs(resp.result or {}) do
        if sym.name == fn_name then
          local kind = sym.kind
          if kind == 12 or kind == 6 then  -- Function or Method
            local loc = sym.location
            return {
              file = vim.uri_to_fname(loc.uri),
              line = loc.range.start.line,
              col  = loc.range.start.character,
            }
          end
        end
      end
    end
  end

  -- Tier 2: scan fallback buffer
  local escaped = fn_name:gsub('([.+*?^${}%(%)%[%]|\\/<>])', '\\%1')
  local fn_pat = [[\v<fn>\s+<]] .. escaped .. [[>]]
  local lines = buf_lines(fallback_bufnr)
  for i, text in ipairs(lines) do
    if vim.fn.match(text, fn_pat) >= 0 then
      local col = text:find(fn_name, 1, true) or 1
      return {
        file = vim.api.nvim_buf_get_name(fallback_bufnr),
        line = i - 1,  -- 0-indexed
        col  = col - 1,
      }
    end
  end

  return nil
end

-- ─────────────────────────────────────────────────────────────────────────────
-- Two-tier reference search
-- ─────────────────────────────────────────────────────────────────────────────

--- Collect all locations in bufnr (and cross-file via LSP) where `symbol` is
--- handled as a Result/Option.
---
--- Mirrors findHandlingLocations() in src/resultFinder.ts:121-202.
---
--- @param bufnr    integer
--- @param symbol   string   Rust identifier
--- @param pos      {line:integer, character:integer}  0-indexed position
--- @param on_progress function|nil  called with a status string during search
--- @return table  { locations = Location[], lsp_available = bool }
function M.find_handling_locations(bufnr, symbol, pos, on_progress)
  local results = {}
  local lsp_available = false

  if on_progress then on_progress('Querying LSP for "' .. symbol .. '"…') end

  -- ── Tier 1: LSP references ────────────────────────────────────────────────
  local fpath = vim.api.nvim_buf_get_name(bufnr)
  local params = {
    textDocument = { uri = vim.uri_from_fname(fpath) },
    position     = pos,
    context      = { includeDeclaration = false },
  }

  local ok, lsp_result = pcall(
    vim.lsp.buf_request_sync, bufnr, 'textDocument/references', params, 5000
  )

  if ok and lsp_result then
    lsp_available = true
    -- Collect all reference locations from all LSP clients
    local ref_locs = {}
    for _, resp in pairs(lsp_result) do
      for _, loc in ipairs(resp.result or {}) do
        table.insert(ref_locs, loc)
      end
    end

    if #ref_locs > 0 then
      -- Cache cfg(test) line sets per file to avoid repeated scans
      local cfg_cache = {}

      for _, loc in ipairs(ref_locs) do
        local loc_fpath = vim.uri_to_fname(loc.uri)
        if is_test_path(loc_fpath) then goto continue end

        local loc_bufnr = load_file(loc_fpath)
        if not loc_bufnr then goto continue end

        if not cfg_cache[loc_fpath] then
          cfg_cache[loc_fpath] = M.build_cfg_test_line_set(buf_lines(loc_bufnr))
        end

        local ref_line = loc.range.start.line
        if cfg_cache[loc_fpath][ref_line] then goto continue end

        local loc_lines = buf_lines(loc_bufnr)
        local line_text = loc_lines[ref_line + 1]  -- 1-indexed
        if not line_text then goto continue end
        if line_text:match('^%s*//') then goto continue end

        local kind = patterns.classify_line(line_text, symbol)
        if kind then
          table.insert(results, {
            uri      = loc.uri,
            file     = loc_fpath,
            range    = loc.range,
            line_text = line_text:match('^%s*(.-)%s*$'),  -- trimmed
            kind     = kind,
          })
        end

        ::continue::
      end

      if #results > 0 then
        return { locations = results, lsp_available = lsp_available }
      end
    end
  end

  -- ── Tier 2: regex scan of the current document ────────────────────────────
  if on_progress then on_progress('Scanning document for "' .. symbol .. '"…') end

  local lines = buf_lines(bufnr)
  local cfg_test = M.build_cfg_test_line_set(lines)
  local escaped = symbol:gsub('([.+*?^${}%(%)%[%]|\\/<>])', '\\%1')
  local sym_pat = [[\v<]] .. escaped .. [[>]]

  for i, line_text in ipairs(lines) do
    local ln = i - 1  -- 0-indexed
    if cfg_test[ln] then goto continue2 end
    if line_text:match('^%s*//') then goto continue2 end

    local kind = patterns.classify_line(line_text, symbol)
    if kind then
      local col = vim.fn.match(line_text, sym_pat)
      if col < 0 then col = 0 end
      table.insert(results, {
        uri   = vim.uri_from_fname(fpath),
        file  = fpath,
        range = {
          start    = { line = ln, character = col },
          ['end']  = { line = ln, character = col + #symbol },
        },
        line_text = line_text:match('^%s*(.-)%s*$'),
        kind      = kind,
      })
    end
    ::continue2::
  end

  return { locations = results, lsp_available = lsp_available }
end

-- ─────────────────────────────────────────────────────────────────────────────
-- Recursive tree traversal
-- ─────────────────────────────────────────────────────────────────────────────

--- Recursively collect all handling locations for `symbol`, following `?` and
--- `return` propagation up through calling functions.
---
--- Mirrors findHandlingTree() in src/resultFinder.ts:380-446.
---
--- @param bufnr       integer
--- @param symbol      string
--- @param pos         {line:integer, character:integer}
--- @param on_progress function|nil
--- @param visited     table<string,bool>|nil  cycle guard
--- @param depth       integer|nil
--- @return table[]  HandlingLocation records
function M.find_handling_tree(bufnr, symbol, pos, on_progress, visited, depth)
  visited = visited or {}
  depth   = depth   or 0

  if visited[symbol] or depth > MAX_DEPTH then
    return {}
  end
  visited[symbol] = true

  local found = M.find_handling_locations(bufnr, symbol, pos, on_progress)
  local raw = found.locations

  -- Stamp depth and via onto each result
  local results = {}
  for _, r in ipairs(raw) do
    local loc = vim.tbl_extend('force', r, {
      depth = depth,
      via   = depth > 0 and symbol or nil,
    })
    table.insert(results, loc)
  end

  -- Populate inFunction / inStruct for all locations at this level
  for _, result in ipairs(results) do
    local loc_bufnr = load_file(result.file) or bufnr
    local enc = get_enclosing_function(loc_bufnr, result.range.start.line)
    if enc then
      result.in_function = enc.name
      result.in_struct   = enc.struct_name
    end
  end

  -- Follow propagating usages up the call tree
  for _, loc in ipairs(raw) do
    if loc.kind ~= 'question_mark' and loc.kind ~= 'return' then goto skip end

    local loc_bufnr = load_file(loc.file) or bufnr
    local enc = get_enclosing_function(loc_bufnr, loc.range.start.line)
    if not enc or visited[enc.name] then goto skip end

    local def = find_function_definition(enc.name, loc_bufnr)
    if not def then goto skip end

    local def_bufnr = load_file(def.file) or loc_bufnr
    if not def_bufnr then goto skip end

    if on_progress then
      on_progress('Following propagation through "' .. enc.name .. '"…')
    end

    local sub = M.find_handling_tree(
      def_bufnr,
      enc.name,
      { line = def.line, character = def.col },
      on_progress,
      visited,
      depth + 1
    )
    for _, sr in ipairs(sub) do
      table.insert(results, sr)
    end

    ::skip::
  end

  return results
end

-- ─────────────────────────────────────────────────────────────────────────────
-- Per-buffer function scan
-- ─────────────────────────────────────────────────────────────────────────────

--- Scan a buffer and return all Result/Option-returning functions with their
--- position and enclosing impl context.
---
--- Mirrors scanDocumentForResultFns() in src/resultFinder.ts:476-537.
---
--- @param bufnr integer
--- @return table[]  { fn_name, line(0-indexed), col, impl_name }
function M.scan_buffer_for_result_fns(bufnr)
  local found = {}
  local lines = buf_lines(bufnr)
  local cfg_test = M.build_cfg_test_line_set(lines)

  local brace_depth = 0
  local current_impl = nil
  local impl_brace_depth = 0

  for i, text in ipairs(lines) do
    local ln = i - 1  -- 0-indexed

    -- Track impl block entry
    if current_impl == nil
      and vim.fn.match(text, IMPL_LINE_PAT) >= 0
      and text:find('{', 1, true)
    then
      local name = extract_impl_struct_name(text)
      if name then
        current_impl = name
        impl_brace_depth = brace_depth
      end
    end

    -- Count braces
    for ch in text:gmatch('.') do
      if ch == '{' then brace_depth = brace_depth + 1
      elseif ch == '}' then brace_depth = brace_depth - 1
      end
    end

    -- Check if we exited the impl block
    if current_impl ~= nil and brace_depth <= impl_brace_depth then
      current_impl = nil
    end

    -- Skip test module lines
    if cfg_test[ln] then goto next_line end

    -- Check for fn signature
    local fn_match = vim.fn.matchlist(text, FN_SIG_PAT)
    if not fn_match or fn_match[2] == '' then goto next_line end

    -- Collect multi-line signature (look ahead until `{` or `;`)
    local sig_text = text
    local j = i + 1
    while j <= #lines and not sig_text:find('{', 1, true) and not sig_text:find(';', 1, true) and j - i < 10 do
      sig_text = sig_text .. ' ' .. lines[j]
      j = j + 1
    end

    if vim.fn.match(sig_text, RETURNS_RESULT) < 0 then goto next_line end

    local fn_name = fn_match[2]
    local col = (text:find(fn_name, 1, true) or 1) - 1  -- 0-indexed
    table.insert(found, {
      fn_name   = fn_name,
      line      = ln,
      col       = col,
      impl_name = current_impl,
    })

    ::next_line::
  end

  return found
end

-- ─────────────────────────────────────────────────────────────────────────────
-- Global workspace scan
-- ─────────────────────────────────────────────────────────────────────────────

--- Scan every Rust file in the workspace, build a handling tree for each
--- Result/Option-returning function, and return results grouped by struct or file.
---
--- Uses regex-only (no LSP cross-file references) for robustness across files
--- that may not have LSP attached. Interactive "Find Usages" uses the full
--- two-tier search instead.
---
--- Mirrors buildGlobalResultTree() in src/resultFinder.ts:544-607.
---
--- @param on_progress function|nil  called with (message, increment_pct)
--- @return table  GlobalResultTree
function M.build_global_result_tree(on_progress)
  local cwd = vim.fn.getcwd()

  -- Gather all .rs files, excluding common non-source dirs
  local all_files = vim.fn.globpath(cwd, '**/*.rs', false, true)
  local rs_files = {}
  for _, f in ipairs(all_files) do
    local norm = f:gsub('\\', '/')
    if not norm:match('/target/')
      and not norm:match('/tests/')
      and not norm:match('/examples/')
      and not norm:match('/benches/')
    then
      table.insert(rs_files, f)
    end
  end

  -- Phase 1: collect all Result/Option-returning functions across the workspace
  local pending = {}
  for _, fpath in ipairs(rs_files) do
    local b = load_file(fpath)
    if not b then goto next_file end
    local rel_path = vim.fn.fnamemodify(fpath, ':.' )  -- relative to cwd
    for _, fn_info in ipairs(M.scan_buffer_for_result_fns(b)) do
      table.insert(pending, {
        bufnr    = b,
        file     = fpath,
        rel_path = rel_path,
        fn_name  = fn_info.fn_name,
        line     = fn_info.line,
        col      = fn_info.col,
        impl_name = fn_info.impl_name,
      })
    end
    ::next_file::
  end

  if #pending == 0 then
    return { generated_at = os.date('!%Y-%m-%dT%H:%M:%SZ'), groups = {} }
  end

  local increment = 100 / #pending

  -- Phase 2: build handling tree per function, grouped by struct or file
  local group_map = {}  -- key → ResultGroup

  for _, fn_info in ipairs(pending) do
    if on_progress then
      on_progress(
        'Analysing "' .. fn_info.fn_name .. '" in ' .. fn_info.rel_path .. '…',
        increment
      )
    end

    -- For global scan use regex-only (pass a dummy lsp_available=false approach:
    -- just call find_handling_locations which will fall through to regex when
    -- LSP returns nothing for non-active buffers)
    local handling = M.find_handling_tree(
      fn_info.bufnr,
      fn_info.fn_name,
      { line = fn_info.line, character = fn_info.col }
    )
    if #handling == 0 then goto next_fn end

    local group_key = fn_info.impl_name
      and ('struct:' .. fn_info.impl_name .. ':' .. fn_info.rel_path)
      or  ('file:'   .. fn_info.rel_path)

    if not group_map[group_key] then
      group_map[group_key] = {
        kind      = fn_info.impl_name and 'struct' or 'file',
        label     = fn_info.impl_name or fn_info.rel_path,
        file_path = fn_info.rel_path,
        functions = {},
      }
    end

    table.insert(group_map[group_key].functions, {
      fn_name   = fn_info.fn_name,
      file_path = fn_info.rel_path,
      line      = fn_info.line + 1,  -- 1-based for output
      handling  = handling,
    })

    ::next_fn::
  end

  local groups = {}
  for _, g in pairs(group_map) do
    table.insert(groups, g)
  end

  return {
    generated_at = os.date('!%Y-%m-%dT%H:%M:%SZ'),
    groups       = groups,
  }
end

return M
