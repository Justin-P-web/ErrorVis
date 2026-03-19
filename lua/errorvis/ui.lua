--- ui.lua — virtual text badges (CodeLens equivalent) and result picker.
---
--- Port of src/codeLensProvider.ts and showResultPicker() in src/extension.ts.
---
--- Public API:
---   M.setup_autocmds()                                   called by init.lua
---   M.refresh_badges(bufnr)                              force re-render
---   M.find_usages_at_cursor()                            interactive command
---   M.clear_badges(bufnr)

local M = {}

local finder  = require('errorvis.finder')
local patterns = require('errorvis.patterns')

-- Extmark namespace for virtual text badges.
local NS = vim.api.nvim_create_namespace('errorvis_badges')

-- Max retries when LSP returns nothing (mirrors MAX_RETRY_COUNT=36 in codeLensProvider.ts).
local MAX_RETRY = 36
-- Delay between retries in ms (mirrors RETRY_DELAY_MS=5000 in codeLensProvider.ts).
local RETRY_DELAY = 5000

-- Per-buffer state table.
-- M._state[bufnr] = { resolving=bool, retry_count=int, lenses={} }
M._state = {}

-- ─────────────────────────────────────────────────────────────────────────────
-- Badge rendering
-- ─────────────────────────────────────────────────────────────────────────────

--- Clear all errorvis extmarks from a buffer.
function M.clear_badges(bufnr)
  vim.api.nvim_buf_clear_namespace(bufnr, NS, 0, -1)
end

--- Render a single loading/placeholder badge on a function line.
local function render_loading(bufnr, line, fn_name)
  vim.api.nvim_buf_set_extmark(bufnr, NS, line, 0, {
    virt_text     = { { '⏳ Loading result usages for "' .. fn_name .. '"…', 'Comment' } },
    virt_text_pos = 'eol',
    hl_mode       = 'combine',
    priority      = 100,
  })
end

--- Render a resolved badge on a function line.
local function render_badge(bufnr, line, count, fn_name)
  local text, hl
  if count == nil then
    -- LSP not yet ready
    text = '🔄 Waiting for rust-analyzer…'
    hl   = 'Comment'
  elseif count == 0 then
    text = '○ No result usages found'
    hl   = 'Comment'
  else
    local plural = count == 1 and 'usage' or 'usages'
    text = '⚡ ' .. count .. ' result ' .. plural .. ' handled'
    hl   = 'DiagnosticHint'
  end
  vim.api.nvim_buf_set_extmark(bufnr, NS, line, 0, {
    virt_text     = { { text, hl } },
    virt_text_pos = 'eol',
    hl_mode       = 'combine',
    priority      = 100,
  })
end

-- ─────────────────────────────────────────────────────────────────────────────
-- Async badge resolution per buffer
-- ─────────────────────────────────────────────────────────────────────────────

--- Scan a buffer for Result/Option-returning functions, resolve usage counts
--- (with retry logic), and render virtual text badges.
---
--- Mirrors ResultCodeLensProvider.provideCodeLenses + resolveCodeLens in
--- src/codeLensProvider.ts.
function M.refresh_badges(bufnr)
  bufnr = bufnr or vim.api.nvim_get_current_buf()

  -- Only operate on Rust buffers
  if vim.bo[bufnr].filetype ~= 'rust' then return end

  local state = M._state[bufnr]
  if state and state.resolving then return end  -- already in progress

  M._state[bufnr] = { resolving = true, retry_count = 0, lenses = {} }
  state = M._state[bufnr]

  M.clear_badges(bufnr)

  -- Find all Result/Option-returning functions in the buffer
  local fns = finder.scan_buffer_for_result_fns(bufnr)
  if #fns == 0 then
    state.resolving = false
    return
  end

  -- Show loading placeholders immediately
  for _, fn_info in ipairs(fns) do
    render_loading(bufnr, fn_info.line, fn_info.fn_name)
  end

  -- Resolve counts asynchronously via vim.schedule to avoid blocking the editor
  vim.schedule(function()
    local all_zero = true

    for _, fn_info in ipairs(fns) do
      local pos = { line = fn_info.line, character = fn_info.col }
      local found = finder.find_handling_locations(bufnr, fn_info.fn_name, pos)
      local count = #found.locations

      if count > 0 then all_zero = false end

      -- Overwrite placeholder with resolved badge
      vim.api.nvim_buf_clear_namespace(bufnr, NS, fn_info.line, fn_info.line + 1)
      render_badge(bufnr, fn_info.line, count, fn_info.fn_name)

      -- Store lens data for interactive use
      state.lenses[fn_info.line] = {
        fn_name  = fn_info.fn_name,
        pos      = pos,
        count    = count,
        lsp_ok   = found.lsp_available,
      }
    end

    state.resolving = false

    -- Retry logic: if all counts are zero and LSP may not be ready yet
    if all_zero and state.retry_count < MAX_RETRY then
      state.retry_count = state.retry_count + 1
      -- Show "waiting" badge
      for _, fn_info in ipairs(fns) do
        vim.api.nvim_buf_clear_namespace(bufnr, NS, fn_info.line, fn_info.line + 1)
        render_badge(bufnr, fn_info.line, nil, fn_info.fn_name)
      end
      -- Schedule a retry
      vim.defer_fn(function()
        if vim.api.nvim_buf_is_valid(bufnr) then
          M._state[bufnr] = nil  -- reset to allow re-entry
          M.refresh_badges(bufnr)
        end
      end, RETRY_DELAY)
    end
  end)
