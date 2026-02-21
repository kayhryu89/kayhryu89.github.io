-- author-format.lua
-- Reads journal.bib and student.csv, injects authorship/DOI/order/author/member data as JSON
-- Runs BEFORE citeproc (only injects data, doesn't modify bibliography)

function Pandoc(doc)
  if not doc.meta.bibliography then
    return doc
  end

  local bib_paths = doc.meta.bibliography
  local paths = {}
  if type(bib_paths) == "table" then
    if bib_paths[1] then
      for _, bp in ipairs(bib_paths) do
        table.insert(paths, pandoc.utils.stringify(bp))
      end
    else
      table.insert(paths, pandoc.utils.stringify(bib_paths))
    end
  else
    table.insert(paths, pandoc.utils.stringify(bib_paths))
  end

  -- Read student.csv to build lab member list
  local lab_members = {}
  local csv_f = io.open("./Info/student.csv", "r")
  if not csv_f then csv_f = io.open("Info/student.csv", "r") end
  if csv_f then
    local csv_content = csv_f:read("*all")
    csv_f:close()
    local first_line = true
    for line in csv_content:gmatch("[^\r\n]+") do
      if first_line then
        first_line = false
      else
        local fields = {}
        for field in (line .. ","):gmatch("([^,]*),") do
          table.insert(fields, field)
        end
        if #fields >= 3 then
          local english_name = fields[3]:match("^(.-)%s*%(") or fields[3]
          english_name = english_name:match("^%s*(.-)%s*$")
          local parts = {}
          for word in english_name:gmatch("%S+") do
            table.insert(parts, word)
          end
          if #parts >= 2 then
            local family = parts[#parts]
            local given_parts = {}
            for i = 1, #parts - 1 do
              table.insert(given_parts, parts[i])
            end
            table.insert(lab_members, {
              family = family,
              given = table.concat(given_parts, " ")
            })
          end
        end
      end
    end
  end

  -- Check if a bib author matches a lab member (fuzzy: family + first 3 chars of given)
  local function is_lab_member(family, given)
    for _, m in ipairs(lab_members) do
      if m.family:lower() == family:lower() then
        local g1 = given:lower():sub(1, 3)
        local g2 = m.given:lower():sub(1, 3)
        if g1 == g2 then return true end
      end
    end
    return false
  end

  -- Collect all unique lab member names as they appear in bib (Given Family format)
  local member_names_set = {}
  local member_names_list = {}

  local entries = {}
  local order = 0

  for _, path in ipairs(paths) do
    local f = io.open(path, "r")
    if not f then
      f = io.open("./" .. path, "r")
    end
    if f then
      local content = f:read("*all")
      f:close()

      for entry_type, key, body in content:gmatch("@(%w+){(%w[%w_]*),(.-)%s*\n}") do
        order = order + 1
        local authorship = body:match("authorship%s*=%s*{([^}]+)}")
        local doi = body:match("doi%s*=%s*{([^}]+)}")
        local status = body:match("status%s*=%s*{([^}]+)}")
        local raw_authors = body:match("author%s*=%s*{([^}]+)}")

        -- Parse author names: "Last, First and Last, First" -> list
        local author_list = {}
        if raw_authors then
          local remaining = raw_authors
          local s, e = remaining:find("%s+and%s+")
          while s do
            local author = remaining:sub(1, s - 1):match("^%s*(.-)%s*$")
            table.insert(author_list, author)
            remaining = remaining:sub(e + 1)
            s, e = remaining:find("%s+and%s+")
          end
          local last = remaining:match("^%s*(.-)%s*$")
          if last and last ~= "" then
            table.insert(author_list, last)
          end
        end

        -- Convert "Family, Given" to "Given Family" and detect lab members
        local formatted_authors = {}
        for _, a in ipairs(author_list) do
          local family, given = a:match("^([^,]+),%s*(.+)$")
          if family and given then
            family = family:match("^%s*(.-)%s*$")
            given = given:match("^%s*(.-)%s*$")
            local full_name = given .. " " .. family
            table.insert(formatted_authors, full_name)
            -- Check if this author is a lab member (exclude PI Ryu)
            if family:lower() ~= "ryu" and is_lab_member(family, given) then
              if not member_names_set[full_name] then
                member_names_set[full_name] = true
                table.insert(member_names_list, full_name)
              end
            end
          else
            table.insert(formatted_authors, a)
          end
        end
        local authors_str = table.concat(formatted_authors, ", ")
        authors_str = authors_str:gsub('\\', '\\\\'):gsub('"', '\\"')

        local entry_data = '    "' .. key .. '": {'
        entry_data = entry_data .. '"order":' .. order
        if authorship then
          entry_data = entry_data .. ',"authorship":"' .. authorship .. '"'
        end
        if doi then
          entry_data = entry_data .. ',"doi":"' .. doi:gsub('"', '\\"') .. '"'
        end
        if status then
          entry_data = entry_data .. ',"status":"' .. status:gsub('"', '\\"') .. '"'
        end
        entry_data = entry_data .. ',"authors":"' .. authors_str .. '"'
        entry_data = entry_data .. '}'
        table.insert(entries, entry_data)
      end
    end
  end

  if #entries > 0 then
    -- Build lab members JSON array
    local members_json = {}
    for _, name in ipairs(member_names_list) do
      table.insert(members_json, '"' .. name:gsub('"', '\\"') .. '"')
    end

    local json = '<script id="bib-data" type="application/json">\n{\n'
    json = json .. '    "_labMembers": [' .. table.concat(members_json, ', ') .. '],\n'
    json = json .. table.concat(entries, ",\n")
    json = json .. '\n}\n</script>'
    table.insert(doc.blocks, 1, pandoc.RawBlock("html", json))
  end

  return doc
end
