--- commands.lua — user-facing Neovim commands and optional keymaps.
---
--- Registered commands:
---   :ErrorVisFindUsages   — find all handling locations for symbol under cursor
---   :ErrorVisExport       — build global result tree and write JSON/Markdown/Mermaid
---   :ErrorVisRefresh      — force re-render virtual-text badges in current buffer
---   :ErrorVisClear        — remove all badges from current buffer

local M = {}

--- Register all user commands.
--- Called once from init.lua with the resolved config table.
--- @param config table  merged config from setup()
function M.setup(config)
  local ui     = require('errorvis.ui')
  local export = require('errorvis.export')

  vim.api.nvim_create_user_command('ErrorVisFindUsages', function()
    ui.find_usages_at_cursor()
  end, { desc = 'ErrorVis: find Result/Option handling locations at cursor' })

  vim.api.nvim_create_user_command('ErrorVisExport', function()
    export.export_result_tree()
  end, { desc = 'ErrorVis: export result tree to JSON / Markdown / Mermaid' })

  vim.api.nvim_create_user_command('ErrorVisRefresh', function()
    local bufnr = vim.api.nvim_get_current_buf()
    ui._state[bufnr] = nil
    ui.refresh_badges(bufnr)
  end, { desc = 'ErrorVis: force refresh virtual-text badges' })

  vim.api.nvim_create_user_command('ErrorVisClear', function()
    local bufnr = vim.api.nvim_get_current_buf()
    ui._state[bufnr] = nil
    ui.clear_badges(bufnr)
  end, { desc = 'ErrorVis: clear virtual-text badges from current buffer' })

  -- Optional keymaps (only set when the user configures them)
  local km = (config or {}).keymaps or {}

  if km.find_usages then
    vim.keymap.set('n', km.find_usages, '<cmd>ErrorVisFindUsages<cr>', {
      desc   = 'ErrorVis: find Result usages',
      silent = true,
    })
  end

  if km.export then
    vim.keymap.set('n', km.export, '<cmd>ErrorVisExport<cr>', {
      desc   = 'ErrorVis: export result tree',
      silent = true,
    })
  end

  if km.refresh then
    vim.keymap.set('n', km.refresh, '<cmd>ErrorVisRefresh<cr>', {
      desc   = 'ErrorVis: refresh badges',
      silent = true,
    })
  end
end

return M
