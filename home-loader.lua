-- home-loader.lua
-- Reads journal.bib and student.csv to show 2 recent publications by lab members

function Pandoc(doc)
  -- Read student.csv for lab member names
  local lab_members = {}
  -- PI is always a lab member
  table.insert(lab_members, {family = "Ryu", given = "Kyung Hwan"})

  local csv_f = io.open("./Info/student.csv", "r")
  if not csv_f then
    csv_f = io.open("Info/student.csv", "r")
  end
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
          -- Name format: "Given Family (Korean)" or "Given Middle Family (Korean)"
          local english_name = fields[3]:match("^(.-)%s*%(") or fields[3]
          english_name = english_name:match("^%s*(.-)%s*$")
          -- Extract family (last word) and given (rest)
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
            local given = table.concat(given_parts, " ")
            table.insert(lab_members, {family = family, given = given})
          end
        end
      end
    end
  end

  -- Check if a bib author matches any lab member
  local function is_lab_member(family, given)
    for _, m in ipairs(lab_members) do
      if m.family:lower() == family:lower() then
        -- Match first 3 chars of given name (handles typos like Jiyum vs Jiyun)
        local g1 = given:lower():sub(1, 3)
        local g2 = m.given:lower():sub(1, 3)
        if g1 == g2 then
          return true
        end
      end
    end
    return false
  end

  -- Read journal.bib
  local bib_f = io.open("./Info/Bib/journal.bib", "r")
  if not bib_f then
    bib_f = io.open("Info/Bib/journal.bib", "r")
  end
  if not bib_f then return doc end

  local bib_content = bib_f:read("*all")
  bib_f:close()

  -- Parse bib entries in order and find first 2 with lab member as first author
  local recent_pubs = {}
  for key, body in bib_content:gmatch("@%w+{(%w[%w_]*),(.-)%s*\n}") do
    if #recent_pubs >= 2 then break end

    local title = body:match("title%s*=%s*{([^}]+)}")
    local journal_name = body:match("journal%s*=%s*{([^}]+)}")
    local year = body:match("year%s*=%s*{(%d+)}")
    local raw_authors = body:match("author%s*=%s*{([^}]+)}")
    local doi = body:match("doi%s*=%s*{([^}]+)}")

    if raw_authors then
      -- Get first author (before first " and " or entire string if single author)
      local first_author = raw_authors:match("^(.-)%s+and%s+") or raw_authors:match("^%s*(.-)%s*$")
      first_author = first_author:match("^%s*(.-)%s*$")

      -- Parse first author: "Family, Given"
      local family, given = first_author:match("^([^,]+),%s*(.+)$")
      if family and given then
        family = family:match("^%s*(.-)%s*$")
        given = given:match("^%s*(.-)%s*$")
        if is_lab_member(family, given) then
          -- Clean up LaTeX escapes for HTML
          local clean_journal = (journal_name or ""):gsub("\\&", "&amp;")
          local clean_title = (title or ""):gsub("\\&", "&amp;")
          table.insert(recent_pubs, {
            given = given,
            family = family,
            title = clean_title,
            journal = clean_journal,
            year = year or "",
            doi = doi or ""
          })
        end
      end
    end
  end

  -- Generate HTML for recent publications
  if #recent_pubs > 0 then
    local html = ""
    for _, pub in ipairs(recent_pubs) do
      html = html .. '<p>'
      html = html .. '<strong>' .. pub.given .. ' ' .. pub.family .. '</strong>'
      html = html .. ' - ' .. pub.title .. ', '
      html = html .. '<em>' .. pub.journal .. '</em>, '
      html = html .. pub.year
      if pub.doi ~= "" then
        html = html .. ' <a href="' .. pub.doi .. '" target="_blank">[LINK]</a>'
      end
      html = html .. '</p>\n'
    end

    -- Walk blocks recursively to find and replace #recent-pubs div
    local function walk_blocks(blocks)
      local new = pandoc.List()
      for _, block in ipairs(blocks) do
        if block.t == "Div" and block.identifier == "recent-pubs" then
          new:insert(pandoc.RawBlock("html", html))
        elseif block.t == "Div" then
          block.content = walk_blocks(block.content)
          new:insert(block)
        else
          new:insert(block)
        end
      end
      return new
    end

    doc.blocks = walk_blocks(doc.blocks)
  end

  return doc
end
