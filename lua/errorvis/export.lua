--- export.lua — export functionality: JSON, Markdown, Mermaid output.
---
--- Port of formatJson(), formatMarkdown(), formatMermaid(), buildCallSiteIndex(),
--- kindLabelPlain() in src/extension.ts:195-498.
---
--- Public API:
---   M.export_result_tree()                 interactive export command
---   M.format_json(tree)    → string
---   M.format_markdown(tree) → string
---   M.format_mermaid(tree)  → MermaidDiagram[]

local M = {}

local finder  = require('errorvis.finder')
local patterns = require('errorvis.patterns')

-- ─────────────────────────────────────────────────────────────────────────────
-- Helpers
-- ─────────────────────────────────────────────────────────────────────────────

--- Write content to a file path (creates/overwrites).
local function write_file(fpath, content)
  local lines = vim.split(content, '\n', { plain = true })
  vim.fn.writefile(lines, fpath)
end

--- Make a node ID safe for Mermaid (alphanumeric + underscores only).
local function safe_id(s)
  return 'fn_' .. s:gsub('[^%w]', '_')
end

local function safe_loc_id(file_path, line)
  return 'loc_' .. file_path:gsub('[^%w]', '_') .. '_' .. line
end

--- Build an inverted call-site index from the tree.
--- Mirrors buildCallSiteIndex() in src/extension.ts:161-178.
---
--- Returns table keyed by "filePath:line" →
---   { file_path, line, line_text, entries[] }
--- where each entry is { fn_label, kind, via, fn_file_path, fn_line }
function M.build_call_site_index(tree)
  local index = {}
  for _, group in ipairs(tree.groups) do
    for _, fn_info in ipairs(group.functions) do
      local fn_label = group.kind == 'struct'
        and (group.label .. '::' .. fn_info.fn_name)
        or  fn_info.fn_name

      for _, h in ipairs(fn_info.handling) do
        local rel = vim.fn.fnamemodify(h.file or '', ':.')
        local line_nr = h.range.start.line + 1
        local key = rel .. ':' .. line_nr

        if not index[key] then
          index[key] = {
            file_path = rel,
            line      = line_nr,
            line_text = h.line_text or '',
            entries   = {},
          }
        end
        table.insert(index[key].entries, {
          fn_label     = fn_label,
          kind         = h.kind,
          via          = h.via,
          fn_file_path = fn_info.file_path,
          fn_line      = fn_info.line,
        })
      end
    end
  end
  return index
end

-- ─────────────────────────────────────────────────────────────────────────────
-- JSON formatter
-- ─────────────────────────────────────────────────────────────────────────────

--- Serialize the GlobalResultTree to a JSON string.
--- Mirrors formatJson() in src/extension.ts:195-232.
--- @param tree table  GlobalResultTree
--- @return string
function M.format_json(tree)
  local call_site_index = M.build_call_site_index(tree)

  -- Build sorted call sites list
  local sites = {}
  for _, site in pairs(call_site_index) do
    table.insert(sites, site)
  end
  table.sort(sites, function(a, b)
    if a.file_path ~= b.file_path then
      return a.file_path < b.file_path
    end
    return a.line < b.line
  end)
  local call_sites_out = {}
  for _, site in ipairs(sites) do
    table.insert(call_sites_out, {
      filePath  = site.file_path,
      line      = site.line,
      lineText  = site.line_text,
      handlers  = vim.tbl_map(function(e)
        return { kind = e.kind, via = e.via or vim.NIL, ['function'] = e.fn_label }
      end, site.entries),
    })
  end

  local out = {
    generatedAt = tree.generated_at,
    groups = vim.tbl_map(function(g)
      return {
        kind      = g.kind,
        label     = g.label,
        filePath  = g.file_path,
        functions = vim.tbl_map(function(f)
          return {
            fnName   = f.fn_name,
            filePath = f.file_path,
            line     = f.line,
            handling = vim.tbl_map(function(h)
              return {
                kind     = h.kind,
                depth    = h.depth,
                via      = h.via or vim.NIL,
                filePath = vim.fn.fnamemodify(h.file or '', ':.'),
                line     = h.range.start.line + 1,
                lineText = h.line_text or '',
              }
            end, f.handling),
          }
        end, g.functions),
      }
    end, tree.groups),
    callSites = call_sites_out,
  }

  return vim.fn.json_encode(out)
end

-- ─────────────────────────────────────────────────────────────────────────────
-- Markdown formatter
-- ─────────────────────────────────────────────────────────────────────────────

