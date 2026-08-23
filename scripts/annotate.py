"""
WBA — list or annotate the editable copy on a page.

    python scripts/annotate.py list  index.html
    python scripts/annotate.py apply index.html

`list` prints every candidate element with the key it would be given.
`apply` writes the data-edit attributes into the file.

Why a script rather than hand-editing: the keys have to be stable and unique,
and every heading and paragraph on six pages is too many to get right by hand.
Elements inside a generator region (<!-- WBA:...:START -->) are skipped -- the
build rewrites those, so an override there would be wiped on the next run.
SVG subtrees are skipped too, because <path> is not copy.
"""

import io
import re
import sys
from html.parser import HTMLParser

# Elements whose text a person would want to change.
TARGETS = {"h1", "h2", "h3", "h4", "p", "li", "blockquote"}
SKIP_SUBTREES = {"svg", "script", "style", "noscript", "head"}

# Classes the rich sanitiser is allowed to keep. Must match ALLOWED_CLASS in
# js/edit.js and scripts/lib/page-content.mjs -- a child carrying only these
# is safe to edit, because editing will not flatten it.
SAFE_CLASSES = {"accent"}

# The nav and footer are copied into every page, so an override keyed to one
# page would only fix that page. Anything inside them is stored against the
# page "*" and applied everywhere by the build.
#
# Deliberately NOT <header>: this site uses <header class="page-hero"> for the
# top of each page, which is the most page-specific copy there is.
SHARED_ROOTS = {"footer", "nav"}

# Sections that carry their own key prefix, matched on the element's class.
SECTION_HINTS = [
    ("hero", "hero"),
    ("intro", "intro"),
    ("pillar", "pillar"),
    ("offer", "offer"),
    ("form", "form"),
    ("contact", "contact"),
    ("footer", "footer"),
    ("faq", "faq"),
    ("steps", "steps"),
    ("icon-step", "step"),
    ("checks", "checks"),
    ("cta", "cta"),
]


class Scan(HTMLParser):
    def __init__(self, src, blocked):
        super().__init__(convert_charrefs=False)
        self.src = src
        self.blocked = blocked
        self.lines = src.split("\n")
        self.depth_skip = 0
        self.stack = []
        self.found = []          # (offset, tag, text, section)
        self.locked_out = []     # candidates skipped for carrying styled children
        self.shared_depth = 0    # inside <header>/<footer>/<nav>?
        self._open = None

    def src_offset(self):
        line, col = self.getpos()
        return sum(len(l) + 1 for l in self.lines[: line - 1]) + col

    def in_blocked(self, off):
        return any(a <= off <= b for a, b in self.blocked)

    def handle_starttag(self, tag, attrs):
        off = self.src_offset()
        if self.depth_skip:
            if tag in SKIP_SUBTREES:
                self.depth_skip += 1
            return
        if tag in SKIP_SUBTREES:
            self.depth_skip = 1
            return

        cls = dict(attrs).get("class", "") or ""
        section = None
        for needle, name in SECTION_HINTS:
            if needle in cls:
                section = name
                break
        if tag in SHARED_ROOTS:
            self.shared_depth += 1
        self.stack.append((tag, section))

        if self._open:
            # A child element inside a candidate: the copy carries markup, so
            # it has to be edited as rich or the <em>/<strong> is lost on save.
            self._open["has_markup"] = True

            # ...but the rich sanitiser strips every attribute except a safe
            # href. A child carrying a class is styled — a .btn, an .accent, an
            # icon — and editing its parent would quietly flatten it. Those
            # elements are layout, not copy, so they don't become editable.
            child_attrs = dict(attrs)
            child_cls = set((child_attrs.get("class") or "").split())
            if (child_cls - SAFE_CLASSES) or tag in ("button", "img", "input", "label"):
                self._open["locked"] = True

        if tag in TARGETS and not self.in_blocked(off) and not self._open:
            has_edit = "data-edit" in dict(attrs)
            self._open = {"off": off, "tag": tag, "start": off, "cls": cls,
                          "has_edit": has_edit, "text": [], "has_markup": False,
                          "locked": False, "shared": self.shared_depth > 0}

    def handle_endtag(self, tag):
        if self.depth_skip:
            if tag in SKIP_SUBTREES:
                self.depth_skip -= 1
            return
        if tag in SHARED_ROOTS and self.shared_depth:
            self.shared_depth -= 1
        if self.stack and self.stack[-1][0] == tag:
            self.stack.pop()
        if self._open and self._open["tag"] == tag:
            txt = re.sub(r"\s+", " ", "".join(self._open["text"])).strip()
            if txt and not self._open["locked"]:
                sect = next((s for t, s in reversed(self.stack) if s), None)
                self.found.append({
                    "off": self._open["start"],
                    "tag": tag,
                    "text": txt,
                    "section": sect,
                    "cls": self._open["cls"],
                    "has_edit": self._open["has_edit"],
                    "has_markup": self._open["has_markup"],
                    "shared": self._open["shared"],
                })
            elif txt:
                self.locked_out.append((tag, txt[:52]))
            self._open = None

    def handle_data(self, data):
        if self._open:
            self._open["text"].append(data)

    def handle_entityref(self, name):
        if self._open:
            self._open["text"].append("&" + name + ";")

    def handle_charref(self, name):
        if self._open:
            self._open["text"].append("&#" + name + ";")


