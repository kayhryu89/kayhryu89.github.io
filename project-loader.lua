-- project-loader.lua
-- Reads projects.bib and generates HTML tables for ongoing/completed projects

function Pandoc(doc)
  local bib_path = "./Info/Bib/projects.bib"
  local f = io.open(bib_path, "r")
  if not f then
    f = io.open("Info/Bib/projects.bib", "r")
  end
  if not f then return doc end

  local content = f:read("*all")
  f:close()

  -- Parse bib entries
  local ongoing = {}
  local completed = {}

  for key, body in content:gmatch("@%w+{(%w[%w_]*),(.-)%s*\n}") do
    local title = body:match("title%s*=%s*{([^}]+)}")
    local author = body:match("author%s*=%s*{{([^}]+)}}")
    local note = body:match("note%s*=%s*{([^}]+)}")
    local keywords = body:match("keywords%s*=%s*{([^}]+)}")

    if author then
      author = author:gsub("\\&", "&")
    end

    local entry = {
      title = title or "",
      funding = author or "",
      period = note or "",
      status = keywords or "completed"
    }

    if entry.status:match("ongoing") then
      table.insert(ongoing, entry)
    else
      table.insert(completed, entry)
    end
  end

  -- Generate HTML tables
  local function make_table(entries)
    local html = '<div class="project-table">\n'
    html = html .. '<table class="table">\n<thead><tr>'
    html = html .. '<th style="width:5%">No.</th>'
    html = html .. '<th>Project</th>'
    html = html .. '<th>Funding</th>'
    html = html .. '<th>Period</th>'
    html = html .. '</tr></thead>\n<tbody>\n'
    for i, e in ipairs(entries) do
      html = html .. '<tr>'
      html = html .. '<td style="text-align:center">' .. i .. '</td>'
      html = html .. '<td>' .. e.title .. '</td>'
      html = html .. '<td>' .. e.funding .. '</td>'
      html = html .. '<td>' .. e.period:gsub("%-%-", "–") .. '</td>'
      html = html .. '</tr>\n'
    end
    html = html .. '</tbody></table>\n</div>'
    return html
  end

  -- Find and replace placeholder divs
  local new_blocks = pandoc.List()
  for _, block in ipairs(doc.blocks) do
    if block.t == "Div" and block.identifier == "ongoing-projects" then
      new_blocks:insert(pandoc.RawBlock("html", make_table(ongoing)))
    elseif block.t == "Div" and block.identifier == "completed-projects" then
      new_blocks:insert(pandoc.RawBlock("html", make_table(completed)))
    else
      new_blocks:insert(block)
    end
  end

  doc.blocks = new_blocks
  return doc
end
