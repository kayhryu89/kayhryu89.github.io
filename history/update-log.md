# LASER Website Update Log

## Update 2026-02-11 (Session 2)

### User Request
1. Fix publication page: remove `href=" data-original-href="` artifacts before [LINK]
2. Fix paper [27] (kim2025piecewise) - authors showing as "---." instead of actual names
3. Members page: 1-column layout with photo (left) + info (right), load photos from ./Info/Images/picXXX
4. Members page: Load from student.csv, categorize by Status (Graduate->Alumni, MS/PhD->Grad Students, Post-Doc), hide empty sections
5. Home page: Auto-load 2 recent publications from journal.bib where first author is lab member
6. Add Board/News page tab
7. Create history folder for tracking updates

### Changes Made

#### Bug Fixes
- **author-format.lua**: Fixed author parsing regex. The old regex `([^a][^n][^d]-)` was fundamentally broken for splitting author lists on " and ". Replaced with proper `find()` + `sub()` loop that correctly handles all author names.
- **publications.qmd** (JavaScript):
  - Fixed em-dash detection: Added `\s*` to handle leading whitespace in innerHTML (`/^\s*---\./`)
  - Added `replacedEmDash` flag to skip first-author format conversion on em-dash-replaced entries (prevents "Jiyun Kim" from being incorrectly rearranged)
  - Fixed DOI cleanup: Changed regex order to first remove the full `https://doi.org/<a href="...">text</a>` pattern before cleaning standalone URLs. This fixes the `href=" data-original-href="` artifact caused by partial regex matching.

#### New Features
- **member-loader.lua**: Lua filter reads student.csv and generates member sections:
  - Categorizes by Status: Graduate->Alumni, MS->M.S. Students, PhD->Ph.D. Students, Post-Doc->Post-Doctoral
  - Empty sections are automatically hidden (no Post-Doc or PhD sections shown if no members)
  - Student photos loaded by index from ./Info/Images/ with auto-extension detection
  - Generates proper Pandoc Header elements for TOC support
- **members.qmd**: Redesigned. PI section stays hardcoded. Graduate students + alumni generated from CSV via member-loader.lua filter. 1-column layout with photo left, info right.
- **home-loader.lua**: Lua filter for index page:
  - Reads student.csv to build lab member name list (PI + all students/alumni)
  - Reads journal.bib entries in order
  - Finds first 2 papers where first author matches a lab member (fuzzy 3-char given name matching)
  - Generates formatted output: **Given Family** - Title, *Journal*, Year [LINK]
- **index.qmd**: Recent Publications section now auto-loads from journal.bib via home-loader.lua
- **board.qmd**: New Board/News page using Quarto listing feature. Posts in board/ directory.
- **board/welcome.qmd**: Sample welcome post.
- **_quarto.yml**: Added Board tab to navigation navbar.
- **styles.css**: Added member card styles (.member-card, .member-photo, .member-info).

### Architecture Overview
- **Lua filters** (run at build time during `quarto render`):
  - `author-format.lua` - Parses journal.bib, injects JSON data as `<script>` for publications page JS
  - `project-loader.lua` - Parses projects.bib, generates project tables
  - `member-loader.lua` - Parses student.csv, generates member cards and alumni table
  - `home-loader.lua` - Parses journal.bib + student.csv, generates recent publications
- **JavaScript** (runs in browser on publications page):
  - Post-processes citeproc output: sorts by year, adds index numbers, fixes em-dash authors, converts first author format, bolds PI name with authorship markers, cleans DOI and adds [LINK]
- **CSS** (`styles.css`): Custom styles for all page components
- **Data files**:
  - `Info/Bib/journal.bib` - 32 journal publications with authorship/DOI fields
  - `Info/Bib/projects.bib` - 17 projects (ongoing/completed)
  - `Info/student.csv` - Student data (Index, Status, Name, Research, Email, Phone, Joined, Graduation, Thesis, Position)
  - `Info/Images/` - Photos (Pic000.jpg for PI, pic002.jpg, pic003.jpg for students)

### Current State
- **Home**: Hero section + 3 cards (Research Focus, Recent Publications auto-loaded, Quick Links)
- **About**: Lab intro, contact info (W3-305, 061-750-3588), Join section
- **Research**: Research areas
- **Projects**: Tables from projects.bib (5 ongoing, 12 completed)
- **Publications**: Year-grouped, indexed, bold PI name with markers, DOI [LINK]
- **People**: PI + Education/Experience, Graduate Students from CSV with photos, Alumni table from CSV
- **Board**: Quarto listing page for news/updates

---

## Update 2026-02-11 (Session 1)

### User Request (Initial Setup)
- Publication page: Year-based grouping, index numbers, bold PI name, authorship markers
- Member page: PI info, education, professional experience
- Projects: Separate tab with bib-based data
- Name changes: "LASER Lab" -> "LASER", "Advanced" -> "Autonomous"
- About: Office W3-305, Phone 061-750-3588
- Various formatting and content updates

### Changes Made
- Created full site structure with Quarto
- Set up publication page with JavaScript post-processing for citeproc output
- Created author-format.lua for bib data injection
- Created project-loader.lua for projects.bib parsing
- Created projects.bib with 17 projects
- Updated all pages with lab information
- Added custom CSS styles