def blocked_regions(src):
    return [
        (m.start(), m.end())
        for m in re.finditer(
            r"<!-- WBA:[A-Z:]+:START -->.*?<!-- WBA:[A-Z:]+:END -->", src, re.S
        )
    ]


def slugify(text, words=4):
    bits = re.sub(r"[^a-z0-9\s]", "", text.lower()).split()
    return "-".join(bits[:words]) or "text"


def build_keys(items):
    """A key that reads like the thing it points at, and stays unique."""
    used = {}
    for it in items:
        prefix = it["section"] or "page"
        if "eyebrow" in it["cls"]:
            base = f"{prefix}.eyebrow"
        elif it["tag"] in ("h1", "h2", "h3", "h4"):
            base = f"{prefix}.{it['tag']}"
        elif "lede" in it["cls"]:
            base = f"{prefix}.lede"
        elif it["tag"] == "li":
            base = f"{prefix}.item"
        else:
            base = f"{prefix}.body"

        n = used.get(base, 0) + 1
        used[base] = n
        # "pillar.h3-2", not "pillar.h32" — the latter reads as a tag name.
        it["key"] = base if n == 1 else f"{base}-{n}"

        # Rich only where it earns it: the copy already carries inline markup,
        # or it is prose someone may want to bold a word in. A plain heading
        # stays text, so editing it cannot introduce markup at all.
        it["kind"] = "rich" if (it["has_markup"] or it["tag"] in ("p", "li", "blockquote")) else "text"
    return items


def scan(path):
    src = io.open(path, encoding="utf-8").read()
    p = Scan(src, blocked_regions(src))
    p.feed(src)
    return src, build_keys(p.found), p.locked_out


def cmd_list(path):
    _, items, locked = scan(path)
    for it in items:
        mark = "  " if not it["has_edit"] else "* "
        scope = "shared" if it["shared"] else "      "
        print(f'{mark}{it["key"]:30} {it["kind"]:5} {scope} {it["text"][:50]}')
    print(f"\n{len(items)} editable element(s) in {path}")
    if locked:
        print(f"\n{len(locked)} left alone (styled children — layout, not copy):")
        for tag, txt in locked:
            print(f"    <{tag}> {txt}")


def cmd_apply(path):
    src, items, _ = scan(path)
    added = fixed = 0

    # Work backwards so earlier offsets stay valid as we insert.
    for it in sorted(items, key=lambda x: -x["off"]):
        insert_at = it["off"] + 1 + len(it["tag"])

        if it["has_edit"]:
            # Already annotated. The one thing still worth repairing is a
            # missing scope: without it, edit mode would save a footer change
            # against this page only, and the same typo would survive on the
            # other five.
            if not it["shared"]:
                continue
            open_tag_end = src.index(">", it["off"])
            if 'data-edit-scope=' in src[it["off"]:open_tag_end]:
                continue
            src = src[:insert_at] + ' data-edit-scope="shared"' + src[insert_at:]
            fixed += 1
            continue

        attr = f' data-edit="{it["key"]}"'
        if it["kind"] == "rich":
            attr += ' data-edit-kind="rich"'
        if it["shared"]:
            attr += ' data-edit-scope="shared"'
        src = src[:insert_at] + attr + src[insert_at:]
        added += 1

    io.open(path, "w", encoding="utf-8", newline="").write(src)
    note = f"{path}: added {added}"
    if fixed:
        note += f", repaired scope on {fixed}"
    print(note)


if __name__ == "__main__":
    mode, target = sys.argv[1], sys.argv[2]
    (cmd_list if mode == "list" else cmd_apply)(target)