--- Serialize the GlobalResultTree to a Markdown string.
--- Mirrors formatMarkdown() in src/extension.ts:433-498.
--- @param tree table  GlobalResultTree
--- @return string
function M.format_markdown(tree)
  local lines = {
    '# ErrorVis Result Handling Tree',
    '',
    'Generated: ' .. tree.generated_at,
    '',
  }

  -- Section 1: per-function tree grouped by struct/file
  for _, group in ipairs(tree.groups) do
    if group.kind == 'struct' then
      table.insert(lines, '## `' .. group.label .. '` — ' .. group.file_path)
    else
      table.insert(lines, '## ' .. group.file_path)
    end
    table.insert(lines, '')

    for _, fn_info in ipairs(group.functions) do
      table.insert(lines, '### `' .. fn_info.fn_name .. '` (line ' .. fn_info.line .. ')')
      table.insert(lines, '')
      for _, h in ipairs(fn_info.handling) do
        local indent = string.rep('  ', h.depth)
        local rel = vim.fn.fnamemodify(h.file or '', ':.')
        local loc = rel .. ':' .. (h.range.start.line + 1)
        local via = h.via and (' ↳ via `' .. h.via .. '`') or ''
        local kind_str = patterns.kind_label(h.kind)
        table.insert(lines, indent .. '- **' .. kind_str .. '**' .. via .. ' — `' .. loc .. '`')
        table.insert(lines, indent .. '  `' .. (h.line_text or '') .. '`')
      end
      table.insert(lines, '')
    end
  end

  -- Section 2: inverted view — grouped by call site
  local call_sites = M.build_call_site_index(tree)
  local has_real = false
  for _, site in pairs(call_sites) do
    for _, e in ipairs(site.entries) do
      if e.kind ~= 'question_mark' and e.kind ~= 'return' then
        has_real = true
        break
      end
    end
    if has_real then break end
  end

  if has_real then
    table.insert(lines, '---')
    table.insert(lines, '')
    table.insert(lines, '## Handling by Call Site')
    table.insert(lines, '')

    -- Group sites by file, skip propagation-only sites
    local by_file = {}
    for _, site in pairs(call_sites) do
      local has_handling = false
      for _, e in ipairs(site.entries) do
        if e.kind ~= 'question_mark' and e.kind ~= 'return' then
          has_handling = true
          break
        end
      end
      if has_handling then
        local fp = site.file_path
        if not by_file[fp] then by_file[fp] = {} end
        table.insert(by_file[fp], site)
      end
    end

    local sorted_files = {}
    for fp in pairs(by_file) do table.insert(sorted_files, fp) end
    table.sort(sorted_files)

    for _, fp in ipairs(sorted_files) do
      local sites = by_file[fp]
      table.sort(sites, function(a, b) return a.line < b.line end)
      table.insert(lines, '### `' .. fp .. '`')
      table.insert(lines, '')
      table.insert(lines, '| Line | Handler | Origin Function |')
      table.insert(lines, '|------|---------|-----------------|')
      for _, site in ipairs(sites) do
        for _, entry in ipairs(site.entries) do
          if entry.kind ~= 'question_mark' and entry.kind ~= 'return' then
            local via = entry.via and (' ↳ via `' .. entry.via .. '`') or ''
            local kind_str = patterns.kind_label(entry.kind)
            table.insert(lines,
              '| ' .. site.line
              .. ' | `' .. kind_str .. '`' .. via
              .. ' | `' .. entry.fn_label .. '` — `'
              .. entry.fn_file_path .. ':' .. entry.fn_line .. '` |'
            )
          end
        end
      end
      table.insert(lines, '')
    end
  end

  return table.concat(lines, '\n')
end

-- ─────────────────────────────────────────────────────────────────────────────
-- Mermaid formatter
-- ─────────────────────────────────────────────────────────────────────────────

--- Serialize the GlobalResultTree to Mermaid diagram(s), one per source file.
--- Mirrors formatMermaid() in src/extension.ts:236-431.
--- @param tree table  GlobalResultTree
--- @return table[]  { file_path, content }
function M.format_mermaid(tree)
  -- Bucket groups by their source file
  local by_file = {}
  for _, group in ipairs(tree.groups) do
    local fp = group.file_path
    if not by_file[fp] then by_file[fp] = {} end
    table.insert(by_file[fp], group)
  end

  local diagrams = {}
  for fp, groups in pairs(by_file) do
    table.insert(diagrams, {
      file_path = fp,
      content   = M._format_mermaid_for_file(fp, groups),
    })
  end
  return diagrams
end

