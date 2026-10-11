"""Compare public page render output before and after JSON/Python migration."""
from __future__ import annotations
import difflib
import re
import sys
from pathlib import Path
from html.parser import HTMLParser

PAGES = ("index.html", "about.html", "research.html", "projects.html", "members.html", "publications.html")

class Visible(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.in_main = False
        self.ignored = 0
        self.text = []
        self.img = []
        self.links = []
        self.cards = {"member-card":0, "project-table":0, "csl-entry":0}
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "main":
            self.in_main = True
        if not self.in_main: return
        if tag in ("script","style"):
            self.ignored += 1
        if self.ignored: return
        if tag == "img": self.img.append(a.get("src", ""))
        if tag == "a": self.links.append(a.get("href", ""))
        for cls in a.get("class","").split():
            if cls in self.cards: self.cards[cls] += 1
    def handle_endtag(self, tag):
        if not self.in_main: return
        if tag in ("script","style") and self.ignored:
            self.ignored -= 1
        if tag == "main": self.in_main = False
    def handle_data(self, data):
        if self.in_main and not self.ignored:
            s = re.sub(r"\s+", " ", data).strip()
            if s: self.text.append(s)

def snapshot(path):
    p = Visible()
    p.feed(path.read_text(encoding="utf-8"))
    return p

def main(before, after):
    failed = False
    for page in PAGES:
        a, b = before/page, after/page
        if not (a.is_file() and b.is_file()):
            print(f"FAIL missing {page}")
            failed = True
            continue
        old, new = snapshot(a), snapshot(b)
        differences = [field for field in ("text","img","links","cards") if getattr(old,field) != getattr(new,field)]
        if differences:
            print(f"DIFFERENT {page}: {', '.join(differences)}")
            for line in list(difflib.unified_diff(old.text, new.text, fromfile="before", tofile="after", lineterm=""))[:80]:
                print(line)
            print("Elements:", old.cards, new.cards)
            failed = True
        else:
            print(f"PASS {page}")
    return 1 if failed else 0

if __name__ == "__main__":
    if len(sys.argv)!=3: raise SystemExit("Usage: check_migration_parity.py BEFORE/_site AFTER/_site")
    raise SystemExit(main(Path(sys.argv[1]),Path(sys.argv[2])))
