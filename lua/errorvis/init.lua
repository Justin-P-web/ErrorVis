--- init.lua — Neovim plugin entry point for ErrorVis.
---
--- Usage (in your Neovim config, e.g. init.lua or lazy.nvim spec):
---
---   require('errorvis').setup({
---     enable_virtual_text = true,   -- show CodeLens-style badges (default: true)
---     keymaps = {
---       find_usages = '<leader>eu',  -- :ErrorVisFindUsages  (optional)
---       export      = '<leader>ex',  -- :ErrorVisExport      (optional)
---       refresh     = '<leader>er',  -- :ErrorVisRefresh     (optional)
---     },
---   })
---
--- With lazy.nvim:
---
---   {
---     dir = '/path/to/ErrorVis',
---     ft  = 'rust',
---     config = function()
---       require('errorvis').setup()
---     end,
---   }

local M = {}

--- Default configuration.
M.config = {
  -- Show virtual-text usage count badges above Result/Option-returning functions,
  -- analogous to the CodeLens badges in the VS Code extension.
  enable_virtual_text = true,

  -- Optional key mappings.  Set any key to a string like '<leader>eu' to
  -- create a normal-mode mapping.  Leave nil to skip.
  keymaps = {
    find_usages = nil,  -- e.g. '<leader>eu'
    export      = nil,  -- e.g. '<leader>ex'
    refresh     = nil,  -- e.g. '<leader>er'
  },
}

--- Initialize the ErrorVis Neovim plugin.
---
--- @param opts table|nil  partial config to merge with defaults
function M.setup(opts)
  M.config = vim.tbl_deep_extend('force', M.config, opts or {})

  -- Register user commands and optional keymaps
  require('errorvis.commands').setup(M.config)

  -- Set up autocmds for virtual-text badges when enabled
  if M.config.enable_virtual_text then
    require('errorvis.ui').setup_autocmds()

    -- Trigger an initial badge render for any already-open Rust buffer
    -- (handles the case where the plugin is loaded after files are opened)
    for _, bufnr in ipairs(vim.api.nvim_list_bufs()) do
      if vim.api.nvim_buf_is_loaded(bufnr)
        and vim.bo[bufnr].filetype == 'rust'
      then
        vim.defer_fn(function()
          if vim.api.nvim_buf_is_valid(bufnr) then
            require('errorvis.ui').refresh_badges(bufnr)
          end
        end, 500)
      end
    end
  end
end

return M