--- Build the Mermaid flowchart for a single source file.
--- Mirrors formatMermaidForFile() in src/extension.ts:250-431.
function M._format_mermaid_for_file(file_path, groups)
  -- Collect all source function names in this file
  local source_fns = {}
  for _, group in ipairs(groups) do
    for _, fn_info in ipairs(group.functions) do
      source_fns[fn_info.fn_name] = true
    end
  end

  -- Collect pass-through functions: appear in loc.via but are not sources
  local passthrough_fns = {}
  for _, group in ipairs(groups) do
    for _, fn_info in ipairs(group.functions) do
      for _, loc in ipairs(fn_info.handling) do
        if loc.via and not source_fns[loc.via] then
          passthrough_fns[loc.via] = true
        end
      end
    end
  end

  -- Track node IDs already defined as source or passthrough
  local defined_fn_ids = {}
  for fn in pairs(source_fns) do defined_fn_ids[safe_id(fn)] = true end
  for fn in pairs(passthrough_fns) do defined_fn_ids[safe_id(fn)] = true end

  -- Collect handler nodes for non-propagating locations
  local handler_nodes = {}  -- key → { node_id, label, loc_file_path }
  for _, group in ipairs(groups) do
    for _, fn_info in ipairs(group.functions) do
      for _, loc in ipairs(fn_info.handling) do
        if loc.kind == 'question_mark' or loc.kind == 'return' then goto skip_h end
        local loc_fp = vim.fn.fnamemodify(loc.file or '', ':.')
        if loc.in_function then
          local key = loc.in_function
          if not handler_nodes[key] then
            local label = loc.in_struct
              and (loc.in_struct .. '::' .. loc.in_function)
              or  loc.in_function
            handler_nodes[key] = {
              node_id       = safe_id(loc.in_function),
              label         = label,
              loc_file_path = loc_fp,
            }
          end
        else
          local line_nr = loc.range.start.line + 1
          local key = loc_fp .. ':' .. line_nr
          if not handler_nodes[key] then
            local short = vim.fn.fnamemodify(loc_fp, ':t')
            handler_nodes[key] = {
              node_id       = safe_loc_id(loc_fp, line_nr),
              label         = short .. ':' .. line_nr,
              loc_file_path = loc_fp,
            }
          end
        end
        ::skip_h::
      end
    end
  end

  -- Build deduplicated edge set
  local edge_set = {}
  local edges = {}
  local function add_edge(from_id, to_id)
    local k = from_id .. '→' .. to_id
    if not edge_set[k] then
      edge_set[k] = true
      table.insert(edges, { from_id = from_id, to_id = to_id })
    end
  end

  for _, group in ipairs(groups) do
    for _, fn_info in ipairs(group.functions) do
      local src_id = safe_id(fn_info.fn_name)
      for _, loc in ipairs(fn_info.handling) do
        local loc_fp = vim.fn.fnamemodify(loc.file or '', ':.')
        local immediate_id = loc.via and safe_id(loc.via) or src_id

        if loc.via then add_edge(src_id, safe_id(loc.via)) end

        if loc.kind == 'question_mark' or loc.kind == 'return' then
          if loc.in_function then
            add_edge(immediate_id, safe_id(loc.in_function))
          end
        else
          local line_nr = loc.range.start.line + 1
          local handler_key = loc.in_function or (loc_fp .. ':' .. line_nr)
          local hn = handler_nodes[handler_key]
          if hn then add_edge(immediate_id, hn.node_id) end
        end
      end
    end
  end

  -- Assemble Mermaid output
  local out = {
    '%%{init: {"theme":"neutral"}}%%',
    '%% ' .. file_path,
    'graph TD',
    '  classDef source fill:#4A90D9,stroke:#2C5F8A,color:#fff',
    '  classDef passthrough fill:#F5A623,stroke:#C67D0E,color:#333,stroke-dasharray:5 5',
    '  classDef callsite fill:#ECF0F1,stroke:#95A5A6,color:#333',
    '',
    '  %% Source functions (return Result/Option)',
  }

  -- File-level subgraph
  local file_sg_id = 'sg_file_' .. file_path:gsub('[^%w]', '_')
  table.insert(out, '  subgraph ' .. file_sg_id .. ' ["' .. file_path .. '"]')

  local emitted_fns = {}

  -- Struct subgraphs nested inside the file subgraph
  for _, group in ipairs(groups) do
    if group.kind == 'struct' then
      local sg_id = 'sg_' .. group.label:gsub('[^%w]', '_')
      table.insert(out, '    subgraph ' .. sg_id .. ' ["' .. group.label .. '"]')
      for _, fn_info in ipairs(group.functions) do
        table.insert(out, '      ' .. safe_id(fn_info.fn_name) .. '["' .. fn_info.fn_name .. '"]:::source')
        emitted_fns[fn_info.fn_name] = true
      end
      table.insert(out, '    end')
    end
  end

  -- Ungrouped functions
  for _, group in ipairs(groups) do
    if group.kind == 'file' then
      for _, fn_info in ipairs(group.functions) do
        if not emitted_fns[fn_info.fn_name] then
          table.insert(out, '    ' .. safe_id(fn_info.fn_name) .. '["' .. fn_info.fn_name .. '"]:::source')
          emitted_fns[fn_info.fn_name] = true
        end
      end
    end
  end

  table.insert(out, '  end')

  -- Pass-through nodes
  local pt_list = {}
  for fn in pairs(passthrough_fns) do table.insert(pt_list, fn) end
  if #pt_list > 0 then
    table.insert(out, '')
    table.insert(out, '  %% Pass-through functions (propagate without handling)')
    for _, fn in ipairs(pt_list) do
      table.insert(out, '  ' .. safe_id(fn) .. '(["' .. fn .. '"]):::passthrough')
    end
  end

  -- Handler nodes grouped by their file
  local by_loc_file = {}
  for _, node in pairs(handler_nodes) do
    if not defined_fn_ids[node.node_id] then
      local fp = node.loc_file_path
      if not by_loc_file[fp] then by_loc_file[fp] = {} end
      table.insert(by_loc_file[fp], { node_id = node.node_id, label = node.label })
    end
  end

  local loc_files = {}
  for fp in pairs(by_loc_file) do table.insert(loc_files, fp) end
  if #loc_files > 0 then
    table.insert(out, '')
    table.insert(out, '  %% Handler function nodes')
    for _, lf in ipairs(loc_files) do
      local sg_id = 'sg_handlers_' .. lf:gsub('[^%w]', '_')
      table.insert(out, '  subgraph ' .. sg_id .. ' ["' .. lf .. '"]')
      for _, node in ipairs(by_loc_file[lf]) do
        table.insert(out, '    ' .. node.node_id .. '["' .. node.label .. '"]:::callsite')
      end
      table.insert(out, '  end')
    end
  end

  -- Edges
  table.insert(out, '')
  table.insert(out, '  %% Error flow edges')
  for _, edge in ipairs(edges) do
    table.insert(out, '  ' .. edge.from_id .. ' --> ' .. edge.to_id)
  end

  return table.concat(out, '\n')
