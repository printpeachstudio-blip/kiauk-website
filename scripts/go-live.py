#!/usr/bin/env python3
"""Switch the donation pages on.

Run from the site folder AFTER the trustees have approved the privacy policy and donation terms,
and AFTER the live Stripe keys are set in Supabase:

    python3 scripts/go-live.py "1 December 2026"

It removes the DRAFT banners and noindex tags, dates the policies, links Donate from the home page,
adds the Winter Bag Appeal section, and adds the new pages to the sitemap. Nothing else changes.
"""
import pathlib, re, sys

if len(sys.argv) != 2:
    sys.exit('Usage: python3 scripts/go-live.py "<approval date, e.g. 1 December 2026>"')
date = sys.argv[1]
root = pathlib.Path(__file__).resolve().parent.parent

def read(n): return (root / n).read_text()
def write(n, s): (root / n).write_text(s)

def swap(s, old, new, label):
    if s.count(old) != 1:
        sys.exit(f"Could not apply '{label}': expected exactly one match, found {s.count(old)}. Has go-live already been run?")
    return s.replace(old, new)

# 1. Policy pages and donate page: public and dated
for name in ("donate.html", "privacy.html", "terms.html"):
    s = read(name)
    s = s.replace('<meta name="robots" content="noindex">\n', "")
    s = re.sub(r'\s*<div class="draft-banner">.*?</div></div>', "", s, flags=re.S)
    s = s.replace("[date of approval]", date)
    s = re.sub(r"\s*<!-- TRUSTEES:.*?-->", "", s, flags=re.S)
    write(name, s)

# 1b. Header button on every other page: Contact us becomes Donate
for name in ("donate.html", "privacy.html", "terms.html", "thanks.html", "404.html"):
    t = read(name)
    t = swap(t, '<a class="btn btn--accent" href="/#contact">Contact us</a>', '<a class="btn btn--accent" href="/donate.html">Donate</a>', "header button on " + name)
    write(name, t)

# 2. Home page
s = read("index.html")
s = swap(s, '<a class="btn btn--accent" href="#contact">Contact us</a>', '<a class="btn btn--accent" href="/donate.html">Donate</a>', "header button")
s = swap(s, '      <a href="#involved">Get involved</a>\n    </nav>', '      <a href="#involved">Get involved</a>\n      <a href="#contact">Contact</a>\n    </nav>', "nav contact link")
s = swap(s, '<a class="btn btn--accent" href="#how">What we do</a>', '<a class="btn btn--accent" href="/donate.html">Donate</a>', "hero donate")
appeal = '''  <section class="sec sec--purple dark" id="appeal" aria-labelledby="appeal-title">
    <div class="wrap split split--demand">
      <div>
        <h2 id="appeal-title">Winter Bag Appeal 2026</h2>
        <p>When the cold sets in, we want every person who comes to our outreach to leave with a bag of winter essentials: outerwear and waterproofs, thermal layers and toiletries, 19 items in all.</p>
        <p>We have 600 bags to fill. Bags go out in person from mid-December, at our own outreach and through partner outreach programmes in London and Liverpool.</p>
        <p style="margin-top:22px"><a class="btn btn--accent" href="/donate.html">Sponsor a bag</a></p>
      </div>
      <div>
        <p class="lead-stat" style="margin-bottom:8px;color:var(--cyan)">£40</p>
        <p class="lead-label">sponsors one complete winter bag. Gift Aid adds 25p for every £1 if you are a UK taxpayer.</p>
      </div>
    </div>
  </section>

'''
s = swap(s, '  <section class="sec" id="involved"', appeal + '  <section class="sec" id="involved"', "appeal section")
s = swap(s, "<h2>On this page</h2>", "<h2>More</h2>", "footer heading")
s = swap(s, '          <li><a href="#involved">Get involved</a></li>\n        </ul>',
         '          <li><a href="#involved">Get involved</a></li>\n          <li><a href="/donate.html">Donate</a></li>\n          <li><a href="/privacy.html">Privacy policy</a></li>\n          <li><a href="/terms.html">Donation terms</a></li>\n        </ul>', "footer links")
write("index.html", s)

# 3. Sitemap
m = read("sitemap.xml")
m = swap(m, "</urlset>", "  <url>\n    <loc>https://kiauk.org/donate.html</loc>\n  </url>\n  <url>\n    <loc>https://kiauk.org/privacy.html</loc>\n  </url>\n  <url>\n    <loc>https://kiauk.org/terms.html</loc>\n  </url>\n</urlset>", "sitemap")
write("sitemap.xml", m)
print("Done. Check the pages locally, then commit and push.")
