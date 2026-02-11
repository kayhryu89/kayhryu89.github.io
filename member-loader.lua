-- member-loader.lua
-- Reads student.csv and generates member sections (graduate students + alumni)

local function text_to_inlines(text)
  local inlines = pandoc.List()
  local first = true
  for word in text:gmatch("%S+") do
    if not first then inlines:insert(pandoc.Space()) end
    inlines:insert(pandoc.Str(word))
    first = false
  end
  return inlines
end

function Pandoc(doc)
  local csv_path = "./Info/student.csv"
  local f = io.open(csv_path, "r")
  if not f then
    f = io.open("Info/student.csv", "r")
  end
  if not f then return doc end

  local content = f:read("*all")
  f:close()

  -- Parse CSV
  local students = {}
  local first_line = true
  for line in content:gmatch("[^\r\n]+") do
    if first_line then
      first_line = false
    else
      local fields = {}
      for field in (line .. ","):gmatch("([^,]*),") do
        table.insert(fields, field)
      end
      if #fields >= 7 then
        table.insert(students, {
          index = fields[1] or "",
          status = fields[2] or "",
          name = fields[3] or "",
          research = fields[4] or "",
          email = fields[5] or "",
          phone = fields[6] or "",
          joined = fields[7] or "",
          graduation = fields[8] or "",
          thesis = fields[9] or "",
          position = fields[10] or ""
        })
      end
    end
  end

  -- Find photo for a student by index
  local function find_photo(idx)
    local prefixes = {"./Info/Images/pic" .. idx, "./Info/Images/Pic" .. idx}
    local extensions = {".jpg", ".jpeg", ".png", ".gif", ".webp"}
    for _, prefix in ipairs(prefixes) do
      for _, ext in ipairs(extensions) do
        local pf = io.open(prefix .. ext, "r")
        if pf then
          pf:close()
          return prefix .. ext
        end
      end
    end
    return nil
  end

  -- Categorize students by status
  local postdocs = {}
  local phd_students = {}
  local ms_students = {}
  local alumni = {}

  for _, s in ipairs(students) do
    local status = s.status:lower()
    if status == "graduate" then
      table.insert(alumni, s)
    elseif status == "phd" then
      table.insert(phd_students, s)
    elseif status == "ms" then
      table.insert(ms_students, s)
    elseif status == "post-doc" or status == "postdoc" then
      table.insert(postdocs, s)
    end
  end

  -- Generate a student card HTML
  local function make_card(s)
    local photo = find_photo(s.index)
    local html = '<div class="member-card">\n'
    if photo then
      html = html .. '<div class="member-photo">\n'
      html = html .. '<img src="' .. photo .. '" alt="' .. s.name:gsub('"', '&quot;') .. '">\n'
      html = html .. '</div>\n'
    end
    html = html .. '<div class="member-info">\n'
    html = html .. '<h4>' .. s.name .. '</h4>\n'
    if s.research ~= "" then
      html = html .. '<p><strong>Research Topic</strong>: ' .. s.research .. '</p>\n'
    end
    if s.email ~= "" then
      html = html .. '<p><strong>Email</strong>: ' .. s.email .. '</p>\n'
    end
    if s.joined ~= "" then
      html = html .. '<p><strong>Joined</strong>: ' .. s.joined .. '</p>\n'
    end
    html = html .. '</div>\n</div>\n'
    return html
  end

  -- Generate alumni table HTML
  local function make_alumni_table()
    if #alumni == 0 then return "" end
    local html = '<table class="table">\n<thead><tr>'
    html = html .. '<th>Name</th><th>Graduation</th><th>Thesis Title</th><th>Current Position</th>'
    html = html .. '</tr></thead>\n<tbody>\n'
    for _, s in ipairs(alumni) do
      html = html .. '<tr>'
      html = html .. '<td>' .. s.name .. '</td>'
      html = html .. '<td>' .. s.graduation .. '</td>'
      html = html .. '<td>' .. s.thesis .. '</td>'
      html = html .. '<td>' .. s.position .. '</td>'
      html = html .. '</tr>\n'
    end
    html = html .. '</tbody></table>\n'
    return html
  end

  -- Build replacement blocks for #member-sections
  local function build_section_blocks()
    local blocks = pandoc.List()
    local has_grad = #postdocs > 0 or #phd_students > 0 or #ms_students > 0

    if has_grad then
      blocks:insert(pandoc.Header(2,
        text_to_inlines("Graduate Students"),
        pandoc.Attr("graduate-students")))

      if #postdocs > 0 then
        blocks:insert(pandoc.Header(3, text_to_inlines("Post-Doctoral Researchers")))
        for _, s in ipairs(postdocs) do
          blocks:insert(pandoc.RawBlock("html", make_card(s)))
        end
      end

      if #phd_students > 0 then
        blocks:insert(pandoc.Header(3, text_to_inlines("Ph.D. Students")))
        for _, s in ipairs(phd_students) do
          blocks:insert(pandoc.RawBlock("html", make_card(s)))
        end
      end

      if #ms_students > 0 then
        blocks:insert(pandoc.Header(3, text_to_inlines("M.S. Students")))
        for _, s in ipairs(ms_students) do
          blocks:insert(pandoc.RawBlock("html", make_card(s)))
        end
      end
    end

    if #alumni > 0 then
      blocks:insert(pandoc.HorizontalRule())
      blocks:insert(pandoc.Header(2, text_to_inlines("Alumni"), pandoc.Attr("alumni")))
      blocks:insert(pandoc.Header(3, text_to_inlines("M.S. Graduates")))
      blocks:insert(pandoc.RawBlock("html", make_alumni_table()))
    end

    return blocks
  end

  -- Replace #member-sections div
  local new_blocks = pandoc.List()
  for _, block in ipairs(doc.blocks) do
    if block.t == "Div" and block.identifier == "member-sections" then
      local section_blocks = build_section_blocks()
      for _, sb in ipairs(section_blocks) do
        new_blocks:insert(sb)
      end
    else
      new_blocks:insert(block)
    end
  end

  doc.blocks = new_blocks
  return doc
end
