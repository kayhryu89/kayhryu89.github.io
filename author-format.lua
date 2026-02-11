-- author-format.lua
-- Reads journal.bib and injects authorship/DOI/order/author data as JSON
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
          -- Add last (or only) author
          local last = remaining:match("^%s*(.-)%s*$")
          if last and last ~= "" then
            table.insert(author_list, last)
          end
        end

        -- Convert "Family, Given" to "Given Family" for each author
        local formatted_authors = {}
        for _, a in ipairs(author_list) do
          local family, given = a:match("^([^,]+),%s*(.+)$")
          if family and given then
            table.insert(formatted_authors, given .. " " .. family)
          else
            table.insert(formatted_authors, a)
          end
        end
        local authors_str = table.concat(formatted_authors, ", ")
        -- Escape for JSON
        authors_str = authors_str:gsub('\\', '\\\\'):gsub('"', '\\"')

        local entry_data = '    "' .. key .. '": {'
        entry_data = entry_data .. '"order":' .. order
        if authorship then
          entry_data = entry_data .. ',"authorship":"' .. authorship .. '"'
        end
        if doi then
          entry_data = entry_data .. ',"doi":"' .. doi:gsub('"', '\\"') .. '"'
        end
        entry_data = entry_data .. ',"authors":"' .. authors_str .. '"'
        entry_data = entry_data .. '}'
        table.insert(entries, entry_data)
      end
    end
  end

  if #entries > 0 then
    local json = '<script id="bib-data" type="application/json">\n{\n'
    json = json .. table.concat(entries, ",\n")
    json = json .. '\n}\n</script>'
    table.insert(doc.blocks, 1, pandoc.RawBlock("html", json))
  end

  return doc
end