end

-- ─────────────────────────────────────────────────────────────────────────────
-- Interactive export command
-- ─────────────────────────────────────────────────────────────────────────────

--- Prompt the user for an output path, build the global result tree, and write
--- JSON, Markdown, and Mermaid files.
---
--- Mirrors exportResultTree() in src/extension.ts:92-156.
function M.export_result_tree()
  local default_path = vim.fn.getcwd() .. '/result-tree.json'
  local json_path = vim.fn.input({
    prompt  = 'ErrorVis: export to (JSON): ',
    default = default_path,
    completion = 'file',
  })
  if not json_path or json_path == '' then return end

  vim.notify('ErrorVis: building result tree…', vim.log.levels.INFO)

  vim.schedule(function()
    local tree = finder.build_global_result_tree(function(msg, _)
      vim.notify('ErrorVis: ' .. msg, vim.log.levels.INFO)
    end)

    if not tree or #tree.groups == 0 then
      vim.notify('ErrorVis: no result-handling usages found in workspace', vim.log.levels.WARN)
      return
    end

    -- Write JSON
    local json_content = M.format_json(tree)
    write_file(json_path, json_content)

    -- Write Markdown (same base name, .md extension)
    local md_path = json_path:gsub('%.json$', '') .. '.md'
    write_file(md_path, M.format_markdown(tree))

    -- Write Mermaid diagrams (one per source file)
    local base = json_path:gsub('%.json$', '')
    local diagrams = M.format_mermaid(tree)
    local mmd_paths = {}
    for _, d in ipairs(diagrams) do
      local safe_name = d.file_path:gsub('[^%w%-%.]', '-'):gsub('%-+', '-'):gsub('^%-', ''):gsub('%-$', '')
      local mmd_path = base .. '-' .. safe_name .. '.mmd'
      write_file(mmd_path, d.content)
      table.insert(mmd_paths, mmd_path)
    end

    local total_fns = 0
    for _, g in ipairs(tree.groups) do total_fns = total_fns + #g.functions end

    vim.notify(
      string.format(
        'ErrorVis: exported — %d function(s) across %d group(s). '
        .. 'JSON: %s  Markdown: %s  Mermaid: %d diagram(s)',
        total_fns, #tree.groups, json_path, md_path, #mmd_paths
      ),
      vim.log.levels.INFO
    )
  end)
end

return M