end

-- ─────────────────────────────────────────────────────────────────────────────
-- Interactive "Find Usages" command
-- ─────────────────────────────────────────────────────────────────────────────

--- Show a picker with all handling locations for the symbol under the cursor.
---
--- Mirrors findResultUsages() and showResultPicker() in src/extension.ts.
function M.find_usages_at_cursor()
  local bufnr = vim.api.nvim_get_current_buf()
  if vim.bo[bufnr].filetype ~= 'rust' then
    vim.notify('ErrorVis: not a Rust buffer', vim.log.levels.WARN)
    return
  end

  -- Get the word under the cursor
  local symbol = vim.fn.expand('<cword>')
  if not symbol or symbol == '' then
    vim.notify('ErrorVis: no symbol under cursor', vim.log.levels.WARN)
    return
  end

  local cursor = vim.api.nvim_win_get_cursor(0)  -- {row 1-indexed, col 0-indexed}
  local pos = { line = cursor[1] - 1, character = cursor[2] }

  vim.notify('ErrorVis: searching for "' .. symbol .. '" usages…', vim.log.levels.INFO)

  vim.schedule(function()
    local locations = finder.find_handling_tree(
      bufnr, symbol, pos,
      function(msg) vim.notify('ErrorVis: ' .. msg, vim.log.levels.INFO) end
    )

    if #locations == 0 then
      vim.notify(
        'ErrorVis: no result-handling usages found for "' .. symbol .. '"',
        vim.log.levels.INFO
      )
      return
    end

    M._show_picker(symbol, locations)
  end)
end

--- Show an interactive picker for the given handling locations.
---
--- Mirrors showResultPicker() in src/extension.ts:500-589.
--- Uses vim.ui.select for compatibility with telescope/fzf-lua/default pickers.
function M._show_picker(symbol, locations)
  -- Sort by depth, then file path
  local sorted = vim.deepcopy(locations)
  table.sort(sorted, function(a, b)
    if a.depth ~= b.depth then return a.depth < b.depth end
    return (a.file or '') < (b.file or '')
  end)

  -- Build display items
  local items = {}
  for _, loc in ipairs(sorted) do
    local rel = vim.fn.fnamemodify(loc.file or '', ':.')
    local line_nr = loc.range.start.line + 1
    local kind_str = patterns.kind_label(loc.kind)
    local depth_str = loc.depth > 0
      and (' [depth ' .. loc.depth .. (loc.via and ' via ' .. loc.via or '') .. ']')
      or  ''
    table.insert(items, {
      label    = kind_str .. depth_str .. '  ' .. rel .. ':' .. line_nr,
      detail   = loc.line_text or '',
      file     = loc.file,
      line     = line_nr,
      col      = loc.range.start.character,
      location = loc,
    })
  end

  local max_depth = 0
  for _, l in ipairs(locations) do
    if l.depth > max_depth then max_depth = l.depth end
  end
  local level_str = max_depth > 0 and (' across ' .. (max_depth + 1) .. ' level(s)') or ''
  local title = 'Result usages of "' .. symbol .. '" — ' .. #locations .. ' found' .. level_str

  vim.ui.select(items, {
    prompt = title,
    format_item = function(item)
      return item.label .. (item.detail ~= '' and ('  │ ' .. item.detail) or '')
    end,
  }, function(choice)
    if not choice then return end
    -- Navigate to the selected location
    if choice.file and choice.file ~= '' then
      vim.cmd.edit(choice.file)
    end
    vim.api.nvim_win_set_cursor(0, { choice.line, choice.col })
    vim.cmd('normal! zz')  -- centre view
  end)
end

-- ─────────────────────────────────────────────────────────────────────────────
-- Autocmd setup
-- ─────────────────────────────────────────────────────────────────────────────

--- Register autocmds that keep badges up-to-date.
--- Called once by init.lua when enable_virtual_text = true.
function M.setup_autocmds()
  local group = vim.api.nvim_create_augroup('errorvis_ui', { clear = true })

  -- Refresh on enter and after saving a Rust file
  vim.api.nvim_create_autocmd({ 'BufEnter', 'BufWritePost' }, {
    group    = group,
    pattern  = '*.rs',
    callback = function(ev)
      -- Small delay so LSP has a chance to attach on fresh buffer open
      vim.defer_fn(function()
        if vim.api.nvim_buf_is_valid(ev.buf) then
          M._state[ev.buf] = nil  -- allow fresh resolution
          M.refresh_badges(ev.buf)
        end
      end, 300)
    end,
  })

  -- Invalidate resolved cache when text changes (mirrors onDidChangeTextDocument)
  vim.api.nvim_create_autocmd({ 'TextChanged', 'TextChangedI' }, {
    group    = group,
    pattern  = '*.rs',
    callback = function(ev)
      if M._state[ev.buf] then
        M._state[ev.buf] = nil
        M.clear_badges(ev.buf)
      end
    end,
  })

  -- Clean up state when buffer is deleted
  vim.api.nvim_create_autocmd('BufDelete', {
    group    = group,
    callback = function(ev)
      M._state[ev.buf] = nil
    end,
  })
end

return M
