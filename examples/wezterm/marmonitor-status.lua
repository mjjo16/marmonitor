local wezterm = require("wezterm")

local STATUS_CACHE_TTL_SEC = 15
local last_status_fetch_sec = 0
local last_status_value = "marmonitor loading"

local function run_marmonitor_statusline()
  local now_sec = os.time()
  if now_sec - last_status_fetch_sec < STATUS_CACHE_TTL_SEC then
    return last_status_value
  end

  local home = os.getenv("HOME") or "~"
  local success, stdout, stderr = wezterm.run_child_process({
    "zsh",
    "-lc",
    "cd "
      .. home
      .. "/Documents/mjjo/marmonitor && node bin/marmonitor.js --statusline --statusline-format wezterm-pills",
  })

  if success and stdout and stdout ~= "" then
    last_status_fetch_sec = now_sec
    last_status_value = stdout:gsub("%s+$", "")
    return last_status_value
  end

  if stderr and stderr ~= "" then
    wezterm.log_error("marmonitor statusline failed: " .. stderr)
  end

  last_status_fetch_sec = now_sec
  last_status_value = "marmonitor unavailable"
  return last_status_value
end

local function split_lines(text)
  local lines = {}
  for line in text:gmatch("[^\r\n]+") do
    table.insert(lines, line)
  end
  return lines
end

local function parse_segments(text)
  local agents = {}
  local alerts = {}
  local focuses = {}

  for _, line in ipairs(split_lines(text)) do
    local kind, label, fg, bg = line:match("([^\t]+)\t([^\t]+)\t([^\t]+)\t([^\t]+)")
    if kind and label and fg and bg then
      local segment = { label = label, fg = fg, bg = bg }
      if kind == "agent" then
        table.insert(agents, segment)
      elseif kind == "alert" then
        table.insert(alerts, segment)
      elseif kind == "focus" then
        table.insert(focuses, segment)
      end
    end
  end

  return agents, alerts, focuses
end

local function push_pill(elements, segment)
  if #elements > 0 then
    table.insert(elements, { Text = " " })
  end
  table.insert(elements, { Attribute = { Intensity = "Bold" } })
  table.insert(elements, { Foreground = { Color = segment.fg } })
  table.insert(elements, { Background = { Color = segment.bg } })
  table.insert(elements, { Text = " " .. segment.label .. " " })
  table.insert(elements, { Background = { Color = "#1e1e2e" } })
  table.insert(elements, { Foreground = { Color = "#1e1e2e" } })
  table.insert(elements, { Text = " " })
  table.insert(elements, { Attribute = { Intensity = "Normal" } })
end

local function safe_format(elements, fallback)
  local ok, formatted = pcall(wezterm.format, elements)
  if ok and formatted then
    return formatted
  end
  wezterm.log_error("marmonitor wezterm.format failed; using fallback text")
  return fallback
end

wezterm.on("update-status", function(window, _pane)
  local status = run_marmonitor_statusline()
  local agents, alerts, focuses = parse_segments(status)

  local left = {}
  for _, segment in ipairs(agents) do
    push_pill(left, segment)
  end
  for _, segment in ipairs(alerts) do
    push_pill(left, segment)
  end

  local right = {}
  for _, focus in ipairs(focuses) do
    if #right > 0 then
      table.insert(right, { Text = " " })
    end
    table.insert(right, { Foreground = { Color = focus.fg } })
    table.insert(right, { Background = { Color = "#313244" } })
    table.insert(right, { Text = " " .. focus.label .. " " })
    table.insert(right, { Background = { Color = "#1e1e2e" } })
    table.insert(right, { Foreground = { Color = "#1e1e2e" } })
    table.insert(right, { Text = " " })
  end

  window:set_left_status(safe_format(left, " marmonitor "))
  window:set_right_status(safe_format(right, " unavailable "))
end)

return {
  tab_bar_at_bottom = true,
  use_fancy_tab_bar = false,
  show_tabs_in_tab_bar = false,
  show_new_tab_button_in_tab_bar = false,
  status_update_interval = 5000,
}
