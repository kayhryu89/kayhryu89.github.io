"""Check mobile hero layout and contrast in a rendered Quarto site using Chromium."""
from __future__ import annotations
from pathlib import Path
from playwright.sync_api import sync_playwright

SITE = Path(__file__).resolve().parent.parent / "_site" / "index.html"
SCREENSHOTS = Path(__file__).resolve().parent.parent / "_site" / "_screenshots"

def verify() -> None:
    if not SITE.is_file():
        raise RuntimeError(f"Quarto did not create {SITE}")
    SCREENSHOTS.mkdir(exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for theme in ("light", "dark"):
            for width in (320, 375, 430):
                page = browser.new_page(viewport={"width":width, "height":900}, color_scheme=theme, device_scale_factor=1)
                page.goto(SITE.as_uri(), wait_until="load")
                buttons = page.locator(".laser-hero-actions a.btn")
                assert buttons.count() == 3, f"Expected three CTA buttons: {theme}, {width}px"
                assert [buttons.nth(i).inner_text().strip() for i in range(3)] == ["About", "Research", "Join Us"]
                hrefs = [buttons.nth(i).get_attribute("href") or "" for i in range(3)]
                targets = [href.split("#", 1)[0] for href in hrefs]
                assert targets[0].endswith("about.html") and targets[1].endswith("research.html") and targets[2].endswith("about.html"), f"Unexpected hero destinations: {hrefs}"
                assert hrefs[2].endswith("#joining-laser"), f"Join Us lost its destination: {hrefs}"
                positions = [buttons.nth(i).bounding_box() for i in range(3)]
                assert all(x is not None for x in positions)
                ys = [x["y"] for x in positions]
                assert max(ys)-min(ys) < 3, f"CTA buttons wrapped vertically at {width}px {theme}: {ys}"
                assert all(x["height"] >= 40 for x in positions), f"Tap targets too small: {width}px {theme}"
                assert all(x["width"] >= 64 for x in positions), f"CTA button too narrow: {width}px {theme}"
                assert positions[-1]["x"] + positions[-1]["width"] <= width + 1, "Horizontal overflow"
                assert page.locator(".laser-card").count() == 3, "Research area card count changed"
                assert page.locator(".laser-area-card h3").all_text_contents() == [
                    "Autonomous Design", "Decision Engineering", "Operation, Monitoring & Control"
                ], "Research areas have changed"
                assert all(not title.is_visible() for title in page.locator("header#title-block-header").all()), "Redundant Quarto page title is visible"
                assert page.locator("main .laser-hero h1").count() == 1, "Expected one LASER hero heading"
                assert page.locator("#quick-links").count() == 0, "Redundant Quick Links remains"
                publications = page.locator(".recent-publication-title")
                assert publications.count() == 2, "Expected two recent publications"
                for publication in publications.all():
                    display_title = publication.inner_text().strip()
                    full_title = publication.get_attribute("title")
                    assert len(display_title.removesuffix("…").split()) <= 6, f"Title not limited to 6 words: {display_title}"
                    assert publication.get_attribute("aria-label") == full_title, "Full title missing from accessibility label"
                    assert full_title and len(full_title) >= len(display_title), "Original publication title not retained"
                if width == 375:
                    page.screenshot(path=str(SCREENSHOTS / f"home-{theme}-375.png"), full_page=False)
                print(f"PASS {theme=} {width=} CTA row, card count, tap targets")
                page.close()
        browser.close()

if __name__ == "__main__":
    verify()
